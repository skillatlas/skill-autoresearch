import fs from "fs-extra";
import matter from "gray-matter";
import { z } from "zod";

import {
  NormalizedRubric,
  normalizedRubricSchema,
  rubricCommandSchema
} from "../types/rubric.js";

const rawRubricFrontmatterSchema = z
  .object({
    model: z.string().min(1),
    outputType: z.enum(["text", "image"]),
    command: z.string().min(1).optional(),
    resultPath: z.string().min(1).optional(),
    commands: z.union([rubricCommandSchema, z.array(rubricCommandSchema).min(1)]).optional()
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

  const commands = frontmatter.commands
    ? Array.isArray(frontmatter.commands)
      ? frontmatter.commands
      : [frontmatter.commands]
    : [
        {
          command: frontmatter.command!,
          resultPath: frontmatter.resultPath
        }
      ];

  if (
    frontmatter.outputType === "image" &&
    commands.some((command) => !command.resultPath)
  ) {
    throw new Error("Image rubric commands must define `resultPath`.");
  }

  return normalizedRubricSchema.parse({
    sourcePath: rubricPath,
    modelId: frontmatter.model,
    outputType: frontmatter.outputType,
    commands,
    prompt
  });
}
