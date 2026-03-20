import { z } from "zod";

export const evidenceOutputTypeSchema = z.enum(["text", "image"]);

export const rubricCommandSchema = z.object({
  command: z.string().min(1, "Rubric command must be a non-empty string."),
  resultPath: z.string().min(1).optional()
});

export const normalizedRubricSchema = z.object({
  sourcePath: z.string(),
  modelId: z.string().min(1),
  outputType: evidenceOutputTypeSchema,
  commands: z.array(rubricCommandSchema).min(1),
  prompt: z.string().min(1)
});

export const scoreVoteSchema = z.object({
  winner: z.enum(["A", "B"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string()
});

export type EvidenceOutputType = z.infer<typeof evidenceOutputTypeSchema>;
export type RubricCommand = z.infer<typeof rubricCommandSchema>;
export type NormalizedRubric = z.infer<typeof normalizedRubricSchema>;
export type ScoreVote = z.infer<typeof scoreVoteSchema>;

export interface TextEvidenceItem {
  outputType: "text";
  label: string;
  content: string;
}

export interface ImageEvidenceItem {
  outputType: "image";
  label: string;
  path: string;
  mimeType: string;
  bytes: Buffer;
}

export type EvidenceItem = TextEvidenceItem | ImageEvidenceItem;
