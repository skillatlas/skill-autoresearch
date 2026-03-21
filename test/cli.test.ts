import { formatErrorForCli } from "../src/core/error-format.js";

describe("CLI error formatting", () => {
  it("prefers stack traces when formatting errors", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at example (file.ts:1:1)";

    expect(formatErrorForCli(error)).toBe(error.stack);
  });

  it("falls back to string coercion for non-Error values", () => {
    expect(formatErrorForCli("boom")).toBe("boom");
  });
});
