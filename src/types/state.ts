import { z } from "zod";

export const runStatusSchema = z.enum([
  "idle",
  "running",
  "awaiting-score",
  "failed",
  "completed"
]);

export const scoringModeSchema = z.enum(["rubric", "human"]);

export const runPhaseSchema = z.enum([
  "generate-baseline",
  "snapshot",
  "mutate-skills",
  "generate-candidates",
  "score",
  "promote"
]);

export const candidateStatusSchema = z.enum([
  "pending",
  "generated",
  "scored",
  "accepted",
  "rejected"
]);

export const voteRecordSchema = z.object({
  attempt: z.number().int().nonnegative(),
  winner: z.enum(["A", "B"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string()
});

export const candidateComparisonSchema = z.object({
  aVotes: z.number().int().nonnegative(),
  bVotes: z.number().int().nonnegative(),
  averageConfidence: z.number().min(0).max(1),
  isWinner: z.boolean()
});

export const activeCandidateSchema = z.object({
  index: z.number().int().nonnegative(),
  path: z.string(),
  status: candidateStatusSchema,
  votes: z.array(voteRecordSchema),
  comparison: candidateComparisonSchema.optional()
});

export const historyEntrySchema = z.object({
  timestamp: z.string(),
  stepIndex: z.number().int().positive(),
  accepted: z.boolean(),
  incumbentPath: z.string(),
  promotedCandidateIndex: z.number().int().nonnegative().optional(),
  promotedCandidatePath: z.string().optional(),
  winningCandidateIndexes: z.array(z.number().int().nonnegative()),
  consecutiveRejections: z.number().int().nonnegative()
});

export const runStateSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  workspaceRoot: z.string(),
  scoringMode: scoringModeSchema.default("rubric"),
  status: runStatusSchema,
  stepIndex: z.number().int().nonnegative(),
  candidateCount: z.number().int().positive(),
  voteCount: z.number().int().positive(),
  minSteps: z.number().int().nonnegative(),
  maxSteps: z.number().int().nonnegative().optional(),
  stasisSteps: z.number().int().nonnegative().optional(),
  consecutiveRejections: z.number().int().nonnegative(),
  archivePath: z.string(),
  skillsOriginalPath: z.string(),
  skillsPreviousPath: z.string(),
  incumbentPath: z.string().optional(),
  modelOverride: z.string().nullable().optional(),
  currentPhase: runPhaseSchema,
  activeCandidates: z.array(activeCandidateSchema),
  history: z.array(historyEntrySchema),
  completedReason: z.enum(["max-steps", "stasis"]).optional()
});

export type RunStatus = z.infer<typeof runStatusSchema>;
export type ScoringMode = z.infer<typeof scoringModeSchema>;
export type RunPhase = z.infer<typeof runPhaseSchema>;
export type CandidateStatus = z.infer<typeof candidateStatusSchema>;
export type VoteRecord = z.infer<typeof voteRecordSchema>;
export type CandidateComparison = z.infer<typeof candidateComparisonSchema>;
export type ActiveCandidate = z.infer<typeof activeCandidateSchema>;
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type RunState = z.infer<typeof runStateSchema>;
