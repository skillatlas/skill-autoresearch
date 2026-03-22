import fs from "fs-extra";
import path from "node:path";

import { Logger } from "../src/core/logger.js";
import { WorkspaceManager } from "../src/core/workspace.js";
import {
  createWorkspaceCopy,
  readSkillVersion,
  readSkillVersionFromPath
} from "./helpers.js";

describe("workspace sandboxes", () => {
  it("creates generation-local skill links and preserves the copied skills snapshot", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const workspace = new WorkspaceManager(workspaceRoot, new Logger(false));
    const candidateDir = path.join(workspaceRoot, "steps", "1", "candidates", "0");

    await fs.ensureDir(candidateDir);
    const sandbox = await workspace.createGenerationSandbox(candidateDir);

    const claudeLink = path.join(sandbox.targetPath, ".claude", "skills");
    const agentsLink = path.join(sandbox.targetPath, ".agents", "skills");
    expect(sandbox.containerRoot).toBe(sandbox.targetPath);
    expect(sandbox.targetPath).not.toBe(candidateDir);
    expect((await fs.lstat(claudeLink)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(agentsLink)).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(claudeLink), await fs.readlink(claudeLink))).toBe(
      path.join(sandbox.targetPath, "skills")
    );
    expect(path.resolve(path.dirname(agentsLink), await fs.readlink(agentsLink))).toBe(
      path.join(sandbox.targetPath, "skills")
    );

    expect(await fs.pathExists(path.join(candidateDir, "skills"))).toBe(false);
    await sandbox.persistArtifacts();
    await sandbox.cleanup();

    expect(await fs.pathExists(path.join(candidateDir, "skills"))).toBe(true);
    expect(
      await readSkillVersionFromPath(
        workspaceRoot,
        "steps/1/candidates/0/skills/demo/SKILL.md"
      )
    ).toBe(0);
    expect(await fs.pathExists(path.join(candidateDir, ".claude"))).toBe(false);
    expect(await fs.pathExists(path.join(candidateDir, ".agents"))).toBe(false);
  });

  it("applies mutation sandbox changes back to workspace skills", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const workspace = new WorkspaceManager(workspaceRoot, new Logger(false));
    const sandbox = await workspace.createMutationSandbox(1);

    expect(path.relative(workspaceRoot, sandbox.containerRoot).startsWith("..")).toBe(true);
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

  it("creates steps and archive directories during validation when they are missing", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const workspace = new WorkspaceManager(workspaceRoot, new Logger(false));

    await fs.remove(workspace.paths.stepsDir);
    await fs.remove(workspace.paths.archiveDir);

    await workspace.validateSourceInputs({
      scoringMode: "rubric"
    });

    expect(await fs.pathExists(workspace.paths.stepsDir)).toBe(true);
    expect(await fs.pathExists(workspace.paths.archiveDir)).toBe(true);
    expect((await fs.stat(workspace.paths.stepsDir)).isDirectory()).toBe(true);
    expect((await fs.stat(workspace.paths.archiveDir)).isDirectory()).toBe(true);
  });

  it("loads numbered generation prompts when GENERATION.md is absent", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const workspace = new WorkspaceManager(workspaceRoot, new Logger(false));

    await fs.remove(path.join(workspaceRoot, "GENERATION.md"));
    await fs.writeFile(
      path.join(workspaceRoot, "GENERATION1.md"),
      "---\nharness: codex\n---\nFirst prompt.\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(workspaceRoot, "GENERATION2.md"),
      "---\nharness: claude\n---\nSecond prompt.\n",
      "utf8"
    );

    const generations = await workspace.loadGenerationSpecs();
    expect(generations.map((generation) => generation.fileName)).toEqual([
      "GENERATION1.md",
      "GENERATION2.md"
    ]);
  });
});
