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

export class CodeContainerRunner implements ContainerRunner {
  public constructor(
    private readonly workspaceRoot: string,
    private readonly logger: Logger,
    private readonly verbose: boolean
  ) {}

  public async runPrompt(execution: ContainerExecution): Promise<void> {
    const args = [
      "exec",
      execution.targetPath,
      "--",
      "claude",
      "-p",
      execution.prompt
    ];

    this.logger.phase(execution.label, { targetPath: execution.targetPath });
    if (this.verbose) {
      this.logger.debug(`container ${args.join(" ")}`);
    }

    const result = await execa("container", args, {
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
