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
model: openai/gpt-4.1
outputType: text
command: cat "$STEP_PATH/index.html"
---

Judge the outputs.`,
      "utf8"
    );

    const rubric = await loadRubric(rubricPath);
    expect(rubric.modelId).toBe("openai/gpt-4.1");
    expect(rubric.outputType).toBe("text");
    expect(rubric.commands).toEqual([{ command: 'cat "$STEP_PATH/index.html"' }]);
    expect(rubric.prompt).toBe("Judge the outputs.");
  });

  it("supports command arrays and preserves order", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
    const rubricPath = path.join(tempDir, "RUBRIC.md");

    await fs.writeFile(
      rubricPath,
      `---
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
    expect(rubric.commands.map((command) => command.resultPath)).toEqual([
      "$STEP_PATH/hero.png",
      "$STEP_PATH/about.png"
    ]);
  });

  it("supports a single command object in `commands`", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rubric-"));
    const rubricPath = path.join(tempDir, "RUBRIC.md");

    await fs.writeFile(
      rubricPath,
      `---
model: openai/gpt-4.1
outputType: text
commands:
  command: cat "$STEP_PATH/index.html"
---

Judge the outputs.`,
      "utf8"
    );

    const rubric = await loadRubric(rubricPath);
    expect(rubric.commands).toEqual([{ command: 'cat "$STEP_PATH/index.html"' }]);
  });

  it("interpolates STEP_PATH placeholders", () => {
    expect(interpolateStepPath('cat "$STEP_PATH/index.html"', "/tmp/step")).toBe(
      'cat "/tmp/step/index.html"'
    );
  });
});
