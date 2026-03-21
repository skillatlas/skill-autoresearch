import path from "node:path";

import { ContainerRunner } from "./container-runner.js";
import { Logger } from "./logger.js";
import {
  ScoringService,
  selectBestWinningCandidate,
  summarizeVotes
} from "./scorer.js";
import { StateStore } from "./state-store.js";
import { WorkspaceManager } from "./workspace.js";
import { RunState } from "../types/state.js";

export interface RunOptions {
  workspaceRoot: string;
  candidateCount: number;
  voteCount: number;
  minSteps: number;
  maxSteps: number;
  stasisSteps?: number;
  resume: boolean;
  modelOverride?: string;
  dryRun: boolean;
}

function createRunId(now: Date): string {
  return now
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");
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
    status: "running",
    stepIndex: 0,
    candidateCount: options.candidateCount,
    voteCount: options.voteCount,
    minSteps: options.minSteps,
    maxSteps: options.maxSteps,
    stasisSteps: options.stasisSteps,
    consecutiveRejections: 0,
    archivePath,
    skillsOriginalPath: workspace.relativeToRoot(workspace.paths.skillsOriginalDir),
    skillsPreviousPath: workspace.relativeToRoot(workspace.paths.skillsPreviousDir),
    incumbentPath: undefined,
    modelOverride: options.modelOverride ?? null,
    currentPhase: "generate-baseline",
    activeCandidates: [],
    history: []
  };
}

function completedIterations(state: RunState): number {
  return state.history.length;
}

export class Orchestrator {
  private pendingStateSave: Promise<void> = Promise.resolve();

  public constructor(
    private readonly workspace: WorkspaceManager,
    private readonly stateStore: StateStore,
    private readonly containerRunner: ContainerRunner,
    private readonly scorer: ScoringService,
    private readonly logger: Logger,
    private readonly options: RunOptions,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async run(): Promise<RunState | undefined> {
    await this.workspace.validateSourceInputs();
    await this.workspace.prepareRuntimeDirs();

    if (this.options.dryRun) {
      await this.runDryRun();
      return undefined;
    }

    let state: RunState | undefined;

    try {
      state = await this.initializeState();

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
    }
  }

  private async initializeState(): Promise<RunState> {
    if (this.options.resume) {
      if (!(await this.stateStore.exists())) {
        throw new Error("Cannot resume: .skill-autoresearch/state.json does not exist.");
      }

      const state = await this.stateStore.load();
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
    await this.saveState(state);

    return state;
  }

  private async runDryRun(): Promise<void> {
    const previewRunId = createRunId(this.now());
    const archivePath = await this.workspace.archiveExistingSteps(previewRunId, {
      dryRun: true
    });
    const rubric = await this.scorer.loadRubric(this.workspace.paths.rubricPath);

    this.logger.info(`Dry run for workspace ${this.workspace.root}`);
    this.logger.info(`Run ID: ${previewRunId}`);
    this.logger.info(`Archive target: ${archivePath}`);
    this.logger.info(
      `Planned loop: baseline + up to ${this.options.maxSteps} mutation step(s), ${this.options.candidateCount} candidate(s) per step, ${this.options.voteCount} vote(s) per candidate.`
    );
    this.logger.info(
      `Rubric scorer: ${
        rubric.provider
      }/${this.options.modelOverride ?? rubric.modelId} (${rubric.outputType})`
    );
  }

  private async generateBaseline(state: RunState): Promise<RunState> {
    const baselineDir = path.join(this.workspace.paths.stepsDir, "0", "baseline");
    await this.workspace.resetDirectory(baselineDir);
    const sandbox = await this.workspace.createGenerationSandbox(baselineDir);

    try {
      await this.containerRunner.runPrompt({
        containerRoot: sandbox.containerRoot,
        targetPath: sandbox.targetPath,
        prompt: await this.workspace.readPrompt(this.workspace.paths.generationPath),
        label: "Baseline generation"
      });
    } finally {
      await sandbox.cleanup();
    }
    await this.workspace.assertDirectoryContainsFiles(baselineDir, "Baseline generation", {
      ignoredTopLevelEntries: ["skills"]
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

    try {
      await this.containerRunner.runPrompt({
        containerRoot: sandbox.containerRoot,
        targetPath: sandbox.targetPath,
        prompt: await this.workspace.readPrompt(this.workspace.paths.instructionsPath),
        label: `Skill mutation for step ${state.stepIndex}`
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
    const prompt = await this.workspace.readPrompt(this.workspace.paths.generationPath);
    const pendingCandidates = state.activeCandidates.filter(
      (candidate) => candidate.status === "pending"
    );

    await this.runInParallel(pendingCandidates, async (candidate) => {
      const candidateDir = this.workspace.resolveWorkspacePath(candidate.path);
      await this.workspace.resetDirectory(candidateDir);
      const sandbox = await this.workspace.createGenerationSandbox(candidateDir);

      try {
        await this.containerRunner.runPrompt({
          containerRoot: sandbox.containerRoot,
          targetPath: sandbox.targetPath,
          prompt,
          label: `Candidate generation for step ${state.stepIndex}/${candidate.index}`
        });
      } finally {
        await sandbox.cleanup();
      }
      await this.workspace.assertDirectoryContainsFiles(
        candidateDir,
        `Candidate generation for step ${state.stepIndex}/${candidate.index}`,
        {
          ignoredTopLevelEntries: ["skills"]
        }
      );
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

    const rubric = await this.scorer.loadRubric(this.workspace.paths.rubricPath);
    const modelId = state.modelOverride ?? rubric.modelId;
    const incumbentEvidence = await this.scorer.collectEvidence(
      rubric,
      state.incumbentPath
    );
    const pendingCandidates = state.activeCandidates.filter(
      (candidate) =>
        !(
          candidate.status === "scored" &&
          candidate.votes.length >= state.voteCount &&
          candidate.comparison
        )
    );

    await this.runInParallel(pendingCandidates, async (candidate) => {
      const candidateEvidence = await this.scorer.collectEvidence(rubric, candidate.path);
      for (let attempt = candidate.votes.length; attempt < state.voteCount; attempt += 1) {
        const vote = await this.scorer.runSingleVote({
          provider: rubric.provider,
          modelId,
          rubricPrompt: rubric.prompt,
          incumbentEvidence,
          candidateEvidence
        });

        candidate.votes.push({
          attempt,
          winner: vote.winner,
          confidence: vote.confidence,
          rationale: vote.rationale
        });
        candidate.comparison = summarizeVotes(candidate.votes);
        await this.saveState(state);
      }

      candidate.comparison = summarizeVotes(candidate.votes);
      candidate.status = "scored";
      await this.saveState(state);
      this.logger.info(
        `Candidate ${candidate.index} scored ${candidate.comparison.bVotes}/${state.voteCount} vote(s) for B.`
      );
    });

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
        consecutiveRejections: 0
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
        consecutiveRejections: state.consecutiveRejections
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
    const saveOperation = this.pendingStateSave.then(() =>
      this.stateStore.save(structuredClone(state))
    );
    this.pendingStateSave = saveOperation.catch(() => undefined);
    await saveOperation;
  }

  private getStopReason(state: RunState): "max-steps" | "stasis" | undefined {
    if (state.currentPhase === "generate-baseline") {
      return undefined;
    }

    if (completedIterations(state) >= state.maxSteps) {
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
    if (state.maxSteps !== this.options.maxSteps) {
      mismatches.push(`max-steps=${state.maxSteps}`);
    }
    if (state.stasisSteps !== this.options.stasisSteps) {
      mismatches.push(`stasis-steps=${state.stasisSteps}`);
    }
    if ((state.modelOverride ?? undefined) !== this.options.modelOverride) {
      mismatches.push(`model=${state.modelOverride ?? "<rubric default>"}`);
    }

    if (mismatches.length > 0) {
      throw new Error(
        `Resume options must match saved state. Expected ${mismatches.join(", ")}.`
      );
    }
  }
}
