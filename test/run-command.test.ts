import path from "node:path";

import { resolveWorkspaceRoot } from "../src/commands/run.js";

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
});
