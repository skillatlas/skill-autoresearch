import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { execa } from "execa";

import { Logger } from "./logger.js";

export interface ContainerExecution {
  targetPath: string;
  prompt: string;
  label: string;
}

export interface ContainerRunner {
  runPrompt(execution: ContainerExecution): Promise<void>;
}

const require = createRequire(import.meta.url);
const FORWARDED_ENV_VARS = ["CLAUDE_CODE_OAUTH_TOKEN"] as const;

let cachedContainerCliEntryPoint: string | undefined;

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
  const args = [containerCliEntryPoint, "exec"];

  for (const envVarName of FORWARDED_ENV_VARS) {
    if (env[envVarName]) {
      args.push("--env", envVarName);
    }
  }

  args.push(
    execution.targetPath,
    "--",
    "claude",
    "-p",
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
