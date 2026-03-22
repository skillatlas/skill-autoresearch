import path from "node:path";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

import {
  buildContainerExecArgs,
  CodeContainerRunner,
  resolveContainerCliEntryPoint
} from "../src/core/container-runner.js";
import { Logger } from "../src/core/logger.js";

const { execaMock } = vi.hoisted(() => ({
  execaMock: vi.fn()
}));

vi.mock("execa", () => ({
  execa: execaMock
}));

const claudeCommand =
  'tmp_home="$(mktemp -d)"; cleanup() { rm -rf "$tmp_home"; }; trap cleanup EXIT; export HOME="$tmp_home"; if [ -d /root/.claude ]; then cp -R /root/.claude "$HOME/.claude"; fi; if [ -f /root/.claude.json ]; then cp /root/.claude.json "$HOME/.claude.json"; fi; cd "$1"; claude --no-session-persistence -p "$2"';
const claudeDebugCommand =
  'tmp_home="$(mktemp -d)"; cleanup() { rm -rf "$tmp_home"; }; trap cleanup EXIT; export HOME="$tmp_home"; if [ -d /root/.claude ]; then cp -R /root/.claude "$HOME/.claude"; fi; if [ -f /root/.claude.json ]; then cp /root/.claude.json "$HOME/.claude.json"; fi; cd "$1"; claude --no-session-persistence --verbose --output-format stream-json -p "$2"';
const codexCommand =
  'tmp_home="$(mktemp -d)"; cleanup() { rm -rf "$tmp_home"; }; trap cleanup EXIT; export HOME="$tmp_home"; if [ -d /root/.codex ]; then cp -R /root/.codex "$HOME/.codex"; fi; cd "$1"; codex exec --ephemeral --skip-git-repo-check -a never --sandbox workspace-write "$2"';

describe("container runner", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

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
      claudeCommand,
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
      claudeCommand,
      "bash",
      "steps/0/baseline",
      "Generate"
    ]);
  });

  it("enables streamed Claude output for generation when DEBUG_GENERATION=1", () => {
    const args = buildContainerExecArgs(
      "/tmp/container.js",
      {
        containerRoot: "/tmp/project",
        targetPath: "/tmp/project/artifact",
        prompt: "Generate",
        label: "Baseline generation",
        harness: "claude"
      },
      {
        DEBUG_GENERATION: "1"
      }
    );

    expect(args).toEqual([
      "/tmp/container.js",
      "exec",
      "/tmp/project",
      "--",
      "bash",
      "-lc",
      claudeDebugCommand,
      "bash",
      "artifact",
      "Generate"
    ]);
  });

  it("does not enable streamed Claude output for mutation runs", () => {
    const args = buildContainerExecArgs(
      "/tmp/container.js",
      {
        containerRoot: "/tmp/project",
        targetPath: "/tmp/project/skills",
        prompt: "Mutate",
        label: "Skill mutation for step 1",
        harness: "claude"
      },
      {
        DEBUG_GENERATION: "1"
      }
    );

    expect(args).toEqual([
      "/tmp/container.js",
      "exec",
      "/tmp/project",
      "--",
      "bash",
      "-lc",
      claudeCommand,
      "bash",
      "skills",
      "Mutate"
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
      claudeCommand,
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
      codexCommand,
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

  it("includes child output in command failures without logging the full prompt", async () => {
    execaMock.mockResolvedValue({
      exitCode: 1,
      all: "agent crashed"
    });

    const runner = new CodeContainerRunner("/tmp/workspace", new Logger(false), false);

    let error: Error | undefined;
    try {
      await runner.runPrompt({
        containerRoot: "/tmp/workspace",
        targetPath: "/tmp/workspace/steps/1/candidates/2",
        prompt: "very sensitive prompt body",
        label: "Candidate 2 generation for step 1",
        harness: "claude"
      });
    } catch (thrown) {
      error = thrown as Error;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(
      "Container command failed for Candidate 2 generation for step 1 with exit code 1."
    );
    expect(error?.message).toContain("Output:\nagent crashed");
    expect(error?.message).toContain("[prompt omitted]");
    expect(error?.message).not.toContain("very sensitive prompt body");
  });

  it("retries transient Claude generation failures", async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 1,
        all: "[ERROR] Unexpected end of JSON input"
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        all: "ok"
      });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const runner = new CodeContainerRunner("/tmp/workspace", new Logger(false), false);

      await runner.runPrompt({
        containerRoot: "/tmp/workspace",
        targetPath: "/tmp/workspace/steps/1/candidates/1",
        prompt: "Generate",
        label: "Candidate 1 generation for step 5",
        harness: "claude"
      });

      expect(execaMock).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(
        "Retrying Candidate 1 generation for step 5 after transient Claude CLI failure (1/3)."
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not retry transient Claude failures for mutation runs", async () => {
    execaMock.mockResolvedValue({
      exitCode: 1,
      all: "[ERROR] Unexpected end of JSON input"
    });

    const runner = new CodeContainerRunner("/tmp/workspace", new Logger(false), false);

    await expect(
      runner.runPrompt({
        containerRoot: "/tmp/workspace",
        targetPath: "/tmp/workspace/skills",
        prompt: "Mutate",
        label: "Skill mutation for step 5",
        harness: "claude"
      })
    ).rejects.toThrow(
      "Container command failed for Skill mutation for step 5 with exit code 1."
    );

    expect(execaMock).toHaveBeenCalledTimes(1);
  });

  it("prefixes streamed debug generation output with the target path", async () => {
    const all = new PassThrough();
    const result = Promise.resolve({
      exitCode: 0,
      all: '{"type":"message"}\n{"type":"result"}'
    });
    const subprocess = Object.assign(result, { all });
    execaMock.mockReturnValue(subprocess);

    const originalDebugGeneration = process.env.DEBUG_GENERATION;
    process.env.DEBUG_GENERATION = "1";

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const runner = new CodeContainerRunner("/tmp/workspace", new Logger(false), false);
      const runPromise = runner.runPrompt({
        containerRoot: "/tmp/workspace",
        targetPath: "/tmp/workspace/steps/1/candidates/0",
        prompt: "Generate",
        label: "Candidate 0 generation for step 1",
        harness: "claude"
      });

      all.write('{"type":"message"}\n{"type":"result"}');
      all.end();

      await runPromise;

      expect(consoleLogSpy).toHaveBeenCalledWith(
        "[phase] Candidate 0 generation for step 1"
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        'steps/1/candidates/0 {"type":"message"}'
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        'steps/1/candidates/0 {"type":"result"}'
      );
    } finally {
      if (originalDebugGeneration === undefined) {
        delete process.env.DEBUG_GENERATION;
      } else {
        process.env.DEBUG_GENERATION = originalDebugGeneration;
      }
      consoleLogSpy.mockRestore();
    }
  });

  it("prefixes streamed debug generation output with the sandbox target name when outside the workspace", async () => {
    const all = new PassThrough();
    const result = Promise.resolve({
      exitCode: 0,
      all: '{"type":"message"}\n{"type":"result"}'
    });
    const subprocess = Object.assign(result, { all });
    execaMock.mockReturnValue(subprocess);

    const originalDebugGeneration = process.env.DEBUG_GENERATION;
    process.env.DEBUG_GENERATION = "1";

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const runner = new CodeContainerRunner("/tmp/workspace", new Logger(false), false);
      const runPromise = runner.runPrompt({
        containerRoot: "/private/tmp/skill-autoresearch-generation-123/artifact",
        targetPath: "/private/tmp/skill-autoresearch-generation-123/artifact",
        prompt: "Generate",
        label: "Baseline generation",
        harness: "claude"
      });

      all.write('{"type":"message"}\n{"type":"result"}');
      all.end();

      await runPromise;

      expect(consoleLogSpy).toHaveBeenCalledWith("[phase] Baseline generation");
      expect(consoleLogSpy).toHaveBeenCalledWith(
        'artifact {"type":"message"}'
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        'artifact {"type":"result"}'
      );
    } finally {
      if (originalDebugGeneration === undefined) {
        delete process.env.DEBUG_GENERATION;
      } else {
        process.env.DEBUG_GENERATION = originalDebugGeneration;
      }
      consoleLogSpy.mockRestore();
    }
  });
});
