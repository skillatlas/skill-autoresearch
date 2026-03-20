import fs from "fs-extra";
import path from "node:path";

import { Logger } from "./logger.js";
import { RunState, runStateSchema } from "../types/state.js";

export class StateStore {
  public constructor(
    private readonly statePath: string,
    private readonly logger: Logger
  ) {}

  public async exists(): Promise<boolean> {
    return fs.pathExists(this.statePath);
  }

  public async load(): Promise<RunState> {
    const rawState = await fs.readFile(this.statePath, "utf8");
    const parsed = JSON.parse(rawState) as unknown;
    const result = runStateSchema.safeParse(parsed);

    if (!result.success) {
      throw new Error(
        `Invalid run state in ${this.statePath}: ${result.error.message}`
      );
    }

    return result.data;
  }

  public async save(state: RunState): Promise<void> {
    const normalizedState = runStateSchema.parse(state);
    await fs.ensureDir(path.dirname(this.statePath));

    const tempPath = `${this.statePath}.tmp`;
    await fs.writeFile(
      tempPath,
      `${JSON.stringify(normalizedState, null, 2)}\n`,
      "utf8"
    );
    await fs.move(tempPath, this.statePath, { overwrite: true });

    this.logger.debug(`Saved state to ${this.statePath}`, {
      currentPhase: normalizedState.currentPhase,
      status: normalizedState.status,
      stepIndex: normalizedState.stepIndex
    });
  }
}
