import { z } from "zod";

export const generationHarnessSchema = z.enum(["claude", "codex"]);

export const generationSpecSchema = z.object({
  sourcePath: z.string(),
  fileName: z.string().min(1),
  harness: generationHarnessSchema,
  prompt: z.string().min(1)
});

export type GenerationHarness = z.infer<typeof generationHarnessSchema>;
export type GenerationSpec = z.infer<typeof generationSpecSchema>;
