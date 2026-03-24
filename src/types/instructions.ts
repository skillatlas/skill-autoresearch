import { z } from "zod";

import { generationProviderSchema } from "./generation.js";

export const instructionsSpecSchema = z.object({
  sourcePath: z.string(),
  provider: generationProviderSchema,
  modelId: z.string().min(1).optional(),
  prompt: z.string().min(1)
});

export type InstructionsSpec = z.infer<typeof instructionsSpecSchema>;
