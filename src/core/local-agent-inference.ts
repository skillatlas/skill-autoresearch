import dotenv from "dotenv";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

export type LocalAgent = "claude" | "codex";

function getCodexAuthPath(): string {
  return path.join(
    os.homedir(),
    ".code-container",
    "configs",
    "codex",
    "auth.json"
  );
}

function getNonEmptyValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

async function loadWorkspaceEnvValues(
  workspaceRoot: string
): Promise<Record<string, string>> {
  const envPath = path.join(workspaceRoot, ".env");
  if (!(await fs.pathExists(envPath))) {
    return {};
  }

  return dotenv.parse(await fs.readFile(envPath, "utf8"));
}

async function hasCodexAccessToken(): Promise<{ found: boolean; issue?: string }> {
  const codexAuthPath = getCodexAuthPath();

  if (!(await fs.pathExists(codexAuthPath))) {
    return { found: false };
  }

  try {
    const raw = await fs.readFile(codexAuthPath, "utf8");
    const parsed = JSON.parse(raw) as {
      tokens?: { access_token?: unknown };
    };

    return {
      found: getNonEmptyValue(parsed.tokens?.access_token) !== undefined
    };
  } catch (error) {
    return {
      found: false,
      issue:
        error instanceof Error
          ? `Unable to parse ${codexAuthPath}: ${error.message}`
          : `Unable to parse ${codexAuthPath}.`
    };
  }
}

export async function inferLocalAgent(workspaceRoot: string): Promise<LocalAgent> {
  const workspaceEnv = await loadWorkspaceEnvValues(workspaceRoot);

  if (getNonEmptyValue(process.env.CLAUDE_CODE_OAUTH_TOKEN)) {
    return "claude";
  }

  if (getNonEmptyValue(workspaceEnv.CLAUDE_CODE_OAUTH_TOKEN)) {
    return "claude";
  }

  if (getNonEmptyValue(process.env.ANTHROPIC_API_KEY)) {
    return "claude";
  }

  if (getNonEmptyValue(workspaceEnv.ANTHROPIC_API_KEY)) {
    return "claude";
  }

  const codexAuth = await hasCodexAccessToken();
  if (codexAuth.found) {
    return "codex";
  }

  if (getNonEmptyValue(process.env.OPENAI_API_KEY)) {
    return "codex";
  }

  if (getNonEmptyValue(workspaceEnv.OPENAI_API_KEY)) {
    return "codex";
  }

  throw new Error(
    [
      "Unable to infer a local agent. Add `provider` to INSTRUCTIONS.md, GENERATION.md, or RUBRIC.md, or configure one of:",
      "`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `~/.code-container/configs/codex/auth.json`, `OPENAI_API_KEY`.",
      codexAuth.issue
    ]
      .filter((value) => value != null)
      .join(" ")
  );
}
