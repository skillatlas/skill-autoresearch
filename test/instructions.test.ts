import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

import { loadInstructions } from "../src/core/instructions.js";

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

describe("instructions parsing", () => {
  it("supports an explicit provider and optional model", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "instructions-"));
    const instructionsPath = path.join(tempDir, "INSTRUCTIONS.md");

    await fs.writeFile(
      instructionsPath,
      `---
provider: codex
model: gpt-5
---

Improve the skill.
`,
      "utf8"
    );

    const instructions = await loadInstructions(instructionsPath);
    expect(instructions.provider).toBe("codex");
    expect(instructions.modelId).toBe("gpt-5");
    expect(instructions.prompt).toBe("Improve the skill.");
  });

  it("lets an override provider replace instructions frontmatter", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "instructions-"));
    const instructionsPath = path.join(tempDir, "INSTRUCTIONS.md");

    await fs.writeFile(
      instructionsPath,
      `---
provider: claude
---

Improve the skill.
`,
      "utf8"
    );

    const instructions = await loadInstructions(instructionsPath, {
      providerOverride: "codex"
    });

    expect(instructions.provider).toBe("codex");
  });

  it("rejects instructions without an inferable provider", async () => {
    await withClearedInferenceEnv(async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "instructions-"));
      const instructionsPath = path.join(tempDir, "INSTRUCTIONS.md");

      await fs.writeFile(instructionsPath, "Improve the skill.\n", "utf8");

      await expect(loadInstructions(instructionsPath)).rejects.toThrow(
        "Unable to infer a local agent."
      );
    });
  });

  it("infers the provider from the workspace .env when omitted", async () => {
    await withClearedInferenceEnv(async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "instructions-"));
      const instructionsPath = path.join(tempDir, "INSTRUCTIONS.md");

      await fs.writeFile(
        path.join(tempDir, ".env"),
        "OPENAI_API_KEY=workspace-openai-key\n",
        "utf8"
      );
      await fs.writeFile(instructionsPath, "Improve the skill.\n", "utf8");

      const instructions = await loadInstructions(instructionsPath);
      expect(instructions.provider).toBe("codex");
      expect(instructions.modelId).toBeUndefined();
    });
  });

  it("rejects instructions files with an empty body", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "instructions-"));
    const instructionsPath = path.join(tempDir, "INSTRUCTIONS.md");

    await fs.writeFile(
      instructionsPath,
      `---
provider: claude
---
`,
      "utf8"
    );

    await expect(loadInstructions(instructionsPath)).rejects.toThrow(
      "Instructions body must not be empty."
    );
  });
});
