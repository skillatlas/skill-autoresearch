import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Readable } from "node:stream";

import { execa } from "execa";

import { formatCommandFailure } from "./error-format.js";
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

const CLAUDE_GENERATION_MAX_ATTEMPTS = 3;
const CLAUDE_GENERATION_RETRY_DELAY_MS = 250;

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

function isGenerationExecution(execution: ContainerExecution): boolean {
  return (
    execution.label === "Baseline generation" ||
    execution.label.startsWith("Candidate ")
  );
}

function isRetriableClaudeGenerationFailure(output: string | undefined): boolean {
  if (!output) {
    return false;
  }

  return /Unexpected end of JSON input/i.test(output);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function normalizeContainerPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function tryResolveTargetPathWithinRoot(
  rootPath: string,
  targetPath: string
): string | undefined {
  const relativeTargetPath = path.relative(rootPath, targetPath);
  if (
    relativeTargetPath.startsWith("..") ||
    path.isAbsolute(relativeTargetPath)
  ) {
    return undefined;
  }

  return relativeTargetPath.length > 0
    ? normalizeContainerPath(relativeTargetPath)
    : ".";
}

function resolveTargetPathWithinWorkspace(
  workspaceRoot: string,
  targetPath: string
): string {
  const resolvedTargetPath = tryResolveTargetPathWithinRoot(
    workspaceRoot,
    targetPath
  );
  if (!resolvedTargetPath) {
    throw new Error(
      `Container target path ${targetPath} must be inside workspace ${workspaceRoot}.`
    );
  }

  return resolvedTargetPath;
}

function resolveDebugPrefix(
  workspaceRoot: string,
  execution: ContainerExecution
): string {
  const workspaceRelativeTargetPath = tryResolveTargetPathWithinRoot(
    workspaceRoot,
    execution.targetPath
  );
  if (workspaceRelativeTargetPath) {
    return workspaceRelativeTargetPath === "."
      ? path.basename(execution.targetPath) || "."
      : workspaceRelativeTargetPath;
  }

  const containerRelativeTargetPath = tryResolveTargetPathWithinRoot(
    execution.containerRoot,
    execution.targetPath
  );
  if (containerRelativeTargetPath) {
    return containerRelativeTargetPath === "."
      ? path.basename(execution.targetPath) || "."
      : containerRelativeTargetPath;
  }

  return path.basename(execution.targetPath) || execution.label;
}

function quoteCommandArg(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : JSON.stringify(value);
}

function summarizeExecArgs(args: readonly string[]): string {
  if (args.length === 0) {
    return process.execPath;
  }

  const summarizedArgs = [...args];
  summarizedArgs[summarizedArgs.length - 1] = "[prompt omitted]";

  return `${quoteCommandArg(process.execPath)} ${summarizedArgs
    .map((arg) => quoteCommandArg(arg))
    .join(" ")}`;
}

function buildIsolatedHomeSetupCommand(configPaths: readonly string[]): string {
  const copyCommands = configPaths.map((configPath) =>
    configPath.endsWith(".json")
      ? `if [ -f /root/${configPath} ]; then cp /root/${configPath} "$HOME/${configPath}"; fi`
      : `if [ -d /root/${configPath} ]; then cp -R /root/${configPath} "$HOME/${configPath}"; fi`
  );

  return [
    'tmp_home="$(mktemp -d)"',
    'cleanup() { rm -rf "$tmp_home"; }',
    "trap cleanup EXIT",
    'export HOME="$tmp_home"',
    ...copyCommands
  ].join("; ");
}

function buildClaudeCommand(debugGeneration: boolean): string {
  const claudeCommand = debugGeneration
    ? 'claude --no-session-persistence --verbose --output-format stream-json -p "$2"'
    : 'claude --no-session-persistence -p "$2"';

  return [
    buildIsolatedHomeSetupCommand([".claude", ".claude.json"]),
    'cd "$1"',
    claudeCommand
  ].join("; ");
}

function buildCodexCommand(): string {
  return [
    buildIsolatedHomeSetupCommand([".codex"]),
    'cd "$1"',
    'codex exec --ephemeral --skip-git-repo-check -a never --sandbox workspace-write "$2"'
  ].join("; ");
}

function writePrefixedOutput(stream: Readable, prefix: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffered = "";

    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffered += chunk;

      let newlineIndex = buffered.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffered.slice(0, newlineIndex).replace(/\r$/, "");
        console.log(`${prefix} ${line}`);
        buffered = buffered.slice(newlineIndex + 1);
        newlineIndex = buffered.indexOf("\n");
      }
    });
    stream.on("end", () => {
      if (buffered.length > 0) {
        console.log(`${prefix} ${buffered.replace(/\r$/, "")}`);
      }
      resolve();
    });
    stream.on("error", reject);
  });
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

  const debugGeneration =
    execution.harness === "claude" &&
    env.DEBUG_GENERATION === "1" &&
    isGenerationExecution(execution);
  const agentCommand =
    execution.harness === "claude"
      ? buildClaudeCommand(debugGeneration)
      : buildCodexCommand();

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

    const maxAttempts =
      execution.harness === "claude" && isGenerationExecution(execution)
        ? CLAUDE_GENERATION_MAX_ATTEMPTS
        : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const debugGeneration =
        execution.harness === "claude" &&
        process.env.DEBUG_GENERATION === "1" &&
        isGenerationExecution(execution);
      const debugPrefix = debugGeneration
        ? resolveDebugPrefix(this.workspaceRoot, execution)
        : undefined;
      const subprocess = execa(process.execPath, args, {
        cwd: this.workspaceRoot,
        all: true,
        reject: false
      });
      const streamedOutput =
        debugGeneration && subprocess.all && debugPrefix
          ? writePrefixedOutput(subprocess.all, debugPrefix)
          : undefined;
      const result = await subprocess;
      await streamedOutput;

      if (this.verbose && !debugGeneration && result.all?.trim()) {
        this.logger.debug(result.all);
      }

      if (result.exitCode === 0) {
        return;
      }

      const failureMessage = formatCommandFailure({
        label: "Container command",
        subject: execution.label,
        command: summarizeExecArgs(args),
        exitCode: result.exitCode ?? 1,
        output: result.all
      });
      const shouldRetry =
        attempt < maxAttempts &&
        execution.harness === "claude" &&
        isGenerationExecution(execution) &&
        isRetriableClaudeGenerationFailure(result.all);

      if (shouldRetry) {
        this.logger.warn(
          `Retrying ${execution.label} after transient Claude CLI failure (${attempt}/${maxAttempts}).`,
          {
            attempt,
            maxAttempts,
            containerRoot: execution.containerRoot,
            targetPath: execution.targetPath,
            harness: execution.harness,
            output: result.all
          },
          "container-command-retry"
        );
        await delay(CLAUDE_GENERATION_RETRY_DELAY_MS);
        continue;
      }

      this.logger.error(
        failureMessage,
        {
          containerRoot: execution.containerRoot,
          targetPath: execution.targetPath,
          harness: execution.harness
        },
        "container-command-failed"
      );
      throw new Error(failureMessage);
    }
  }
}
