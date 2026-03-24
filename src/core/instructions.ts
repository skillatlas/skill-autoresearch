import fs from "fs-extra";
import matter from "gray-matter";
import path from "node:path";
import { z } from "zod";

import { inferLocalAgent } from "./local-agent-inference.js";
import {
  InstructionsSpec,
  instructionsSpecSchema
} from "../types/instructions.js";
import {
  GenerationProvider,
  generationProviderSchema
} from "../types/generation.js";

const instructionsFrontmatterSchema = z.object({
  provider: generationProviderSchema.optional(),
  model: z.string().min(1).optional()
});

export async function loadInstructions(
  instructionsPath: string,
  options?: { providerOverride?: GenerationProvider }
): Promise<InstructionsSpec> {
  const rawInstructions = await fs.readFile(instructionsPath, "utf8");
  const parsed = matter(rawInstructions);
  const frontmatter = instructionsFrontmatterSchema.parse(parsed.data);
  const prompt = parsed.content.trim();
  const provider =
    options?.providerOverride ??
    frontmatter.provider ??
    (await inferLocalAgent(path.dirname(instructionsPath)));

  if (prompt.length === 0) {
    throw new Error("Instructions body must not be empty.");
  }

  return instructionsSpecSchema.parse({
    sourcePath: instructionsPath,
    provider,
    modelId: frontmatter.model,
    prompt
  });
}
