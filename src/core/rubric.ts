import fs from "fs-extra";
import matter from "gray-matter";
import path from "node:path";
import { z } from "zod";

import { inferLocalAgent } from "./local-agent-inference.js";
import {
  NormalizedRubric,
  normalizedRubricSchema,
  evidenceOutputTypeSchema,
  rubricHttpServerSchema
} from "../types/rubric.js";

const rawRubricCommandSchema = z.object({
  outputType: evidenceOutputTypeSchema.optional(),
  command: z.string().min(1).optional(),
  resultPath: z.string().min(1).optional()
});

const rawRubricFrontmatterSchema = z.object({
  provider: z.enum(["openrouter", "codex", "claude"]).optional(),
  model: z.string().min(1).optional(),
  http_server: rubricHttpServerSchema.optional(),
  outputType: evidenceOutputTypeSchema.optional(),
  command: z.string().min(1).optional(),
  resultPath: z.string().min(1).optional(),
  commands: z
    .union([rawRubricCommandSchema, z.array(rawRubricCommandSchema).min(1)])
    .optional()
});

function normalizeRubricCommands(input: {
  provider: NormalizedRubric["provider"];
  outputType?: NormalizedRubric["commands"][number]["outputType"];
  command?: string;
  resultPath?: string;
  commands?:
    | z.infer<typeof rawRubricCommandSchema>
    | Array<z.infer<typeof rawRubricCommandSchema>>;
}): NormalizedRubric["commands"] {
  if ((input.command || input.resultPath) && input.commands) {
    throw new Error(
      "Rubric frontmatter cannot combine top-level `command`/`resultPath` with `commands`."
    );
  }

  const rawCommands = input.commands
    ? Array.isArray(input.commands)
      ? input.commands
      : [input.commands]
    : input.command || input.resultPath || input.outputType
      ? [
          {
            outputType: input.outputType,
            command: input.command,
            resultPath: input.resultPath
          }
        ]
      : [];

  if (input.provider === "openrouter" && rawCommands.length === 0) {
    throw new Error(
      "Rubric frontmatter must contain `resultPath` or `commands` when `provider` is `openrouter`."
    );
  }

  if (!input.commands && input.resultPath && !input.outputType) {
    throw new Error("Top-level `resultPath` requires a matching top-level `outputType`.");
  }

  if (
    !input.outputType &&
    rawCommands.some(
      (command) => command.resultPath !== undefined && command.outputType === undefined
    )
  ) {
    throw new Error(
      "Each rubric command must define `outputType` when no top-level `outputType` is set."
    );
  }

  if (
    input.provider === "openrouter" &&
    rawCommands.some((command) => command.resultPath === undefined)
  ) {
    throw new Error(
      "Each rubric command must define `resultPath` when `provider` is `openrouter`."
    );
  }

  return rawCommands.map((commandDefinition) => ({
    outputType:
      commandDefinition.resultPath === undefined
        ? undefined
        : commandDefinition.outputType ?? input.outputType,
    command: commandDefinition.command,
    resultPath: commandDefinition.resultPath
  }));
}

export function interpolateStepPath(
  template: string,
  stepPath: string
): string {
  return interpolateRubricVariables(template, { stepPath });
}

export function interpolateRubricVariables(
  template: string,
  input: {
    stepPath: string;
    stepOrigin?: string;
  }
): string {
  let output = template.replaceAll("$STEP_PATH", input.stepPath);
  if (input.stepOrigin) {
    output = output.replaceAll("$STEP_ORIGIN", input.stepOrigin);
  }

  return output;
}

export async function loadRubric(rubricPath: string): Promise<NormalizedRubric> {
  const rawRubric = await fs.readFile(rubricPath, "utf8");
  const parsed = matter(rawRubric);
  const frontmatter = rawRubricFrontmatterSchema.parse(parsed.data);
  const prompt = parsed.content.trim();
  const provider =
    frontmatter.provider ?? (await inferLocalAgent(path.dirname(rubricPath)));

  if (provider === "openrouter" && frontmatter.model === undefined) {
    throw new Error(
      "Rubric frontmatter must contain `model` when `provider` is `openrouter`."
    );
  }

  if (prompt.length === 0) {
    throw new Error("Rubric body must not be empty.");
  }

  const commands = normalizeRubricCommands({
    provider,
    outputType: frontmatter.outputType,
    command: frontmatter.command,
    resultPath: frontmatter.resultPath,
    commands: frontmatter.commands
  });

  return normalizedRubricSchema.parse({
    sourcePath: rubricPath,
    provider,
    modelId: frontmatter.model,
    httpServerPort:
      frontmatter.http_server === true
        ? 0
        : typeof frontmatter.http_server === "number"
          ? frontmatter.http_server
          : undefined,
    commands,
    prompt
  });
}
