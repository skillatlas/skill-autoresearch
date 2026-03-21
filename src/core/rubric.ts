import fs from "fs-extra";
import matter from "gray-matter";
import { z } from "zod";

import {
  NormalizedRubric,
  normalizedRubricSchema,
  evidenceOutputTypeSchema
} from "../types/rubric.js";

const rawRubricCommandSchema = z.object({
  outputType: evidenceOutputTypeSchema.optional(),
  command: z.string().min(1),
  resultPath: z.string().min(1).optional()
});

const rawRubricFrontmatterSchema = z
  .object({
    provider: z.enum(["openrouter", "codex"]),
    model: z.string().min(1),
    outputType: evidenceOutputTypeSchema.optional(),
    command: z.string().min(1).optional(),
    resultPath: z.string().min(1).optional(),
    commands: z
      .union([rawRubricCommandSchema, z.array(rawRubricCommandSchema).min(1)])
      .optional()
  })
  .superRefine((value, ctx) => {
    if (!value.command && !value.commands) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Rubric frontmatter must contain either `command` or `commands`."
      });
    }

    if (value.command && value.commands) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Rubric frontmatter cannot contain both `command` and `commands`."
      });
    }

    if (!value.command && value.resultPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`resultPath` requires a matching top-level `command`."
      });
    }

    if (value.command && !value.outputType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Top-level `command` requires a matching top-level `outputType`."
      });
    }

    const commands = value.commands
      ? Array.isArray(value.commands)
        ? value.commands
        : [value.commands]
      : [];

    if (
      !value.outputType &&
      commands.some((command) => command.outputType === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Each rubric command must define `outputType` when no top-level `outputType` is set."
      });
    }
  });

export function interpolateStepPath(
  template: string,
  stepPath: string
): string {
  return template.replaceAll("$STEP_PATH", stepPath);
}

export async function loadRubric(rubricPath: string): Promise<NormalizedRubric> {
  const rawRubric = await fs.readFile(rubricPath, "utf8");
  const parsed = matter(rawRubric);
  const frontmatter = rawRubricFrontmatterSchema.parse(parsed.data);
  const prompt = parsed.content.trim();

  if (prompt.length === 0) {
    throw new Error("Rubric body must not be empty.");
  }

  const rawCommands = frontmatter.commands
    ? Array.isArray(frontmatter.commands)
      ? frontmatter.commands
      : [frontmatter.commands]
    : [
        {
          outputType: frontmatter.outputType,
          command: frontmatter.command!,
          resultPath: frontmatter.resultPath
        }
      ];

  const commands = rawCommands.map((commandDefinition) => ({
    outputType: commandDefinition.outputType ?? frontmatter.outputType!,
    command: commandDefinition.command,
    resultPath: commandDefinition.resultPath
  }));

  if (commands.some((command) => command.outputType === "image" && !command.resultPath)) {
    throw new Error("Image rubric commands must define `resultPath`.");
  }

  return normalizedRubricSchema.parse({
    sourcePath: rubricPath,
    provider: frontmatter.provider,
    modelId: frontmatter.model,
    commands,
    prompt
  });
}
