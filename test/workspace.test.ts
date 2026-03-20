import fs from "fs-extra";
import path from "node:path";

import { Logger } from "../src/core/logger.js";
import { WorkspaceManager } from "../src/core/workspace.js";
import { createWorkspaceCopy, readSkillVersion } from "./helpers.js";

describe("workspace sandboxes", () => {
  it("creates generation-local skill links and cleans them up", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const workspace = new WorkspaceManager(workspaceRoot, new Logger(false));
    const candidateDir = path.join(workspaceRoot, "steps", "1", "candidates", "0");

    await fs.ensureDir(candidateDir);
    const sandbox = await workspace.createGenerationSandbox(candidateDir);

    const claudeLink = path.join(candidateDir, ".claude", "skills");
    const agentsLink = path.join(candidateDir, ".agents", "skills");
    expect(sandbox.containerRoot).toBe(candidateDir);
    expect(sandbox.targetPath).toBe(candidateDir);
    expect((await fs.lstat(claudeLink)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(agentsLink)).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(claudeLink), await fs.readlink(claudeLink))).toBe(
      path.join(candidateDir, "skills")
    );
    expect(path.resolve(path.dirname(agentsLink), await fs.readlink(agentsLink))).toBe(
      path.join(candidateDir, "skills")
    );

    await sandbox.cleanup();

    expect(await fs.pathExists(path.join(candidateDir, "skills"))).toBe(false);
    expect(await fs.pathExists(path.join(candidateDir, ".claude"))).toBe(false);
    expect(await fs.pathExists(path.join(candidateDir, ".agents"))).toBe(false);
  });

  it("applies mutation sandbox changes back to workspace skills", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const workspace = new WorkspaceManager(workspaceRoot, new Logger(false));
    const sandbox = await workspace.createMutationSandbox(1);

    await fs.writeFile(
      path.join(sandbox.targetPath, "demo", "SKILL.md"),
      "version=4\n",
      "utf8"
    );
    await sandbox.applyChanges();
    await sandbox.cleanup();

    expect(await readSkillVersion(workspaceRoot)).toBe(4);
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
