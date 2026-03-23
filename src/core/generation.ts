import fs from "fs-extra";
import matter from "gray-matter";
import path from "node:path";
import { z } from "zod";

import { inferLocalAgent } from "./local-agent-inference.js";
import {
  GenerationSpec,
  generationProviderSchema,
  generationSpecSchema
} from "../types/generation.js";

const generationFrontmatterSchema = z.object({
  provider: generationProviderSchema.optional(),
  model: z.string().min(1).optional()
});

const generationFilePattern = /^GENERATION(?:(\d+))?\.md$/;

function compareGenerationFileNames(left: string, right: string): number {
  const leftMatch = left.match(generationFilePattern);
  const rightMatch = right.match(generationFilePattern);

  if (!leftMatch || !rightMatch) {
    return left.localeCompare(right);
  }

  const leftNumber = leftMatch[1] == null ? 0 : Number.parseInt(leftMatch[1], 10);
  const rightNumber = rightMatch[1] == null ? 0 : Number.parseInt(rightMatch[1], 10);
  if (leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }

  return left.localeCompare(right);
}

export async function findGenerationPaths(workspaceRoot: string): Promise<string[]> {
  const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && generationFilePattern.test(entry.name))
    .map((entry) => path.join(workspaceRoot, entry.name))
    .sort((left, right) =>
      compareGenerationFileNames(path.basename(left), path.basename(right))
    );
}

export async function loadGeneration(
  generationPath: string
): Promise<GenerationSpec> {
  const rawGeneration = await fs.readFile(generationPath, "utf8");
  const parsed = matter(rawGeneration);
  const frontmatter = generationFrontmatterSchema.parse(parsed.data);
  const prompt = parsed.content.trim();
  const provider =
    frontmatter.provider ?? (await inferLocalAgent(path.dirname(generationPath)));

  if (prompt.length === 0) {
    throw new Error("Generation body must not be empty.");
  }

  return generationSpecSchema.parse({
    sourcePath: generationPath,
    fileName: path.basename(generationPath),
    provider,
    modelId: frontmatter.model,
    prompt
  });
}

export async function loadGenerations(
  workspaceRoot: string
): Promise<GenerationSpec[]> {
  const generationPaths = await findGenerationPaths(workspaceRoot);
  if (generationPaths.length === 0) {
    throw new Error(
      `Missing generation prompt. Add GENERATION.md or numbered files such as GENERATION1.md to ${workspaceRoot}.`
    );
  }

  return Promise.all(generationPaths.map((generationPath) => loadGeneration(generationPath)));
}

export function getGenerationArtifactSubdir(spec: GenerationSpec): string {
  return path.parse(spec.fileName).name;
}
