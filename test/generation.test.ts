import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

import {
  findGenerationPaths,
  loadGeneration,
  loadGenerations
} from "../src/core/generation.js";

describe("generation parsing", () => {
  it("requires an explicit harness and trims the prompt body", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "generation-"));
    const generationPath = path.join(tempDir, "GENERATION.md");

    await fs.writeFile(
      generationPath,
      `---
harness: codex
---

Generate the artifact set.
`,
      "utf8"
    );

    const generation = await loadGeneration(generationPath);
    expect(generation.fileName).toBe("GENERATION.md");
    expect(generation.harness).toBe("codex");
    expect(generation.prompt).toBe("Generate the artifact set.");
  });

  it("rejects generation files without a harness", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "generation-"));
    const generationPath = path.join(tempDir, "GENERATION.md");

    await fs.writeFile(generationPath, "Generate the artifact set.\n", "utf8");

    await expect(loadGeneration(generationPath)).rejects.toThrow();
  });

  it("rejects generation files with an empty body", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "generation-"));
    const generationPath = path.join(tempDir, "GENERATION.md");

    await fs.writeFile(
      generationPath,
      `---
harness: claude
---
`,
      "utf8"
    );

    await expect(loadGeneration(generationPath)).rejects.toThrow(
      "Generation body must not be empty."
    );
  });

  it("discovers and orders numbered generation files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "generation-"));
    await fs.writeFile(
      path.join(tempDir, "GENERATION2.md"),
      "---\nharness: codex\n---\nSecond prompt.\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tempDir, "GENERATION.md"),
      "---\nharness: claude\n---\nFirst prompt.\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tempDir, "GENERATION1.md"),
      "---\nharness: claude\n---\nMiddle prompt.\n",
      "utf8"
    );

    const generationPaths = await findGenerationPaths(tempDir);
    expect(generationPaths.map((generationPath) => path.basename(generationPath))).toEqual([
      "GENERATION.md",
      "GENERATION1.md",
      "GENERATION2.md"
    ]);

    const generations = await loadGenerations(tempDir);
    expect(generations.map((generation) => generation.fileName)).toEqual([
      "GENERATION.md",
      "GENERATION1.md",
      "GENERATION2.md"
    ]);
  });
});
