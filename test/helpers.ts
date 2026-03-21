import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ContainerExecution,
  ContainerRunner
} from "../src/core/container-runner.js";
import { Logger } from "../src/core/logger.js";
import { Orchestrator, RunOptions } from "../src/core/orchestrator.js";
import {
  ScoringService,
  summarizeVotes
} from "../src/core/scorer.js";
import { StateStore } from "../src/core/state-store.js";
import { WorkspaceManager } from "../src/core/workspace.js";
import {
  EvidenceItem,
  NormalizedRubric,
  ScoringProvider,
  ScoreVote
} from "../src/types/rubric.js";
import { RunState } from "../src/types/state.js";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "manual-workspace"
);

export async function createWorkspaceCopy(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "skill-autoresearch-")
  );
  await fs.copy(fixtureRoot, workspaceRoot);
  return workspaceRoot;
}

export async function readRunState(workspaceRoot: string): Promise<RunState> {
  return fs.readJson(path.join(workspaceRoot, ".skill-autoresearch", "state.json"));
}

export async function readSkillVersion(workspaceRoot: string): Promise<number> {
  return readSkillVersionFromPath(workspaceRoot, "skills/demo/SKILL.md");
}

export async function readSkillVersionFromPath(
  workspaceRoot: string,
  relativePath: string
): Promise<number> {
  const rawSkill = await fs.readFile(path.join(workspaceRoot, relativePath), "utf8");
  return Number.parseInt(rawSkill.match(/version=(\d+)/)?.[1] ?? "0", 10);
}

function extractCurrentSkillVersion(workspaceRoot: string): number {
  const rawSkill = fs.readFileSync(
    path.join(workspaceRoot, "skills", "demo", "SKILL.md"),
    "utf8"
  );
  return Number.parseInt(rawSkill.match(/version=(\d+)/)?.[1] ?? "0", 10);
}

function parseRelativeTarget(workspaceRoot: string, targetPath: string): string {
  return path.relative(workspaceRoot, targetPath).split(path.sep).join("/");
}

export interface FakeContainerOptions {
  mutationVersions?: number[];
  candidateScores?: Record<string, number>;
  baselineScore?: number;
  failOnce?: (execution: ContainerExecution) => boolean;
}

export class FakeContainerRunner implements ContainerRunner {
  public readonly executions: string[] = [];
  private mutationCalls = 0;
  private failureTriggered = false;

  public constructor(
    private readonly workspaceRoot: string,
    private readonly options: FakeContainerOptions = {}
  ) {}

  public async runPrompt(execution: ContainerExecution): Promise<void> {
    const relativeTarget = parseRelativeTarget(this.workspaceRoot, execution.targetPath);
    this.executions.push(relativeTarget);

    if (
      this.options.failOnce &&
      !this.failureTriggered &&
      this.options.failOnce(execution)
    ) {
      this.failureTriggered = true;
      throw new Error("Injected container failure");
    }

    if (execution.label.startsWith("Skill mutation for step ")) {
      const nextVersion =
        this.options.mutationVersions?.[this.mutationCalls] ??
        extractCurrentSkillVersion(this.workspaceRoot) + 1;
      this.mutationCalls += 1;

      await fs.writeFile(
        path.join(execution.targetPath, "demo", "SKILL.md"),
        `version=${nextVersion}\n`,
        "utf8"
      );
      return;
    }

    await fs.ensureDir(execution.targetPath);

    if (relativeTarget === "steps/0/baseline") {
      const score =
        this.options.baselineScore ?? extractCurrentSkillVersion(this.workspaceRoot);
      await this.writeArtifact(execution.targetPath, score);
      return;
    }

    const match = relativeTarget.match(/^steps\/(\d+)\/candidates\/(\d+)$/);
    if (!match) {
      throw new Error(`Unexpected target path in fake container: ${relativeTarget}`);
    }

    const currentVersion = extractCurrentSkillVersion(this.workspaceRoot);
    const stepIndex = Number.parseInt(match[1], 10);
    const candidateIndex = Number.parseInt(match[2], 10);
    const score =
      this.options.candidateScores?.[`${stepIndex}:${candidateIndex}`] ??
      currentVersion;
    await this.writeArtifact(execution.targetPath, score);
  }

  private async writeArtifact(targetPath: string, score: number): Promise<void> {
    await fs.writeFile(
      path.join(targetPath, "index.html"),
      `score=${score}\n`,
      "utf8"
    );
  }
}

export interface FakeScorerOptions {
  failOnVoteNumber?: number;
  rubricProvider?: ScoringProvider;
}

export class FakeScorer implements ScoringService {
  public voteCalls = 0;
  public readonly providers: ScoringProvider[] = [];
  private failureTriggered = false;

  public constructor(
    private readonly workspaceRoot: string,
    private readonly options: FakeScorerOptions = {}
  ) {}

  public async loadRubric(rubricPath: string): Promise<NormalizedRubric> {
    return {
      sourcePath: rubricPath,
      provider: this.options.rubricProvider ?? "openrouter",
      modelId: "test-model",
      outputType: "text",
      commands: [{ command: 'cat "$STEP_PATH/index.html"' }],
      prompt: "Prefer the higher score."
    };
  }

  public async collectEvidence(
    _rubric: NormalizedRubric,
    stepPath: string
  ): Promise<EvidenceItem[]> {
    const absolutePath = path.resolve(this.workspaceRoot, stepPath, "index.html");
    const content = await fs.readFile(absolutePath, "utf8");
    return [
      {
        outputType: "text",
        label: "artifact",
        content
      }
    ];
  }

  public async runSingleVote(input: {
    provider: ScoringProvider;
    modelId: string;
    rubricPrompt: string;
    incumbentEvidence: EvidenceItem[];
    candidateEvidence: EvidenceItem[];
  }): Promise<ScoreVote> {
    this.voteCalls += 1;
    this.providers.push(input.provider);
    if (
      this.options.failOnVoteNumber &&
      !this.failureTriggered &&
      this.voteCalls === this.options.failOnVoteNumber
    ) {
      this.failureTriggered = true;
      throw new Error("Injected scoring failure");
    }

    const incumbentScore = this.parseScore(input.incumbentEvidence[0]);
    const candidateScore = this.parseScore(input.candidateEvidence[0]);

    return {
      winner: candidateScore > incumbentScore ? "B" : "A",
      confidence: 1,
      rationale: "Higher score wins."
    };
  }

  public summarize(votes: ScoreVote[]) {
    return summarizeVotes(votes);
  }

  private parseScore(evidence: EvidenceItem): number {
    if (evidence.outputType !== "text") {
      throw new Error("Fake scorer only supports text evidence.");
    }

    return Number.parseInt(evidence.content.match(/score=(\d+)/)?.[1] ?? "0", 10);
  }
}

export async function runOrchestrator(input: {
  workspaceRoot: string;
  options?: Partial<RunOptions>;
  containerRunner: ContainerRunner;
  scorer: ScoringService;
}): Promise<RunState | undefined> {
  const logger = new Logger(false);
  const workspace = new WorkspaceManager(input.workspaceRoot, logger);
  const orchestrator = new Orchestrator(
    workspace,
    new StateStore(workspace.paths.statePath, logger),
    input.containerRunner,
    input.scorer,
    logger,
    {
      workspaceRoot: input.workspaceRoot,
      candidateCount: 3,
      voteCount: 3,
      minSteps: 0,
      maxSteps: 1,
      resume: false,
      dryRun: false,
      ...input.options
    }
  );

  return orchestrator.run();
}
