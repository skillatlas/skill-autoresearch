import path from "node:path";

import { resolveContainerCliEntryPoint } from "../src/core/container-runner.js";

describe("container runner", () => {
  it("resolves the bundled code-container CLI entrypoint", () => {
    const entryPoint = resolveContainerCliEntryPoint();

    expect(path.isAbsolute(entryPoint)).toBe(true);
    expect(entryPoint).toContain(
      `${path.sep}@botanicastudios${path.sep}code-container${path.sep}`
    );
    expect(path.basename(entryPoint)).toBe("main.js");
  });
});
