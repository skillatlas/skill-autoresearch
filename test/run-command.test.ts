import path from "node:path";
import { InvalidArgumentError } from "commander";

import {
  buildRunCommand,
  normalizeRunCliOptions,
  resolveWorkspaceRoot
} from "../src/commands/run.js";

describe("run command workspace resolution", () => {
  it("defaults the workspace root to the invocation directory", () => {
    expect(resolveWorkspaceRoot(undefined, "/tmp/workspace")).toBe("/tmp/workspace");
    expect(resolveWorkspaceRoot(".", "/tmp/workspace")).toBe("/tmp/workspace");
  });

  it("resolves relative workspace paths from the invocation directory", () => {
    expect(resolveWorkspaceRoot("nested/project", "/tmp/workspace")).toBe(
      path.join("/tmp/workspace", "nested", "project")
    );
  });

  it("preserves absolute workspace paths", () => {
    expect(resolveWorkspaceRoot("/tmp/custom-workspace", "/tmp/workspace")).toBe(
      "/tmp/custom-workspace"
    );
  });

  it("defaults human scoring to one vote when the CLI vote value is unchanged", () => {
    expect(
      normalizeRunCliOptions(
        {
          candidates: 3,
          votes: 3,
          minSteps: 0,
          maxSteps: 20,
          resume: false,
          dryRun: false,
          verbose: false,
          scoringMode: "human"
        },
        { votes: "default" }
      ).votes
    ).toBe(1);
  });

  it("defaults max steps to twenty when the CLI value is unchanged", () => {
    expect(
      normalizeRunCliOptions(
        {
          candidates: 3,
          votes: 3,
          minSteps: 0,
          resume: false,
          dryRun: false,
          verbose: false,
          scoringMode: "rubric"
        },
        { maxSteps: "default" }
      ).maxSteps
    ).toBe(20);
  });

  it("disables max steps when the CLI passes zero", () => {
    expect(
      normalizeRunCliOptions({
        candidates: 3,
        votes: 3,
        minSteps: 0,
        maxSteps: 0,
        resume: false,
        dryRun: false,
        verbose: false,
        scoringMode: "rubric"
      }).maxSteps
    ).toBeUndefined();
  });

  it("disables max steps when the CLI flag is passed without a value", () => {
    expect(
      normalizeRunCliOptions({
        candidates: 3,
        votes: 3,
        minSteps: 0,
        maxSteps: true,
        resume: false,
        dryRun: false,
        verbose: false,
        scoringMode: "rubric"
      }).maxSteps
    ).toBeUndefined();
  });

  it("parses --max-steps without consuming the workspace argument", async () => {
    const command = buildRunCommand();
    let parsedWorkspace: string | undefined;
    let parsedOptions:
      | ReturnType<typeof normalizeRunCliOptions>
      | undefined;

    command.action((workspaceArg, rawOptions) => {
      parsedWorkspace = workspaceArg;
      parsedOptions = normalizeRunCliOptions(rawOptions);
    });

    await command.parseAsync(["node", "script", "demo-workspace", "--max-steps"], {
      from: "node"
    });

    expect(parsedWorkspace).toBe("demo-workspace");
    expect(parsedOptions?.maxSteps).toBeUndefined();
  });

  it("rejects model overrides in human scoring mode", () => {
    expect(() =>
      normalizeRunCliOptions({
        candidates: 3,
        votes: 1,
        minSteps: 0,
        maxSteps: 20,
        resume: false,
        dryRun: false,
        verbose: false,
        model: "test-model",
        scoringMode: "human"
      })
    ).toThrow(InvalidArgumentError);
  });

  it("keeps an explicit provider override", () => {
    expect(
      normalizeRunCliOptions({
        candidates: 3,
        votes: 3,
        minSteps: 0,
        maxSteps: 20,
        resume: false,
        dryRun: false,
        verbose: false,
        provider: "codex",
        scoringMode: "rubric"
      }).provider
    ).toBe("codex");
  });

  it("defaults skill diff evidence to enabled", () => {
    expect(
      normalizeRunCliOptions({
        candidates: 3,
        votes: 3,
        minSteps: 0,
        maxSteps: 20,
        resume: false,
        dryRun: false,
        verbose: false,
        scoringMode: "rubric"
      }).omitSkillDiff
    ).toBe(false);
  });

  it("parses --omit-skill-diff", async () => {
    const command = buildRunCommand();
    let parsedOptions:
      | ReturnType<typeof normalizeRunCliOptions>
      | undefined;

    command.action((_workspaceArg, rawOptions) => {
      parsedOptions = normalizeRunCliOptions(rawOptions);
    });

    await command.parseAsync(["node", "script", "--omit-skill-diff"], {
      from: "node"
    });

    expect(parsedOptions?.omitSkillDiff).toBe(true);
  });
});
