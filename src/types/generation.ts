import { z } from "zod";

export const generationProviderSchema = z.enum(["claude", "codex"]);

export const generationSpecSchema = z.object({
  sourcePath: z.string(),
  fileName: z.string().min(1),
  provider: generationProviderSchema,
  modelId: z.string().min(1).optional(),
  prompt: z.string().min(1)
});

export type GenerationProvider = z.infer<typeof generationProviderSchema>;
export type GenerationSpec = z.infer<typeof generationSpecSchema>;
