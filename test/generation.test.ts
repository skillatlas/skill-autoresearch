import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

import { loadGeneration } from "../src/core/generation.js";

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
});
