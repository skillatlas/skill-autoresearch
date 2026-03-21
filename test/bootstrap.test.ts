import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  bootstrapWorkspace,
  findPackageRoot
} from "../src/commands/bootstrap.js";

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createPackageFixture(): Promise<string> {
  const packageRoot = await createTempDir("skill-autoresearch-package-");

  await fs.writeJson(path.join(packageRoot, "package.json"), {
    name: "skill-autoresearch"
  });
  await fs.outputFile(
    path.join(packageRoot, "skills", "demo", "SKILL.md"),
    "package skill\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(packageRoot, "GENERATION.md"),
    "package generation\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(packageRoot, "RUBRIC.md"),
    "package rubric\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(packageRoot, "INSTRUCTIONS.md"),
    "package instructions\n",
    "utf8"
  );

  return packageRoot;
}

describe("bootstrap workspace", () => {
  it("copies package templates into a workspace when targets are missing", async () => {
    const packageRoot = await createPackageFixture();
    const invocationDirectory = await createTempDir("skill-autoresearch-invocation-");
    const result = await bootstrapWorkspace("workspace", {
      invocationDirectory,
      packageRoot
    });

    const workspaceRoot = path.join(invocationDirectory, "workspace");
    expect(result.workspaceRoot).toBe(workspaceRoot);
    expect(result.copied).toEqual([
      "skills/",
      "GENERATION.md",
      "RUBRIC.md",
      "INSTRUCTIONS.md"
    ]);
    expect(result.skipped).toEqual([]);
    expect(
      await fs.readFile(path.join(workspaceRoot, "skills", "demo", "SKILL.md"), "utf8")
    ).toBe("package skill\n");
    expect(await fs.readFile(path.join(workspaceRoot, "GENERATION.md"), "utf8")).toBe(
      "package generation\n"
    );
    expect(await fs.readFile(path.join(workspaceRoot, "RUBRIC.md"), "utf8")).toBe(
      "package rubric\n"
    );
    expect(await fs.readFile(path.join(workspaceRoot, "INSTRUCTIONS.md"), "utf8")).toBe(
      "package instructions\n"
    );
  });

  it("skips existing files and an existing skills directory without overwriting them", async () => {
    const packageRoot = await createPackageFixture();
    const workspaceRoot = await createTempDir("skill-autoresearch-workspace-");

    await fs.outputFile(
      path.join(workspaceRoot, "skills", "custom", "SKILL.md"),
      "existing skill\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(workspaceRoot, "GENERATION.md"),
      "existing generation\n",
      "utf8"
    );

    const result = await bootstrapWorkspace(undefined, {
      invocationDirectory: workspaceRoot,
      packageRoot
    });

    expect(result.workspaceRoot).toBe(workspaceRoot);
    expect(result.copied).toEqual(["RUBRIC.md", "INSTRUCTIONS.md"]);
    expect(result.skipped).toEqual(["skills/", "GENERATION.md"]);
    expect(
      await fs.readFile(path.join(workspaceRoot, "skills", "custom", "SKILL.md"), "utf8")
    ).toBe("existing skill\n");
    expect(await fs.readFile(path.join(workspaceRoot, "GENERATION.md"), "utf8")).toBe(
      "existing generation\n"
    );
    expect(await fs.readFile(path.join(workspaceRoot, "RUBRIC.md"), "utf8")).toBe(
      "package rubric\n"
    );
    expect(await fs.readFile(path.join(workspaceRoot, "INSTRUCTIONS.md"), "utf8")).toBe(
      "package instructions\n"
    );
    expect(await fs.pathExists(path.join(workspaceRoot, "skills", "demo"))).toBe(false);
  });

  it("finds the package root from a built command path", async () => {
    const packageRoot = await createPackageFixture();
    const commandPath = path.join(
      packageRoot,
      "dist",
      "src",
      "commands",
      "bootstrap.js"
    );

    await fs.outputFile(commandPath, "// built file\n", "utf8");

    expect(findPackageRoot(pathToFileURL(commandPath).href)).toBe(packageRoot);
  });
});
