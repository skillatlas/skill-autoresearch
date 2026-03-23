import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

import { inferLocalAgent } from "../src/core/local-agent-inference.js";

const INFERENCE_ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "HOME"
] as const;

async function withIsolatedInferenceEnv<T>(callback: (workspaceRoot: string) => Promise<T>) {
  const previousEnv = Object.fromEntries(
    INFERENCE_ENV_KEYS.map((key) => [key, process.env[key]])
  ) as Record<(typeof INFERENCE_ENV_KEYS)[number], string | undefined>;
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-inference-"));
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-home-"));

  for (const key of INFERENCE_ENV_KEYS) {
    delete process.env[key];
  }
  process.env.HOME = homeDir;

  try {
    return await callback(workspaceRoot);
  } finally {
    for (const key of INFERENCE_ENV_KEYS) {
      const previousValue = previousEnv[key];
      if (previousValue == null) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
  }
}

describe("local agent inference", () => {
  it("prefers Claude credentials over Codex credentials", async () => {
    await withIsolatedInferenceEnv(async (workspaceRoot) => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "claude-token";
      process.env.OPENAI_API_KEY = "openai-key";

      expect(await inferLocalAgent(workspaceRoot)).toBe("claude");
    });
  });

  it("uses ANTHROPIC_API_KEY from the workspace .env when Claude auth token is absent", async () => {
    await withIsolatedInferenceEnv(async (workspaceRoot) => {
      await fs.writeFile(
        path.join(workspaceRoot, ".env"),
        "ANTHROPIC_API_KEY=anthropic-key\n",
        "utf8"
      );

      expect(await inferLocalAgent(workspaceRoot)).toBe("claude");
    });
  });

  it("uses Codex auth.json when present", async () => {
    await withIsolatedInferenceEnv(async (workspaceRoot) => {
      const authPath = path.join(
        process.env.HOME!,
        ".code-container",
        "configs",
        "codex",
        "auth.json"
      );
      await fs.ensureDir(path.dirname(authPath));
      await fs.writeJson(authPath, { tokens: { access_token: "codex-token" } });

      expect(await inferLocalAgent(workspaceRoot)).toBe("codex");
    });
  });

  it("uses OPENAI_API_KEY from the workspace .env when earlier checks fail", async () => {
    await withIsolatedInferenceEnv(async (workspaceRoot) => {
      await fs.writeFile(
        path.join(workspaceRoot, ".env"),
        "OPENAI_API_KEY=workspace-openai-key\n",
        "utf8"
      );

      expect(await inferLocalAgent(workspaceRoot)).toBe("codex");
    });
  });

  it("throws when no local agent can be inferred", async () => {
    await withIsolatedInferenceEnv(async (workspaceRoot) => {
      await expect(inferLocalAgent(workspaceRoot)).rejects.toThrow(
        "Unable to infer a local agent."
      );
    });
  });
});
