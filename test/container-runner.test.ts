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
        containerRoot: "/tmp/project",
        targetPath: "/tmp/project/steps/0/baseline",
        prompt: "Generate",
        label: "Baseline generation",
        harness: "claude"
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
      "bash",
      "-lc",
      'cd "$1" && claude -p "$2"',
      "bash",
      "steps/0/baseline",
      "Generate"
    ]);
  });

  it("omits the Claude OAuth token env flag when absent", () => {
    const args = buildContainerExecArgs(
      "/tmp/container.js",
      {
        containerRoot: "/tmp/project",
        targetPath: "/tmp/project/steps/0/baseline",
        prompt: "Generate",
        label: "Baseline generation",
        harness: "claude"
      },
      {}
    );

    expect(args).toEqual([
      "/tmp/container.js",
      "exec",
      "/tmp/project",
      "--",
      "bash",
      "-lc",
      'cd "$1" && claude -p "$2"',
      "bash",
      "steps/0/baseline",
      "Generate"
    ]);
  });

  it("uses the sandbox root when the target path is the container root", () => {
    const args = buildContainerExecArgs(
      "/tmp/container.js",
      {
        containerRoot: "/tmp/project/steps/0/baseline",
        targetPath: "/tmp/project/steps/0/baseline",
        prompt: "Generate",
        label: "Baseline generation",
        harness: "claude"
      },
      {}
    );

    expect(args).toEqual([
      "/tmp/container.js",
      "exec",
      "/tmp/project/steps/0/baseline",
      "--",
      "bash",
      "-lc",
      'cd "$1" && claude -p "$2"',
      "bash",
      ".",
      "Generate"
    ]);
  });

  it("uses codex exec with writable sandboxing when codex is selected", () => {
    const args = buildContainerExecArgs(
      "/tmp/container.js",
      {
        containerRoot: "/tmp/project",
        targetPath: "/tmp/project/steps/0/baseline",
        prompt: "Generate",
        label: "Baseline generation",
        harness: "codex"
      },
      {
        OPENAI_API_KEY: "secret",
        OPENAI_PROJECT_ID: "project"
      }
    );

    expect(args).toEqual([
      "/tmp/container.js",
      "exec",
      "--env",
      "OPENAI_API_KEY",
      "--env",
      "OPENAI_PROJECT_ID",
      "/tmp/project",
      "--",
      "bash",
      "-lc",
      'cd "$1" && codex exec --skip-git-repo-check -a never --sandbox workspace-write "$2"',
      "bash",
      "steps/0/baseline",
      "Generate"
    ]);
  });

  it("fails when the target path is outside the workspace", () => {
    expect(() =>
      buildContainerExecArgs(
        "/tmp/container.js",
        {
          containerRoot: "/tmp/project",
          targetPath: "/tmp/elsewhere",
          prompt: "Generate",
          label: "Baseline generation",
          harness: "claude"
        },
        {}
      )
    ).toThrow("must be inside workspace");
  });
});
