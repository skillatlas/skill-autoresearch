import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

import { interpolateStepPath, loadRubric } from "../src/core/rubric.js";

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

  it("requires an explicit scoring provider", async () => {
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

    await expect(loadRubric(rubricPath)).rejects.toThrow();
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

  it("requires top-level resultPath when commands are omitted", async () => {
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
      "Rubric frontmatter must contain either `resultPath` or `commands`."
    );
  });

  it("interpolates STEP_PATH placeholders", () => {
    expect(interpolateStepPath('cat "$STEP_PATH/index.html"', "/tmp/step")).toBe(
      'cat "/tmp/step/index.html"'
    );
  });
});
