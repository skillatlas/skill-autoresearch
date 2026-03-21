import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { execa } from "execa";

import { Logger } from "./logger.js";
import { GenerationHarness } from "../types/generation.js";

export interface ContainerExecution {
  containerRoot: string;
  targetPath: string;
  prompt: string;
  label: string;
  harness: GenerationHarness;
}

export interface ContainerRunner {
  runPrompt(execution: ContainerExecution): Promise<void>;
}

const require = createRequire(import.meta.url);
const FORWARDED_ENV_VARS: Record<GenerationHarness, readonly string[]> = {
  claude: ["CLAUDE_CODE_OAUTH_TOKEN"],
  codex: [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID"
  ]
};

let cachedContainerCliEntryPoint: string | undefined;

function normalizeContainerPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function resolveTargetPathWithinWorkspace(
  workspaceRoot: string,
  targetPath: string
): string {
  const relativeTargetPath = path.relative(workspaceRoot, targetPath);
  if (
    relativeTargetPath.startsWith("..") ||
    path.isAbsolute(relativeTargetPath)
  ) {
    throw new Error(
      `Container target path ${targetPath} must be inside workspace ${workspaceRoot}.`
    );
  }

  return relativeTargetPath.length > 0
    ? normalizeContainerPath(relativeTargetPath)
    : ".";
}

export function resolveContainerCliEntryPoint(): string {
  if (cachedContainerCliEntryPoint) {
    return cachedContainerCliEntryPoint;
  }

  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve("@botanicastudios/code-container/package.json");
  } catch {
    throw new Error(
      "Missing @botanicastudios/code-container. Install dependencies before running skill-autoresearch."
    );
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const binPath =
    typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin?.container;

  if (!binPath) {
    throw new Error(
      "Unable to resolve the container CLI from @botanicastudios/code-container."
    );
  }

  cachedContainerCliEntryPoint = path.resolve(path.dirname(packageJsonPath), binPath);
  return cachedContainerCliEntryPoint;
}

export function buildContainerExecArgs(
  containerCliEntryPoint: string,
  execution: ContainerExecution,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const containerTargetPath = resolveTargetPathWithinWorkspace(
    execution.containerRoot,
    execution.targetPath
  );
  const args = [containerCliEntryPoint, "exec"];

  for (const envVarName of FORWARDED_ENV_VARS[execution.harness]) {
    if (env[envVarName]) {
      args.push("--env", envVarName);
    }
  }

  const agentCommand =
    execution.harness === "claude"
      ? 'cd "$1" && claude -p "$2"'
      : 'cd "$1" && codex exec --skip-git-repo-check -a never --sandbox workspace-write "$2"';

  args.push(
    execution.containerRoot,
    "--",
    "bash",
    "-lc",
    agentCommand,
    "bash",
    containerTargetPath,
    execution.prompt
  );

  return args;
}

export class CodeContainerRunner implements ContainerRunner {
  public constructor(
    private readonly workspaceRoot: string,
    private readonly logger: Logger,
    private readonly verbose: boolean
  ) {}

  public async runPrompt(execution: ContainerExecution): Promise<void> {
    const containerCliEntryPoint = resolveContainerCliEntryPoint();
    const args = buildContainerExecArgs(containerCliEntryPoint, execution);

    this.logger.phase(execution.label, { targetPath: execution.targetPath });
    if (this.verbose) {
      this.logger.debug(`node ${args.join(" ")}`);
    }

    const result = await execa(process.execPath, args, {
      cwd: this.workspaceRoot,
      all: true,
      reject: false
    });

    if (this.verbose && result.all?.trim()) {
      this.logger.debug(result.all);
    }

    if (result.exitCode !== 0) {
      throw new Error(
        `Container command failed for ${execution.targetPath} with exit code ${result.exitCode}.`
      );
    }
  }
}
