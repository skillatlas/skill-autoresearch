import fs from "fs-extra";
import { generateObject } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import dotenv from "dotenv";
import { execaCommand } from "execa";
import path from "node:path";

import { Logger } from "./logger.js";
import { interpolateStepPath, loadRubric } from "./rubric.js";
import {
  ActiveCandidate,
  CandidateComparison,
  VoteRecord
} from "../types/state.js";
import {
  EvidenceItem,
  NormalizedRubric,
  ScoreVote,
  scoreVoteSchema
} from "../types/rubric.js";

function averageConfidence(votes: ReadonlyArray<ScoreVote | VoteRecord>): number {
  if (votes.length === 0) {
    return 0;
  }

  const total = votes.reduce((sum, vote) => sum + vote.confidence, 0);
  return total / votes.length;
}

function inferImageMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      throw new Error(`Unsupported image evidence type for ${filePath}.`);
  }
}

function assertImageBytesMatchMimeType(
  filePath: string,
  mimeType: string,
  bytes: Buffer
): void {
  const matchesFormat =
    (mimeType === "image/png" &&
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )) ||
    (mimeType === "image/jpeg" &&
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff) ||
    (mimeType === "image/gif" &&
      bytes.length >= 6 &&
      (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
        bytes.subarray(0, 6).toString("ascii") === "GIF89a")) ||
    (mimeType === "image/webp" &&
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP");

  if (!matchesFormat) {
    throw new Error(
      `Image evidence at ${filePath} does not match the expected ${mimeType} format.`
    );
  }
}

export function summarizeVotes(
  votes: ReadonlyArray<ScoreVote | VoteRecord>
): CandidateComparison {
  const aVotes = votes.filter((vote) => vote.winner === "A").length;
  const bVotes = votes.filter((vote) => vote.winner === "B").length;

  return {
    aVotes,
    bVotes,
    averageConfidence: averageConfidence(votes),
    isWinner: bVotes > votes.length / 2
  };
}

export function selectBestWinningCandidate(
  candidates: ReadonlyArray<ActiveCandidate>
): ActiveCandidate | undefined {
  return [...candidates]
    .filter((candidate) => candidate.comparison?.isWinner)
    .sort((left, right) => {
      const leftComparison = left.comparison!;
      const rightComparison = right.comparison!;

      if (leftComparison.bVotes !== rightComparison.bVotes) {
        return rightComparison.bVotes - leftComparison.bVotes;
      }

      if (leftComparison.averageConfidence !== rightComparison.averageConfidence) {
        return rightComparison.averageConfidence - leftComparison.averageConfidence;
      }

      return left.index - right.index;
    })[0];
}

export function loadWorkspaceEnv(envPath: string): void {
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing required environment file: ${envPath}`);
  }

  dotenv.config({ path: envPath, override: true });

  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("Missing OPENROUTER_API_KEY in workspace .env.");
  }
}

export interface VoteJudge {
  generateVote(input: {
    modelId: string;
    rubricPrompt: string;
    incumbentEvidence: EvidenceItem[];
    candidateEvidence: EvidenceItem[];
  }): Promise<ScoreVote>;
}

export interface ScoringService {
  loadRubric(rubricPath: string): Promise<NormalizedRubric>;
  collectEvidence(rubric: NormalizedRubric, stepPath: string): Promise<EvidenceItem[]>;
  runSingleVote(input: {
    modelId: string;
    rubricPrompt: string;
    incumbentEvidence: EvidenceItem[];
    candidateEvidence: EvidenceItem[];
  }): Promise<ScoreVote>;
}

export class OpenRouterVoteJudge implements VoteJudge {
  public async generateVote(input: {
    modelId: string;
    rubricPrompt: string;
    incumbentEvidence: EvidenceItem[];
    candidateEvidence: EvidenceItem[];
  }): Promise<ScoreVote> {
    const result = await generateObject({
      model: openrouter(input.modelId),
      system: input.rubricPrompt,
      schema: scoreVoteSchema,
      messages: [
        this.buildEvidenceMessage("Candidate A", input.incumbentEvidence),
        this.buildEvidenceMessage("Candidate B", input.candidateEvidence)
      ]
    });

    return result.object;
  }

  private buildEvidenceMessage(label: string, evidence: EvidenceItem[]) {
    if (evidence.length === 0) {
      throw new Error(`${label} evidence was empty.`);
    }

    if (evidence.every((item) => item.outputType === "text")) {
      const textBody = evidence
        .map((item, index) => `Evidence ${index + 1} (${item.label}):\n${item.content}`)
        .join("\n\n");

      return {
        role: "user" as const,
        content: `${label} evidence:\n\n${textBody}`
      };
    }

    const content: Array<
      | { type: "text"; text: string }
      | { type: "image"; image: Buffer }
    > = [
      {
        type: "text",
        text: `${label} evidence. Judge this candidate only from the attached images and any labels provided.`
      }
    ];

    for (const [index, item] of evidence.entries()) {
      if (item.outputType !== "image") {
        throw new Error("Mixed evidence types are not supported in a single message.");
      }

      content.push({
        type: "text",
        text: `Evidence ${index + 1} (${item.label})`
      });
      content.push({
        type: "image",
        image: item.bytes
      });
    }

    return {
      role: "user" as const,
      content
    };
  }
}

export class Scorer {
  public constructor(
    private readonly workspaceRoot: string,
    private readonly logger: Logger,
    private readonly judge: VoteJudge,
    private readonly verbose: boolean
  ) {}

  public async loadRubric(rubricPath: string): Promise<NormalizedRubric> {
    return loadRubric(rubricPath);
  }

  public async collectEvidence(
    rubric: NormalizedRubric,
    stepPath: string
  ): Promise<EvidenceItem[]> {
    const resolvedStepPath = path.resolve(this.workspaceRoot, stepPath);
    const evidence: EvidenceItem[] = [];

    for (const [index, commandDefinition] of rubric.commands.entries()) {
      const command = interpolateStepPath(commandDefinition.command, resolvedStepPath);
      if (this.verbose) {
        this.logger.debug(`Executing rubric command: ${command}`);
      }

      const result = await execaCommand(command, {
        cwd: this.workspaceRoot,
        env: {
          ...process.env,
          STEP_PATH: resolvedStepPath
        },
        all: true,
        reject: false,
        shell: true
      });

      if (this.verbose && result.all?.trim()) {
        this.logger.debug(result.all);
      }

      if (result.exitCode !== 0) {
        throw new Error(
          `Rubric command failed for ${stepPath} with exit code ${result.exitCode}.`
        );
      }

      const label = `command-${index + 1}`;
      if (rubric.outputType === "text") {
        const textEvidence = await this.readTextEvidence(
          commandDefinition.resultPath,
          resolvedStepPath,
          result.stdout
        );
        evidence.push({
          outputType: "text",
          label,
          content: textEvidence
        });
        continue;
      }

      if (!commandDefinition.resultPath) {
        throw new Error("Image rubric commands must define `resultPath`.");
      }

      const imagePath = path.resolve(
        this.workspaceRoot,
        interpolateStepPath(commandDefinition.resultPath, resolvedStepPath)
      );
      const bytes = await fs.readFile(imagePath);
      if (bytes.length === 0) {
        throw new Error(`Image evidence is empty: ${imagePath}`);
      }
      const mimeType = inferImageMimeType(imagePath);
      assertImageBytesMatchMimeType(imagePath, mimeType, bytes);

      evidence.push({
        outputType: "image",
        label,
        path: imagePath,
        mimeType,
        bytes
      });
    }

    if (evidence.length === 0) {
      throw new Error(`No evidence collected for ${stepPath}.`);
    }

    return evidence;
  }

  public async runVoteSeries(input: {
    modelId: string;
    rubricPrompt: string;
    incumbentEvidence: EvidenceItem[];
    candidateEvidence: EvidenceItem[];
    voteCount: number;
    existingVotes?: VoteRecord[];
  }): Promise<{ votes: VoteRecord[]; comparison: CandidateComparison }> {
    const votes = [...(input.existingVotes ?? [])];

    for (let attempt = votes.length; attempt < input.voteCount; attempt += 1) {
      const vote = await this.judge.generateVote({
        modelId: input.modelId,
        rubricPrompt: input.rubricPrompt,
        incumbentEvidence: input.incumbentEvidence,
        candidateEvidence: input.candidateEvidence
      });

      votes.push({
        attempt,
        winner: vote.winner,
        confidence: vote.confidence,
        rationale: vote.rationale
      });
    }

    return {
      votes,
      comparison: summarizeVotes(votes)
    };
  }

  public async runSingleVote(input: {
    modelId: string;
    rubricPrompt: string;
    incumbentEvidence: EvidenceItem[];
    candidateEvidence: EvidenceItem[];
  }): Promise<ScoreVote> {
    return this.judge.generateVote(input);
  }

  private async readTextEvidence(
    resultPath: string | undefined,
    resolvedStepPath: string,
    stdout: string
  ): Promise<string> {
    if (resultPath) {
      const filePath = path.resolve(
        this.workspaceRoot,
        interpolateStepPath(resultPath, resolvedStepPath)
      );
      const content = (await fs.readFile(filePath, "utf8")).trim();
      if (content.length === 0) {
        throw new Error(`Text evidence is empty: ${filePath}`);
      }

      return content;
    }

    const trimmedStdout = stdout.trim();
    if (trimmedStdout.length === 0) {
      throw new Error(`Text evidence command returned empty output for ${resolvedStepPath}.`);
    }

    return trimmedStdout;
  }
}
