import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

import {
  findGenerationPaths,
  loadGeneration,
  loadGenerations
} from "../src/core/generation.js";

const INFERENCE_ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "HOME"
] as const;

async function withClearedInferenceEnv<T>(callback: () => Promise<T>): Promise<T> {
  const previousEnv = Object.fromEntries(
    INFERENCE_ENV_KEYS.map((key) => [key, process.env[key]])
  ) as Record<(typeof INFERENCE_ENV_KEYS)[number], string | undefined>;

  for (const key of INFERENCE_ENV_KEYS) {
    delete process.env[key];
  }

  try {
    return await callback();
  } finally {
    for (const key of INFERENCE_ENV_KEYS) {
      const previousValue = previousEnv[key];
      if (previousValue == null) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
  }
}

describe("generation parsing", () => {
  it("supports an explicit provider and optional model", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "generation-"));
    const generationPath = path.join(tempDir, "GENERATION.md");

    await fs.writeFile(
      generationPath,
      `---
provider: codex
model: gpt-5
---

Generate the artifact set.
`,
      "utf8"
    );

    const generation = await loadGeneration(generationPath);
    expect(generation.fileName).toBe("GENERATION.md");
    expect(generation.provider).toBe("codex");
    expect(generation.modelId).toBe("gpt-5");
    expect(generation.prompt).toBe("Generate the artifact set.");
  });

  it("rejects generation files without an inferable provider", async () => {
    await withClearedInferenceEnv(async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "generation-"));
      const generationPath = path.join(tempDir, "GENERATION.md");

      await fs.writeFile(generationPath, "Generate the artifact set.\n", "utf8");

      await expect(loadGeneration(generationPath)).rejects.toThrow(
        "Unable to infer a local agent."
      );
    });
  });

  it("infers the provider from the workspace .env when omitted", async () => {
    await withClearedInferenceEnv(async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "generation-"));
      const generationPath = path.join(tempDir, "GENERATION.md");

      await fs.writeFile(
        path.join(tempDir, ".env"),
        "OPENAI_API_KEY=workspace-openai-key\n",
        "utf8"
      );
      await fs.writeFile(generationPath, "Generate the artifact set.\n", "utf8");

      const generation = await loadGeneration(generationPath);
      expect(generation.provider).toBe("codex");
      expect(generation.modelId).toBeUndefined();
    });
  });

  it("rejects generation files with an empty body", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "generation-"));
    const generationPath = path.join(tempDir, "GENERATION.md");

    await fs.writeFile(
      generationPath,
      `---
provider: claude
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
      "---\nprovider: codex\n---\nSecond prompt.\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tempDir, "GENERATION.md"),
      "---\nprovider: claude\n---\nFirst prompt.\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tempDir, "GENERATION1.md"),
      "---\nprovider: claude\n---\nMiddle prompt.\n",
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
