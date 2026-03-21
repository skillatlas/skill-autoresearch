import fs from "fs-extra";
import matter from "gray-matter";
import { z } from "zod";

import {
  GenerationSpec,
  generationHarnessSchema,
  generationSpecSchema
} from "../types/generation.js";

const generationFrontmatterSchema = z.object({
  harness: generationHarnessSchema
});

export async function loadGeneration(
  generationPath: string
): Promise<GenerationSpec> {
  const rawGeneration = await fs.readFile(generationPath, "utf8");
  const parsed = matter(rawGeneration);
  const frontmatter = generationFrontmatterSchema.parse(parsed.data);
  const prompt = parsed.content.trim();

  if (prompt.length === 0) {
    throw new Error("Generation body must not be empty.");
  }

  return generationSpecSchema.parse({
    sourcePath: generationPath,
    harness: frontmatter.harness,
    prompt
  });
}
