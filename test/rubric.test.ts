import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

import {
  interpolateRubricVariables,
  interpolateStepPath,
  loadRubric
} from "../src/core/rubric.js";

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

describe("rubric parsing", () => {
  it("normalizes a single-command rubric", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
    const rubricPath = path.join(tempDir, "RUBRIC.md");

    await fs.writeFile(
      rubricPath,
      `---
provider: openrouter
model: openai/gpt-4.1
outputType: text
resultPath: "$STEP_PATH/index.html"
---

Judge the outputs.`,
      "utf8"
    );

    const rubric = await loadRubric(rubricPath);
    expect(rubric.provider).toBe("openrouter");
    expect(rubric.modelId).toBe("openai/gpt-4.1");
    expect(rubric.httpServerPort).toBeUndefined();
    expect(rubric.commands).toEqual([
      { outputType: "text", resultPath: "$STEP_PATH/index.html" }
    ]);
    expect(rubric.prompt).toBe("Judge the outputs.");
  });

  it("supports command arrays and preserves order", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
    const rubricPath = path.join(tempDir, "RUBRIC.md");

    await fs.writeFile(
      rubricPath,
      `---
provider: openrouter
model: openai/gpt-4.1
outputType: image
commands:
  - command: make-shot "$STEP_PATH/index.html" "$STEP_PATH/hero.png"
    resultPath: "$STEP_PATH/hero.png"
  - command: make-shot "$STEP_PATH/about.html" "$STEP_PATH/about.png"
    resultPath: "$STEP_PATH/about.png"
---

Judge the screenshots.`,
      "utf8"
    );

    const rubric = await loadRubric(rubricPath);
    expect(rubric.commands).toEqual([
      {
        outputType: "image",
        command: 'make-shot "$STEP_PATH/index.html" "$STEP_PATH/hero.png"',
        resultPath: "$STEP_PATH/hero.png"
      },
      {
        outputType: "image",
        command: 'make-shot "$STEP_PATH/about.html" "$STEP_PATH/about.png"',
        resultPath: "$STEP_PATH/about.png"
      }
    ]);
  });

  it("supports a single command object in `commands`", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
    const rubricPath = path.join(tempDir, "RUBRIC.md");

    await fs.writeFile(
      rubricPath,
      `---
provider: openrouter
model: openai/gpt-4.1
commands:
  outputType: text
  resultPath: "$STEP_PATH/index.html"
---

Judge the outputs.`,
      "utf8"
    );

    const rubric = await loadRubric(rubricPath);
    expect(rubric.commands).toEqual([
      { outputType: "text", resultPath: "$STEP_PATH/index.html" }
    ]);
  });

  it("supports mixed text and image commands in one rubric", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
    const rubricPath = path.join(tempDir, "RUBRIC.md");

    await fs.writeFile(
      rubricPath,
      `---
provider: openrouter
model: openai/gpt-4.1
commands:
  - outputType: text
    resultPath: "$STEP_PATH/index.html"
  - outputType: image
    command: make-shot "$STEP_PATH/index.html" "$STEP_PATH/hero.png"
    resultPath: "$STEP_PATH/hero.png"
---

Judge the outputs.`,
      "utf8"
    );

    const rubric = await loadRubric(rubricPath);
    expect(rubric.commands).toEqual([
      { outputType: "text", resultPath: "$STEP_PATH/index.html" },
      {
        outputType: "image",
        command: 'make-shot "$STEP_PATH/index.html" "$STEP_PATH/hero.png"',
        resultPath: "$STEP_PATH/hero.png"
      }
    ]);
  });

  it("normalizes `http_server: true` to an ephemeral port", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
    const rubricPath = path.join(tempDir, "RUBRIC.md");

    await fs.writeFile(
      rubricPath,
      `---
provider: openrouter
model: openai/gpt-4.1
http_server: true
commands:
  - outputType: image
    command: playwright-cli open "$STEP_ORIGIN/index.html"
    resultPath: "$STEP_PATH/index.png"
---

Judge the outputs.`,
      "utf8"
    );

    const rubric = await loadRubric(rubricPath);
    expect(rubric.httpServerPort).toBe(0);
  });

  it("preserves an explicit `http_server` port", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
    const rubricPath = path.join(tempDir, "RUBRIC.md");

    await fs.writeFile(
      rubricPath,
      `---
provider: openrouter
model: openai/gpt-4.1
http_server: 8080
commands:
  - outputType: image
    command: playwright-cli open "$STEP_ORIGIN/index.html"
    resultPath: "$STEP_PATH/index.png"
---

Judge the outputs.`,
      "utf8"
    );

    const rubric = await loadRubric(rubricPath);
    expect(rubric.httpServerPort).toBe(8080);
  });

  it("infers a scoring provider when omitted", async () => {
    await withClearedInferenceEnv(async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
      const rubricPath = path.join(tempDir, "RUBRIC.md");

      process.env.CLAUDE_CODE_OAUTH_TOKEN = "claude-token";

      await fs.writeFile(
        rubricPath,
        `---
model: openai/gpt-4.1
outputType: text
resultPath: "$STEP_PATH/index.html"
---

Judge the outputs.`,
        "utf8"
      );

      const rubric = await loadRubric(rubricPath);
      expect(rubric.provider).toBe("claude");
    });
  });

  it("rejects a rubric without a provider when no local agent can be inferred", async () => {
    await withClearedInferenceEnv(async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
      const rubricPath = path.join(tempDir, "RUBRIC.md");

      await fs.writeFile(
        rubricPath,
        `---
model: openai/gpt-4.1
outputType: text
resultPath: "$STEP_PATH/index.html"
---

Judge the outputs.`,
        "utf8"
      );

      await expect(loadRubric(rubricPath)).rejects.toThrow(
        "Unable to infer a local agent."
      );
    });
  });

  it("supports an explicit scoring provider", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
    const rubricPath = path.join(tempDir, "RUBRIC.md");

    await fs.writeFile(
      rubricPath,
      `---
provider: codex
model: gpt-5.4
outputType: text
resultPath: "$STEP_PATH/index.html"
---

Judge the outputs.`,
      "utf8"
    );

    const rubric = await loadRubric(rubricPath);
    expect(rubric.provider).toBe("codex");
    expect(rubric.modelId).toBe("gpt-5.4");
  });

  it("supports Claude as a scoring provider", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
    const rubricPath = path.join(tempDir, "RUBRIC.md");

    await fs.writeFile(
      rubricPath,
      `---
provider: claude
model: claude-opus-4-1
outputType: text
resultPath: "$STEP_PATH/index.html"
---

Judge the outputs.`,
      "utf8"
    );

    const rubric = await loadRubric(rubricPath);
    expect(rubric.provider).toBe("claude");
    expect(rubric.modelId).toBe("claude-opus-4-1");
  });

  it("allows omitting the model for codex scoring", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
    const rubricPath = path.join(tempDir, "RUBRIC.md");

    await fs.writeFile(
      rubricPath,
      `---
provider: codex
outputType: text
resultPath: "$STEP_PATH/index.html"
---

Judge the outputs.`,
      "utf8"
    );

    const rubric = await loadRubric(rubricPath);
    expect(rubric.provider).toBe("codex");
    expect(rubric.modelId).toBeUndefined();
  });

  it("allows omitting resultPath for local scoring", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
    const rubricPath = path.join(tempDir, "RUBRIC.md");

    await fs.writeFile(
      rubricPath,
      `---
provider: claude
command: make-ready "$STEP_PATH"
---

Judge the outputs.`,
      "utf8"
    );

    const rubric = await loadRubric(rubricPath);
    expect(rubric.provider).toBe("claude");
    expect(rubric.commands).toEqual([
      {
        command: 'make-ready "$STEP_PATH"'
      }
    ]);
  });

  it("requires a model for OpenRouter scoring", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
    const rubricPath = path.join(tempDir, "RUBRIC.md");

    await fs.writeFile(
      rubricPath,
      `---
provider: openrouter
outputType: text
resultPath: "$STEP_PATH/index.html"
---

Judge the outputs.`,
      "utf8"
    );

    await expect(loadRubric(rubricPath)).rejects.toThrow(
      "Rubric frontmatter must contain `model` when `provider` is `openrouter`."
    );
  });

  it("requires command output types when top-level outputType is omitted", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
    const rubricPath = path.join(tempDir, "RUBRIC.md");

    await fs.writeFile(
      rubricPath,
      `---
provider: openrouter
model: openai/gpt-4.1
commands:
  - resultPath: "$STEP_PATH/index.html"
---

Judge the outputs.`,
      "utf8"
    );

    await expect(loadRubric(rubricPath)).rejects.toThrow(
      "Each rubric command must define `outputType` when no top-level `outputType` is set."
    );
  });

  it("requires top-level resultPath when commands are omitted for OpenRouter", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
    const rubricPath = path.join(tempDir, "RUBRIC.md");

    await fs.writeFile(
      rubricPath,
      `---
provider: openrouter
model: openai/gpt-4.1
outputType: text
command: cat "$STEP_PATH/index.html"
---

Judge the outputs.`,
      "utf8"
    );

    await expect(loadRubric(rubricPath)).rejects.toThrow(
      "Each rubric command must define `resultPath` when `provider` is `openrouter`."
    );
  });

  it("requires command result paths for OpenRouter", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
    const rubricPath = path.join(tempDir, "RUBRIC.md");

    await fs.writeFile(
      rubricPath,
      `---
provider: openrouter
model: openai/gpt-4.1
commands:
  - command: prepare "$STEP_PATH"
---

Judge the outputs.`,
      "utf8"
    );

    await expect(loadRubric(rubricPath)).rejects.toThrow(
      "Each rubric command must define `resultPath` when `provider` is `openrouter`."
    );
  });

  it("interpolates STEP_PATH placeholders", () => {
    expect(interpolateStepPath('cat "$STEP_PATH/index.html"', "/tmp/step")).toBe(
      'cat "/tmp/step/index.html"'
    );
  });

  it("interpolates STEP_ORIGIN placeholders", () => {
    expect(
      interpolateRubricVariables('playwright-cli open "$STEP_ORIGIN/index.html"', {
        stepPath: "/tmp/step",
        stepOrigin: "http://127.0.0.1:4173"
      })
    ).toBe('playwright-cli open "http://127.0.0.1:4173/index.html"');
  });
});
