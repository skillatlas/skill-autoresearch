import path from "node:path";

import {
  buildContainerExecArgs,
  resolveContainerCliEntryPoint
} from "../src/core/container-runner.js";

describe("container runner", () => {
  it("resolves the bundled code-container CLI entrypoint", () => {
    const entryPoint = resolveContainerCliEntryPoint();

    expect(path.isAbsolute(entryPoint)).toBe(true);
    expect(entryPoint).toContain(
      `${path.sep}@botanicastudios${path.sep}code-container${path.sep}`
    );
    expect(path.basename(entryPoint)).toBe("main.js");
  });

  it("includes the Claude OAuth token env flag when present", () => {
    const args = buildContainerExecArgs(
      "/tmp/container.js",
      {
        targetPath: "/tmp/project",
        prompt: "Generate",
        label: "Baseline generation"
      },
      {
        CLAUDE_CODE_OAUTH_TOKEN: "secret"
      }
    );

    expect(args).toEqual([
      "/tmp/container.js",
      "exec",
      "--env",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "/tmp/project",
      "--",
      "claude",
      "-p",
      "Generate"
    ]);
  });

  it("omits the Claude OAuth token env flag when absent", () => {
    const args = buildContainerExecArgs(
      "/tmp/container.js",
      {
        targetPath: "/tmp/project",
        prompt: "Generate",
        label: "Baseline generation"
      },
      {}
    );

    expect(args).toEqual([
      "/tmp/container.js",
      "exec",
      "/tmp/project",
      "--",
      "claude",
      "-p",
      "Generate"
    ]);
  });
});
