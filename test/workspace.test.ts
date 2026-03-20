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
    expect(path.resolve(path.dirname(claudeLink), await fs.readlink(claudeLink))).toBe(
      path.join(workspaceRoot, "skills")
    );
    expect(path.resolve(path.dirname(agentsLink), await fs.readlink(agentsLink))).toBe(
      path.join(workspaceRoot, "skills")
    );
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

  it("tracks .env and source inputs from the workspace root", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const workspace = new WorkspaceManager(workspaceRoot, new Logger(false));

    expect(workspace.paths.instructionsPath).toBe(path.join(workspaceRoot, "INSTRUCTIONS.md"));
    expect(workspace.paths.generationPath).toBe(path.join(workspaceRoot, "GENERATION.md"));
    expect(workspace.paths.rubricPath).toBe(path.join(workspaceRoot, "RUBRIC.md"));
    expect(workspace.paths.envPath).toBe(path.join(workspaceRoot, ".env"));
    expect(workspace.paths.skillsDir).toBe(path.join(workspaceRoot, "skills"));
    expect(workspace.paths.stepsDir).toBe(path.join(workspaceRoot, "steps"));
    expect(workspace.paths.archiveDir).toBe(path.join(workspaceRoot, "archive"));
  });
});
