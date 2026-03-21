import path from "node:path";
import { Command, InvalidArgumentError } from "commander";

import { CodeContainerRunner } from "../core/container-runner.js";
import { Logger } from "../core/logger.js";
import { Orchestrator, RunOptions } from "../core/orchestrator.js";
import { loadRubric } from "../core/rubric.js";
import {
  CodexVoteJudge,
  loadWorkspaceEnv,
  OpenRouterVoteJudge,
  Scorer
} from "../core/scorer.js";
import { StateStore } from "../core/state-store.js";
import { WorkspaceManager } from "../core/workspace.js";

function parseNonNegativeInteger(value: string): number {
  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new InvalidArgumentError(`Expected a non-negative integer, received ${value}.`);
  }

  return parsedValue;
}

function parsePositiveInteger(value: string): number {
  const parsedValue = parseNonNegativeInteger(value);
  if (parsedValue < 1) {
    throw new InvalidArgumentError(`Expected a positive integer, received ${value}.`);
  }

  return parsedValue;
}

export interface RunCliOptions {
  candidates: number;
  votes: number;
  minSteps: number;
  maxSteps: number;
  stasisSteps?: number;
  resume: boolean;
  model?: string;
  dryRun: boolean;
  verbose: boolean;
}

export function resolveWorkspaceRoot(
  workspaceArg: string | undefined,
  invocationDirectory: string = process.cwd()
): string {
  return workspaceArg
    ? path.resolve(invocationDirectory, workspaceArg)
    : path.resolve(invocationDirectory);
}

export async function runCommand(
  workspaceArg: string | undefined,
  options: RunCliOptions
): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot(workspaceArg);
  const logger = new Logger(options.verbose);
  const workspace = new WorkspaceManager(workspaceRoot, logger);
  const rubric = await loadRubric(workspace.paths.rubricPath);
  loadWorkspaceEnv(workspace.paths.envPath, { scoringProvider: rubric.provider });

  const runOptions: RunOptions = {
    workspaceRoot,
    candidateCount: options.candidates,
    voteCount: options.votes,
    minSteps: options.minSteps,
    maxSteps: options.maxSteps,
    stasisSteps: options.stasisSteps,
    resume: options.resume,
    modelOverride: options.model,
    dryRun: options.dryRun
  };

  const orchestrator = new Orchestrator(
    workspace,
    new StateStore(workspace.paths.statePath, logger),
    new CodeContainerRunner(workspaceRoot, logger, options.verbose),
    new Scorer(
      workspaceRoot,
      logger,
      {
        openrouter: new OpenRouterVoteJudge(logger),
        codex: new CodexVoteJudge(workspaceRoot, logger, options.verbose)
      },
      options.verbose
    ),
    logger,
    runOptions
  );

  await orchestrator.run();
}

export function buildRunCommand(): Command {
  return new Command("run")
    .description("Run the skill autoresearch loop.")
    .argument("[workspace]", "Workspace root", ".")
    .option("--candidates <n>", "Number of candidates per step", parsePositiveInteger, 3)
    .option("--votes <n>", "Number of scoring votes per comparison", parsePositiveInteger, 3)
    .option("--min-steps <n>", "Minimum mutation iterations before stasis applies", parseNonNegativeInteger, 0)
    .option("--max-steps <n>", "Maximum mutation iterations", parseNonNegativeInteger, 20)
    .option("--stasis-steps <n>", "Rejected mutation streak before stopping", parseNonNegativeInteger)
    .option("--resume", "Resume from existing state", false)
    .option("--model <id>", "Override rubric model")
    .option("--dry-run", "Validate inputs and print planned actions without running agents", false)
    .option("--verbose", "Include child command details in logs", false)
    .action(runCommand);
}
