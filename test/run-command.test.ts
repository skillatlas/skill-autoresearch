import path from "node:path";
import { InvalidArgumentError } from "commander";

import {
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
});
