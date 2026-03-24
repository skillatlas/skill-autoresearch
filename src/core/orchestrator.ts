import fs from "fs-extra";
import path from "node:path";

import { ContainerRunner } from "./container-runner.js";
import { getGenerationArtifactSubdir } from "./generation.js";
import { HumanReviewService } from "./human-scoring.js";
import { Logger } from "./logger.js";
import {
  ScoringService,
  selectBestWinningCandidate,
  summarizeVotes
} from "./scorer.js";
import { StateStore } from "./state-store.js";
import { WorkspaceManager } from "./workspace.js";
import {
  GenerationProvider,
  GenerationSpec
} from "../types/generation.js";
import { ScoreVote } from "../types/rubric.js";
import { RunState } from "../types/state.js";

export interface RunOptions {
  workspaceRoot: string;
  scoringMode: RunState["scoringMode"];
  candidateCount: number;
  voteCount: number;
  minSteps: number;
  maxSteps?: number;
  stasisSteps?: number;
  resume: boolean;
  providerOverride?: GenerationProvider;
  modelOverride?: string;
  omitSkillDiff: boolean;
  dryRun: boolean;
}

function createRunId(now: Date): string {
  return now
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");
}

function normalizeMaxSteps(maxSteps: number | undefined): number | undefined {
  if (maxSteps == null || maxSteps === 0) {
    return undefined;
  }

  return maxSteps;
}

function describeMaxSteps(maxSteps: number | undefined): string {
  const normalizedMaxSteps = normalizeMaxSteps(maxSteps);
  return normalizedMaxSteps == null ? "unlimited" : `up to ${normalizedMaxSteps}`;
}

function createInitialState(
  workspace: WorkspaceManager,
  runId: string,
  archivePath: string,
  options: RunOptions
): RunState {
  return {
    version: 1,
    runId,
    workspaceRoot: workspace.root,
    scoringMode: options.scoringMode,
    status: "running",
    stepIndex: 0,
    candidateCount: options.candidateCount,
    voteCount: options.voteCount,
    minSteps: options.minSteps,
    maxSteps: normalizeMaxSteps(options.maxSteps),
    stasisSteps: options.stasisSteps,
    consecutiveRejections: 0,
    archivePath,
    skillsOriginalPath: workspace.relativeToRoot(workspace.paths.skillsOriginalDir),
    skillsPreviousPath: workspace.relativeToRoot(workspace.paths.skillsPreviousDir),
    incumbentPath: undefined,
    providerOverride: options.providerOverride ?? null,
    modelOverride: options.modelOverride ?? null,
    omitSkillDiff: options.omitSkillDiff,
    currentPhase: "generate-baseline",
    activeCandidates: [],
    history: []
  };
}

function completedIterations(state: RunState): number {
  return state.history.length;
}

function formatCandidateGenerationLabel(
  stepIndex: number,
  candidateIndex: number
): string {
  return `Candidate ${candidateIndex} generation for step ${stepIndex}`;
}

function appendGenerationLabel(
  label: string,
  generation: GenerationSpec,
  generationCount: number
): string {
  return generationCount === 1 ? label : `${label} (${generation.fileName})`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export class Orchestrator {
  private pendingStateSave: Promise<void> = Promise.resolve();

  public constructor(
    private readonly workspace: WorkspaceManager,
    private readonly stateStore: StateStore,
    private readonly containerRunner: ContainerRunner,
    private readonly scorer: ScoringService,
    private readonly humanReview: HumanReviewService,
    private readonly logger: Logger,
    private readonly options: RunOptions,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async run(): Promise<RunState | undefined> {
    await this.workspace.validateSourceInputs({
      scoringMode: this.options.scoringMode
    });
    await this.workspace.prepareRuntimeDirs();

    if (this.options.dryRun) {
      await this.runDryRun();
      return undefined;
    }

    let state: RunState | undefined;
    let monitorStarted = false;

    try {
      state = await this.initializeState();

      if (state.status !== "completed") {
        await this.humanReview.startRun(state);
        this.humanReview.syncState(state);
        monitorStarted = true;
      }

      if (state.status === "completed") {
        this.logger.info(`Run ${state.runId} is already completed.`);
        return state;
      }

      while (true) {
        const stopReason = this.getStopReason(state);
        if (stopReason) {
          state.status = "completed";
          state.completedReason = stopReason;
          await this.saveState(state);
          this.logger.phase(`Completed run ${state.runId} (${stopReason})`);
          return state;
        }

        switch (state.currentPhase) {
          case "generate-baseline":
            state = await this.generateBaseline(state);
            break;
          case "snapshot":
            state = await this.snapshotSkills(state);
            break;
          case "mutate-skills":
            state = await this.mutateSkills(state);
            break;
          case "generate-candidates":
            state = await this.generateCandidates(state);
            break;
          case "score":
            state = await this.scoreCandidates(state);
            break;
          case "promote":
            state = await this.promoteOrRevert(state);
            break;
          default:
            throw new Error(`Unsupported run phase: ${String(state.currentPhase)}`);
        }
      }
    } catch (error) {
      if (state) {
        state.status = "failed";
        await this.saveState(state);
      }

      throw error;
    } finally {
      if (monitorStarted) {
        await this.humanReview.close();
      }
    }
  }

  private async initializeState(): Promise<RunState> {
    if (this.options.resume) {
      if (!(await this.stateStore.exists())) {
        throw new Error("Cannot resume: .skill-autoresearch/state.json does not exist.");
      }

      const state = await this.stateStore.load();
      state.maxSteps = normalizeMaxSteps(state.maxSteps);
      if (state.workspaceRoot !== this.workspace.root) {
        throw new Error(
          `Cannot resume: state workspace root ${state.workspaceRoot} does not match ${this.workspace.root}.`
        );
      }

      this.assertResumeOptions(state);
      this.logger.attachLogFile(this.workspace.paths.logsDir, state.runId);
      this.logger.warn(
        `Resuming run ${state.runId} from phase ${state.currentPhase}. If the previous attempt stopped mid-phase, that phase will be rerun.`
      );
      return state;
    }

    const runId = createRunId(this.now());
    this.logger.attachLogFile(this.workspace.paths.logsDir, runId);
    const archivePath = await this.workspace.archiveExistingSteps(runId);
    const state = createInitialState(this.workspace, runId, archivePath, this.options);
    await this.workspace.snapshotSkills("original");
    await this.workspace.snapshotSkills("previous");
    await this.saveState(state);

    return state;
  }

  private async runDryRun(): Promise<void> {
    const previewRunId = createRunId(this.now());
    const archivePath = await this.workspace.archiveExistingSteps(previewRunId, {
      dryRun: true
    });
    const generations = await this.workspace.loadGenerationSpecs({
      providerOverride: this.options.providerOverride
    });
    const providers = [...new Set(generations.map((generation) => generation.provider))];

    this.logger.info(`Dry run for workspace ${this.workspace.root}`);
    this.logger.info(`Run ID: ${previewRunId}`);
    this.logger.info(`Archive target: ${archivePath}`);
    this.logger.info(
      `Generation prompts: ${generations.map((generation) => generation.fileName).join(", ")}`
    );
    this.logger.info(`Generation providers: ${providers.join(", ")}`);
    this.logger.info(
      `Planned loop: baseline + ${describeMaxSteps(this.options.maxSteps)} mutation step(s), ${this.options.candidateCount} candidate(s) per generation prompt, ${this.options.voteCount} vote(s) per candidate comparison.`
    );

    if (this.options.scoringMode === "human") {
      this.logger.info("Human scorer: local review server on localhost");
      return;
    }

    const rubric = await this.scorer.loadRubric(this.workspace.paths.rubricPath, {
      providerOverride: this.options.providerOverride
    });
    const modelLabel =
      this.options.modelOverride ?? rubric.modelId ?? "<provider default>";
    this.logger.info(
      `Rubric scorer: ${rubric.provider}/${modelLabel} (${[
        ...new Set(rubric.commands.map((command) => command.outputType))
      ].join("+")})`
    );
    this.logger.info(
      `Skill diff evidence: ${this.options.omitSkillDiff ? "disabled" : "enabled"}`
    );
  }

  private async generateBaseline(state: RunState): Promise<RunState> {
    const baselineDir = path.join(this.workspace.paths.stepsDir, "0", "baseline");
    const generations = await this.workspace.loadGenerationSpecs({
      providerOverride: this.options.providerOverride
    });
    await this.generateArtifactsForPromptSet({
      targetRoot: baselineDir,
      generations,
      baseLabel: "Baseline generation"
    });

    await this.workspace.snapshotSkills("original");
    state.incumbentPath = this.workspace.relativeToRoot(baselineDir);
    state.stepIndex = 1;
    state.status = "running";
    state.currentPhase = "snapshot";
    await this.saveState(state);
    this.logger.info(`Baseline ready at ${state.incumbentPath}`);

    return state;
  }

  private async snapshotSkills(state: RunState): Promise<RunState> {
    await this.workspace.snapshotSkills("previous");
    state.activeCandidates = [];
    state.status = "running";
    state.currentPhase = "mutate-skills";
    await this.saveState(state);
    this.logger.info(
      `Snapshot saved to ${this.workspace.relativeToRoot(this.workspace.paths.skillsPreviousDir)}`
    );

    return state;
  }

  private async mutateSkills(state: RunState): Promise<RunState> {
    await this.workspace.restoreSkillsFromPrevious();
    const sandbox = await this.workspace.createMutationSandbox(state.stepIndex);
    const instructions = await this.workspace.loadInstructionsSpec({
      providerOverride: this.options.providerOverride
    });

    try {
      await this.containerRunner.runPrompt({
        containerRoot: sandbox.containerRoot,
        targetPath: sandbox.targetPath,
        prompt: instructions.prompt,
        label: `Skill mutation for step ${state.stepIndex}`,
        provider: instructions.provider,
        modelId: instructions.modelId
      });
      await sandbox.applyChanges();
    } finally {
      await sandbox.cleanup();
    }

    state.activeCandidates = Array.from({ length: state.candidateCount }, (_, index) => {
      const candidateDir = path.join(
        this.workspace.paths.stepsDir,
        String(state.stepIndex),
        "candidates",
        String(index)
      );

      return {
        index,
        path: this.workspace.relativeToRoot(candidateDir),
        status: "pending" as const,
        votes: []
      };
    });
    state.status = "running";
    state.currentPhase = "generate-candidates";
    await this.saveState(state);

    return state;
  }

  private async generateCandidates(state: RunState): Promise<RunState> {
    const generations = await this.workspace.loadGenerationSpecs({
      providerOverride: this.options.providerOverride
    });
    const pendingCandidates = state.activeCandidates.filter(
      (candidate) => candidate.status === "pending"
    );

    await this.runInParallel(pendingCandidates, async (candidate) => {
      const candidateDir = this.workspace.resolveWorkspacePath(candidate.path);
      await this.generateArtifactsForPromptSet({
        targetRoot: candidateDir,
        generations,
        baseLabel: formatCandidateGenerationLabel(state.stepIndex, candidate.index)
      });
      candidate.status = "generated";
      await this.saveState(state);
      this.logger.info(`Generated candidate ${candidate.index} at ${candidate.path}`);
    });

    state.status = "awaiting-score";
    state.currentPhase = "score";
    await this.saveState(state);

    return state;
  }

  private async scoreCandidates(state: RunState): Promise<RunState> {
    if (!state.incumbentPath) {
      throw new Error("Cannot score candidates before an incumbent artifact exists.");
    }

    const generations = await this.workspace.loadGenerationSpecs({
      providerOverride: this.options.providerOverride
    });
    const requiredVoteCount = this.getRequiredVoteCount(generations);
    const incumbentPath = state.incumbentPath;

    if (state.scoringMode === "human") {
      return this.scoreCandidatesWithHumanReview(state, generations);
    }

    const rubric = await this.scorer.loadRubric(this.workspace.paths.rubricPath, {
      providerOverride: this.options.providerOverride
    });
    const modelId = state.modelOverride ?? rubric.modelId;
    const pendingCandidates = state.activeCandidates.filter(
      (candidate) =>
        !(
          candidate.status === "scored" &&
          candidate.votes.length >= requiredVoteCount &&
          candidate.comparison
        )
    );

    await this.runInParallel(pendingCandidates, async (candidate) => {
      for (let generationIndex = 0; generationIndex < generations.length; generationIndex += 1) {
        const generation = generations[generationIndex]!;
        const completedVotes = this.getCompletedVotesForGeneration(
          candidate.votes.length,
          generationIndex
        );
        if (completedVotes >= state.voteCount) {
          continue;
        }

        const incumbentEvidence = await this.scorer.collectEvidence(
          rubric,
          this.resolveGenerationArtifactPath(
            incumbentPath,
            generation,
            generations.length
          )
        );
        const candidateEvidence = await this.scorer.collectEvidence(
          rubric,
          this.resolveGenerationArtifactPath(candidate.path, generation, generations.length)
        );
        const comparisonEvidence = state.omitSkillDiff
          ? []
          : await this.scorer.collectSkillDiffEvidence(
              this.resolveGenerationArtifactPath(
                incumbentPath,
                generation,
                generations.length
              ),
              this.resolveGenerationArtifactPath(
                candidate.path,
                generation,
                generations.length
              )
            );

        for (let attempt = completedVotes; attempt < state.voteCount; attempt += 1) {
          const vote = await this.scorer.runSingleVote({
            provider: rubric.provider,
            modelId,
            rubricPrompt: rubric.prompt,
            incumbentEvidence,
            candidateEvidence,
            comparisonEvidence
          });

          candidate.votes.push({
            attempt: candidate.votes.length,
            winner: vote.winner,
            confidence: vote.confidence,
            rationale: vote.rationale
          });
          candidate.comparison = summarizeVotes(candidate.votes);
          await this.saveState(state);
        }
      }

      candidate.comparison = summarizeVotes(candidate.votes);
      candidate.status = "scored";
      await this.saveState(state);
      this.logger.info(
        `Candidate ${candidate.index} scored ${candidate.comparison.bVotes}/${requiredVoteCount} vote(s) for B.`
      );
    });

    state.status = "running";
    state.currentPhase = "promote";
    await this.saveState(state);

    return state;
  }

  private async scoreCandidatesWithHumanReview(
    state: RunState,
    generations: GenerationSpec[]
  ): Promise<RunState> {
    if (!state.incumbentPath) {
      throw new Error("Cannot score candidates before an incumbent artifact exists.");
    }

    const requiredVoteCount = this.getRequiredVoteCount(generations);
    for (let generationIndex = 0; generationIndex < generations.length; generationIndex += 1) {
      const generation = generations[generationIndex]!;
      const pendingCandidates = state.activeCandidates.filter(
        (candidate) =>
          !(
            candidate.status === "scored" &&
            candidate.votes.length >= requiredVoteCount &&
            candidate.comparison
          ) &&
          this.getCompletedVotesForGeneration(candidate.votes.length, generationIndex) <
            state.voteCount
      );

      if (pendingCandidates.length === 0) {
        continue;
      }

      await this.humanReview.reviewCandidates({
        runId: state.runId,
        stepIndex: state.stepIndex,
        voteCount: state.voteCount,
        incumbentPath: this.workspace.resolveWorkspacePath(
          this.resolveGenerationArtifactPath(
            state.incumbentPath,
            generation,
            generations.length
          )
        ),
        candidates: pendingCandidates.map((candidate) => ({
          index: candidate.index,
          path: this.workspace.resolveWorkspacePath(
            this.resolveGenerationArtifactPath(candidate.path, generation, generations.length)
          ),
          completedVotes: this.getCompletedVotesForGeneration(
            candidate.votes.length,
            generationIndex
          )
        })),
        onVote: async ({ candidateIndex, vote }) => {
          const candidate = state.activeCandidates.find(
            (activeCandidate) => activeCandidate.index === candidateIndex
          );

          if (!candidate) {
            throw new Error(`Unable to record human vote for candidate ${candidateIndex}.`);
          }

          this.recordCandidateVote(candidate, vote, requiredVoteCount);
          await this.saveState(state);

          if (candidate.status === "scored" && candidate.comparison) {
            this.logger.info(
              `Candidate ${candidate.index} scored ${candidate.comparison.bVotes}/${requiredVoteCount} vote(s) for B.`
            );
          }
        }
      });
    }

    state.status = "running";
    state.currentPhase = "promote";
    await this.saveState(state);

    return state;
  }

  private async promoteOrRevert(state: RunState): Promise<RunState> {
    const winningCandidates = state.activeCandidates.filter(
      (candidate) => candidate.comparison?.isWinner
    );
    const mutatedSkillWins = winningCandidates.length > state.activeCandidates.length / 2;

    if (mutatedSkillWins) {
      const promotedCandidate = selectBestWinningCandidate(state.activeCandidates);
      if (!promotedCandidate) {
        throw new Error("Expected a promoted candidate but none was available.");
      }

      for (const candidate of state.activeCandidates) {
        candidate.status =
          candidate.index === promotedCandidate.index ? "accepted" : "rejected";
      }

      state.incumbentPath = promotedCandidate.path;
      state.consecutiveRejections = 0;
      state.history.push({
        timestamp: this.now().toISOString(),
        stepIndex: state.stepIndex,
        accepted: true,
        incumbentPath: state.incumbentPath,
        promotedCandidateIndex: promotedCandidate.index,
        promotedCandidatePath: promotedCandidate.path,
        winningCandidateIndexes: winningCandidates.map((candidate) => candidate.index),
        consecutiveRejections: 0,
        candidates: state.activeCandidates.map((candidate) => ({
          index: candidate.index,
          path: candidate.path,
          status: candidate.status,
          votes: candidate.votes,
          comparison: candidate.comparison
        }))
      });
      this.logger.phase(
        `Accepted step ${state.stepIndex}; promoted candidate ${promotedCandidate.index}`
      );
    } else {
      await this.workspace.restoreSkillsFromPrevious();

      for (const candidate of state.activeCandidates) {
        candidate.status = "rejected";
      }

      state.consecutiveRejections += 1;
      state.history.push({
        timestamp: this.now().toISOString(),
        stepIndex: state.stepIndex,
        accepted: false,
        incumbentPath: state.incumbentPath!,
        winningCandidateIndexes: winningCandidates.map((candidate) => candidate.index),
        consecutiveRejections: state.consecutiveRejections,
        candidates: state.activeCandidates.map((candidate) => ({
          index: candidate.index,
          path: candidate.path,
          status: candidate.status,
          votes: candidate.votes,
          comparison: candidate.comparison
        }))
      });
      this.logger.phase(
        `Rejected step ${state.stepIndex}; reverted skills to ${state.skillsPreviousPath}`
      );
    }

    state.activeCandidates = [];
    state.stepIndex += 1;
    state.status = "running";
    state.currentPhase = "snapshot";
    await this.saveState(state);

    return state;
  }

  private async runInParallel<T>(
    items: ReadonlyArray<T>,
    worker: (item: T) => Promise<void>
  ): Promise<void> {
    const results = await Promise.allSettled(items.map((item) => worker(item)));
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );

    if (rejection) {
      throw rejection.reason;
    }
  }

  private async saveState(state: RunState): Promise<void> {
    const snapshot = structuredClone(state);
    const saveOperation = this.pendingStateSave.then(() =>
      this.stateStore.save(snapshot)
    );
    this.pendingStateSave = saveOperation.catch(() => undefined);
    await saveOperation;
    this.humanReview.syncState(snapshot);
  }

  private recordCandidateVote(
    candidate: RunState["activeCandidates"][number],
    vote: ScoreVote,
    voteCount: number
  ): void {
    candidate.votes.push({
      attempt: candidate.votes.length,
      winner: vote.winner,
      confidence: vote.confidence,
      rationale: vote.rationale
    });
    candidate.comparison = summarizeVotes(candidate.votes);

    if (candidate.votes.length >= voteCount) {
      candidate.status = "scored";
    }
  }

  private getStopReason(state: RunState): "max-steps" | "stasis" | undefined {
    if (state.currentPhase === "generate-baseline") {
      return undefined;
    }

    if (state.maxSteps != null && completedIterations(state) >= state.maxSteps) {
      return "max-steps";
    }

    if (
      state.stasisSteps != null &&
      state.stasisSteps > 0 &&
      completedIterations(state) >= state.minSteps &&
      state.consecutiveRejections >= state.stasisSteps
    ) {
      return "stasis";
    }

    return undefined;
  }

  private getRequiredVoteCount(generations: ReadonlyArray<GenerationSpec>): number {
    return generations.length * this.options.voteCount;
  }

  private getCompletedVotesForGeneration(
    voteCount: number,
    generationIndex: number
  ): number {
    const voteStart = generationIndex * this.options.voteCount;
    return Math.max(0, Math.min(this.options.voteCount, voteCount - voteStart));
  }

  private resolveGenerationArtifactPath(
    rootPath: string,
    generation: GenerationSpec,
    generationCount: number
  ): string {
    if (generationCount === 1) {
      return rootPath;
    }

    return path.join(rootPath, getGenerationArtifactSubdir(generation));
  }

  private async generateArtifactsForPromptSet(input: {
    targetRoot: string;
    generations: ReadonlyArray<GenerationSpec>;
    baseLabel: string;
  }): Promise<void> {
    await this.workspace.resetDirectory(input.targetRoot);

    for (const generation of input.generations) {
      const generationTarget =
        input.generations.length === 1
          ? input.targetRoot
          : path.join(input.targetRoot, getGenerationArtifactSubdir(generation));
      const label = appendGenerationLabel(
        input.baseLabel,
        generation,
        input.generations.length
      );
      const sandbox = await this.workspace.createGenerationSandbox(generationTarget);

      try {
        await this.containerRunner.runPrompt({
          containerRoot: sandbox.containerRoot,
          targetPath: sandbox.targetPath,
          prompt: generation.prompt,
          label,
          provider: generation.provider,
          modelId: generation.modelId
        });
        await sandbox.persistArtifacts();
      } finally {
        await sandbox.cleanup();
      }

      await this.workspace.assertDirectoryContainsFiles(generationTarget, label, {
        ignoredTopLevelEntries: ["skills"]
      });
    }

    if (input.generations.length > 1) {
      await this.writeGenerationManifest(input.targetRoot, input.generations);
    }
  }

  private async writeGenerationManifest(
    targetRoot: string,
    generations: ReadonlyArray<GenerationSpec>
  ): Promise<void> {
    const links = generations
      .map((generation) => {
        const subdir = getGenerationArtifactSubdir(generation);
        return `<li><a href="./${encodeURIComponent(subdir)}/">${escapeHtml(generation.fileName)}</a> <span>${escapeHtml(
          generation.modelId
            ? `${generation.provider}/${generation.modelId}`
            : generation.provider
        )}</span></li>`;
      })
      .join("");

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Generation Outputs</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        padding: 32px;
        background: #111114;
        color: #e4e4e7;
      }
      main {
        max-width: 720px;
        margin: 0 auto;
        background: #1a1a1f;
        border: 1px solid #2a2a30;
        border-radius: 18px;
        padding: 24px;
        box-shadow: 0 18px 40px rgba(0, 0, 0, 0.3);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 1.5rem;
      }
      p {
        margin: 0 0 20px;
        line-height: 1.5;
      }
      ul {
        margin: 0;
        padding-left: 20px;
      }
      li + li {
        margin-top: 10px;
      }
      a {
        color: #60a5fa;
      }
      span {
        color: #71717a;
        margin-left: 8px;
        font-size: 0.95rem;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Generation outputs</h1>
      <p>This artifact bundle contains one output per generation prompt.</p>
      <ul>${links}</ul>
    </main>
  </body>
</html>
`;

    await fs.writeFile(path.join(targetRoot, "index.html"), html, "utf8");
  }

  private assertResumeOptions(state: RunState): void {
    const mismatches: string[] = [];
    if (state.candidateCount !== this.options.candidateCount) {
      mismatches.push(`candidates=${state.candidateCount}`);
    }
    if (state.voteCount !== this.options.voteCount) {
      mismatches.push(`votes=${state.voteCount}`);
    }
    if (state.minSteps !== this.options.minSteps) {
      mismatches.push(`min-steps=${state.minSteps}`);
    }
    const expectedMaxSteps = normalizeMaxSteps(state.maxSteps);
    const requestedMaxSteps = normalizeMaxSteps(this.options.maxSteps);
    if (expectedMaxSteps !== requestedMaxSteps) {
      mismatches.push(`max-steps=${expectedMaxSteps ?? "disabled"}`);
    }
    if (state.stasisSteps !== this.options.stasisSteps) {
      mismatches.push(`stasis-steps=${state.stasisSteps}`);
    }
    if ((state.providerOverride ?? undefined) !== this.options.providerOverride) {
      mismatches.push(
        `provider=${state.providerOverride ?? "<frontmatter or inferred default>"}`
      );
    }
    if ((state.modelOverride ?? undefined) !== this.options.modelOverride) {
      mismatches.push(`model=${state.modelOverride ?? "<rubric default>"}`);
    }
    if (state.omitSkillDiff !== this.options.omitSkillDiff) {
      mismatches.push(`omit-skill-diff=${state.omitSkillDiff}`);
    }
    if (state.scoringMode !== this.options.scoringMode) {
      mismatches.push(`scoring-mode=${state.scoringMode}`);
    }

    if (mismatches.length > 0) {
      throw new Error(
        `Resume options must match saved state. Expected ${mismatches.join(", ")}.`
      );
    }
  }
}
