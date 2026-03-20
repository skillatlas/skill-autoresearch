import fs from "fs-extra";
import path from "node:path";

import { Logger } from "../src/core/logger.js";
import { WorkspaceManager } from "../src/core/workspace.js";
import { createWorkspaceCopy } from "./helpers.js";

describe("workspace symlinks", () => {
  it("creates missing skill symlinks", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const workspace = new WorkspaceManager(workspaceRoot, new Logger(false));

    await workspace.ensureSkillSymlinks();

    const claudeLink = path.join(workspaceRoot, ".claude", "skills");
    const agentsLink = path.join(workspaceRoot, ".agents", "skills");
    expect((await fs.lstat(claudeLink)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(agentsLink)).isSymbolicLink()).toBe(true);
  });

  it("fails when an existing symlink points somewhere else", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    await fs.ensureDir(path.join(workspaceRoot, ".claude"));
    await fs.symlink("../archive", path.join(workspaceRoot, ".claude", "skills"), "dir");

    const workspace = new WorkspaceManager(workspaceRoot, new Logger(false));

    await expect(workspace.ensureSkillSymlinks()).rejects.toThrow(
      ".claude/skills points to ../archive"
    );
  });
});
