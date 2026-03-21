import fs from "fs-extra";
import { generateObject } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import dotenv from "dotenv";
import { execa, execaCommand } from "execa";
import { createServer } from "node:http";
import path from "node:path";

import { formatCommandFailure } from "./error-format.js";
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
  ScoringProvider,
  ScoreVote,
  scoreVoteJsonSchema,
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

function isDebugScoreEnabled(): boolean {
  return process.env.DEBUG_SCORE === "1";
}

function serializeEvidenceForDebug(evidence: EvidenceItem[]) {
  return evidence.map((item) =>
    item.outputType === "text"
      ? {
          outputType: "text" as const,
          label: item.label,
          content: item.content
        }
      : {
          outputType: "image" as const,
          label: item.label,
          path: item.path,
          mimeType: item.mimeType,
          byteLength: item.bytes.length
        }
  );
}

function tokenizeShellCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const character of command) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping || quote) {
    return undefined;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function parsePlaywrightHtmlScreenshotCommand(command: string):
  | { inputPath: string; outputPath: string }
  | undefined {
  const tokens = tokenizeShellCommand(command);
  if (!tokens || tokens.length !== 4) {
    return undefined;
  }

  if (tokens[0] !== "playwright-cli") {
    return undefined;
  }

  if (tokens[1] !== "screenshot" && tokens[1] !== "serve-and-screenshot") {
    return undefined;
  }

  const inputPath = tokens[2];
  const outputPath = tokens[3];
  if (path.extname(inputPath).toLowerCase() !== ".html") {
    return undefined;
  }

  return {
    inputPath,
    outputPath
  };
}

function inferStaticContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
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
      return "application/octet-stream";
  }
}

async function startStaticFileServer(rootPath: string): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const normalizedRootPath = path.resolve(rootPath);
  const normalizedRootPrefix = `${normalizedRootPath}${path.sep}`;
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const rawRelativePath =
      requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
    const relativePath = path.normalize(decodeURIComponent(rawRelativePath));
    const targetPath = path.resolve(normalizedRootPath, relativePath);

    if (
      targetPath !== normalizedRootPath &&
      !targetPath.startsWith(normalizedRootPrefix)
    ) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }

    try {
      const stats = await fs.stat(targetPath);
      const filePath = stats.isDirectory() ? path.join(targetPath, "index.html") : targetPath;
      const bytes = await fs.readFile(filePath);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": inferStaticContentType(filePath)
      });
      response.end(bytes);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });

  const address = await new Promise<{
    address: string;
    port: number;
  }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const currentAddress = server.address();
      if (!currentAddress || typeof currentAddress === "string") {
        reject(new Error("Failed to determine screenshot server address."));
        return;
      }

      resolve({
        address: currentAddress.address,
        port: currentAddress.port
      });
    });
  });

  return {
    origin: `http://${address.address}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      })
  };
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

export function loadWorkspaceEnv(
  envPath: string,
  options: { scoringProvider?: ScoringProvider } = {}
): void {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true });
  }

  if (options.scoringProvider === "openrouter" && !process.env.OPENROUTER_API_KEY) {
    throw new Error("Missing OPENROUTER_API_KEY in workspace .env for OpenRouter scoring.");
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
    provider: ScoringProvider;
    modelId: string;
    rubricPrompt: string;
    incumbentEvidence: EvidenceItem[];
    candidateEvidence: EvidenceItem[];
  }): Promise<ScoreVote>;
}

export class OpenRouterVoteJudge implements VoteJudge {
  public constructor(private readonly logger: Logger) {}

  public async generateVote(input: {
    modelId: string;
    rubricPrompt: string;
    incumbentEvidence: EvidenceItem[];
    candidateEvidence: EvidenceItem[];
  }): Promise<ScoreVote> {
    const messages = [
      this.buildEvidenceMessage("Candidate A", input.incumbentEvidence),
      this.buildEvidenceMessage("Candidate B", input.candidateEvidence)
    ];
    this.logDebugInput(input, messages);

    const result = await generateObject({
      model: openrouter(input.modelId),
      system: input.rubricPrompt,
      schema: scoreVoteSchema,
      messages
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
        text: `${label} evidence. Judge this candidate only from the text excerpts, attached images, and labels provided.`
      }
    ];

    for (const [index, item] of evidence.entries()) {
      if (item.outputType === "text") {
        content.push({
          type: "text",
          text: `Evidence ${index + 1} (${item.label}):\n${item.content}`
        });
        continue;
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

  private logDebugInput(
    input: {
      modelId: string;
      rubricPrompt: string;
      incumbentEvidence: EvidenceItem[];
      candidateEvidence: EvidenceItem[];
    },
    messages: Array<
      | { role: "user"; content: string }
      | {
          role: "user";
          content: Array<
            | { type: "text"; text: string }
            | { type: "image"; image: Buffer }
          >;
        }
    >
  ): void {
    if (!isDebugScoreEnabled()) {
      return;
    }

    const payload = {
      provider: "openrouter" as const,
      modelId: input.modelId,
      system: input.rubricPrompt,
      messages: messages.map((message) => ({
        role: message.role,
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) =>
                part.type === "text"
                  ? { type: "text" as const, text: part.text }
                  : { type: "image" as const, byteLength: part.image.length }
              )
      })),
      incumbentEvidence: serializeEvidenceForDebug(input.incumbentEvidence),
      candidateEvidence: serializeEvidenceForDebug(input.candidateEvidence)
    };

    this.logger.info(
      `[score-debug] OpenRouter scoring input:\n${JSON.stringify(payload, null, 2)}`,
      payload,
      "score-debug"
    );
  }
}

export class CodexVoteJudge implements VoteJudge {
  private readonly runtimeDir: string;
  private readonly schemaPath: string;

  public constructor(
    private readonly workspaceRoot: string,
    private readonly logger: Logger,
    private readonly verbose: boolean
  ) {
    this.runtimeDir = path.join(this.workspaceRoot, ".skill-autoresearch", "codex");
    this.schemaPath = path.join(this.runtimeDir, "score-vote-schema.json");
  }

  public async generateVote(input: {
    modelId: string;
    rubricPrompt: string;
    incumbentEvidence: EvidenceItem[];
    candidateEvidence: EvidenceItem[];
  }): Promise<ScoreVote> {
    await fs.ensureDir(this.runtimeDir);
    await this.ensureSchemaFile();

    const outputPath = path.join(
      this.runtimeDir,
      `vote-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    );
    const imagePaths = this.collectImagePaths(
      input.incumbentEvidence,
      input.candidateEvidence
    );
    const prompt = this.buildPrompt(input);
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--model",
      input.modelId,
      "--output-schema",
      this.schemaPath,
      "-o",
      outputPath,
      ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
      prompt
    ];
    this.logDebugInput(input, prompt, imagePaths, args);

    if (this.verbose) {
      this.logger.debug(`codex ${args.join(" ")}`);
    }

    try {
      const result = await execa("codex", args, {
        cwd: this.workspaceRoot,
        all: true,
        reject: false
      });

      if (this.verbose && result.all?.trim()) {
        this.logger.debug(result.all);
      }

      if (result.exitCode !== 0) {
        throw new Error(
          `Codex scoring failed for model ${input.modelId} with exit code ${result.exitCode}.`
        );
      }

      const rawOutput = (await fs.readFile(outputPath, "utf8")).trim();
      if (rawOutput.length === 0) {
        throw new Error("Codex scoring returned empty output.");
      }

      const parsedOutput = JSON.parse(rawOutput) as unknown;
      return scoreVoteSchema.parse(parsedOutput);
    } finally {
      await fs.remove(outputPath);
    }
  }

  private async ensureSchemaFile(): Promise<void> {
    if (await fs.pathExists(this.schemaPath)) {
      return;
    }

    await fs.writeJson(this.schemaPath, scoreVoteJsonSchema, { spaces: 2 });
  }

  private collectImagePaths(
    incumbentEvidence: EvidenceItem[],
    candidateEvidence: EvidenceItem[]
  ): string[] {
    return [...incumbentEvidence, ...candidateEvidence].flatMap((item) =>
      item.outputType === "image" ? [item.path] : []
    );
  }

  private buildPrompt(input: {
    rubricPrompt: string;
    incumbentEvidence: EvidenceItem[];
    candidateEvidence: EvidenceItem[];
  }): string {
    const sections = [
      "You are scoring two candidates against a rubric.",
      'Return winner "A" when Candidate A is better, or "B" when Candidate B is better.',
      "Set confidence between 0 and 1, and keep the rationale concise.",
      "",
      "Rubric:",
      input.rubricPrompt,
      ""
    ];

    let nextImageIndex = 1;
    const candidateAEvidence = this.formatEvidenceBlock(
      "Candidate A",
      input.incumbentEvidence,
      nextImageIndex
    );
    nextImageIndex = candidateAEvidence.nextImageIndex;

    const candidateBEvidence = this.formatEvidenceBlock(
      "Candidate B",
      input.candidateEvidence,
      nextImageIndex
    );

    sections.push(...candidateAEvidence.lines, ...candidateBEvidence.lines);

    const hasImages = candidateBEvidence.nextImageIndex > 1;
    if (hasImages) {
      sections.push(
        "Image attachments are provided in the numbered order above.",
        ""
      );
    }

    sections.push(
      hasImages
        ? "Judge only from the evidence above and the attached image contents."
        : "Judge only from the evidence above."
    );
    return sections.join("\n");
  }

  private formatEvidenceBlock(
    label: string,
    evidence: EvidenceItem[],
    startingImageIndex: number
  ): { lines: string[]; nextImageIndex: number } {
    const lines = [`${label} evidence:`];
    let nextImageIndex = startingImageIndex;

    for (const [index, item] of evidence.entries()) {
      if (item.outputType === "text") {
        lines.push(`Evidence ${index + 1} (${item.label}) [text]:`, item.content, "");
        continue;
      }

      lines.push(
        `Evidence ${index + 1} (${item.label}) [image attachment ${nextImageIndex}]: ${path.basename(item.path)}`,
        ""
      );
      nextImageIndex += 1;
    }

    return { lines, nextImageIndex };
  }

  private logDebugInput(
    input: {
      modelId: string;
      rubricPrompt: string;
      incumbentEvidence: EvidenceItem[];
      candidateEvidence: EvidenceItem[];
    },
    prompt: string,
    imagePaths: string[],
    args: string[]
  ): void {
    if (!isDebugScoreEnabled()) {
      return;
    }

    const payload = {
      provider: "codex" as const,
      modelId: input.modelId,
      command: ["codex", ...args],
      prompt,
      imagePaths,
      incumbentEvidence: serializeEvidenceForDebug(input.incumbentEvidence),
      candidateEvidence: serializeEvidenceForDebug(input.candidateEvidence)
    };

    this.logger.info(
      `[score-debug] Codex scoring input:\n${JSON.stringify(payload, null, 2)}`,
      payload,
      "score-debug"
    );
  }
}

export class Scorer {
  public constructor(
    private readonly workspaceRoot: string,
    private readonly logger: Logger,
    private readonly judges: Record<ScoringProvider, VoteJudge>,
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
      if (commandDefinition.command) {
        const command = interpolateStepPath(commandDefinition.command, resolvedStepPath);
        if (this.verbose) {
          this.logger.debug(`Executing rubric command: ${command}`);
        }
        await this.executeRubricCommand(command, stepPath, resolvedStepPath);
      }

      const label = `evidence-${index + 1}`;
      if (commandDefinition.outputType === "text") {
        const textEvidence = await this.readTextEvidence(
          commandDefinition.resultPath,
          resolvedStepPath
        );
        evidence.push({
          outputType: "text",
          label,
          content: textEvidence
        });
        continue;
      }

      evidence.push(
        await this.readImageEvidence(commandDefinition.resultPath, resolvedStepPath, label)
      );
    }

    if (evidence.length === 0) {
      throw new Error(`No evidence collected for ${stepPath}.`);
    }

    return evidence;
  }

  public async runVoteSeries(input: {
    provider: ScoringProvider;
    modelId: string;
    rubricPrompt: string;
    incumbentEvidence: EvidenceItem[];
    candidateEvidence: EvidenceItem[];
    voteCount: number;
    existingVotes?: VoteRecord[];
  }): Promise<{ votes: VoteRecord[]; comparison: CandidateComparison }> {
    const votes = [...(input.existingVotes ?? [])];

    for (let attempt = votes.length; attempt < input.voteCount; attempt += 1) {
      const vote = await this.getJudge(input.provider).generateVote({
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
    provider: ScoringProvider;
    modelId: string;
    rubricPrompt: string;
    incumbentEvidence: EvidenceItem[];
    candidateEvidence: EvidenceItem[];
  }): Promise<ScoreVote> {
    return this.getJudge(input.provider).generateVote(input);
  }

  private async executeRubricCommand(
    command: string,
    stepPath: string,
    resolvedStepPath: string
  ): Promise<void> {
    const playwrightScreenshotCommand = parsePlaywrightHtmlScreenshotCommand(command);
    if (playwrightScreenshotCommand) {
      await this.captureHtmlScreenshot({
        command,
        stepPath,
        stepRoot: resolvedStepPath,
        inputPath: playwrightScreenshotCommand.inputPath,
        outputPath: playwrightScreenshotCommand.outputPath
      });
      return;
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
        formatCommandFailure({
          label: "Rubric command",
          subject: stepPath,
          command,
          exitCode: result.exitCode ?? 1,
          output: result.all
        })
      );
    }
  }

  private async captureHtmlScreenshot(input: {
    command: string;
    stepPath: string;
    stepRoot: string;
    inputPath: string;
    outputPath: string;
  }): Promise<void> {
    const normalizedInputPath = path.resolve(input.inputPath);
    const normalizedOutputPath = path.resolve(input.outputPath);
    const relativeInputPath = path.relative(input.stepRoot, normalizedInputPath);
    if (
      relativeInputPath.startsWith("..") ||
      path.isAbsolute(relativeInputPath)
    ) {
      throw new Error(
        `Rubric command input must stay within ${input.stepRoot}: ${input.command}`
      );
    }

    const sessionId = `skill-autoresearch-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    const screenshotServer = await startStaticFileServer(input.stepRoot);
    const pageUrl = new URL(
      relativeInputPath.split(path.sep).join("/"),
      `${screenshotServer.origin}/`
    ).toString();
    const logOutput: string[] = [];

    try {
      await fs.ensureDir(path.dirname(normalizedOutputPath));

      for (const args of [
        [`-s=${sessionId}`, "open", pageUrl],
        [`-s=${sessionId}`, "resize", "1440", "1080"],
        [`-s=${sessionId}`, "screenshot", "--filename", normalizedOutputPath]
      ]) {
        const result = await execa("playwright-cli", args, {
          cwd: this.workspaceRoot,
          all: true,
          reject: false
        });

        if (this.verbose && result.all?.trim()) {
          this.logger.debug(result.all);
        }

        if (result.all?.trim()) {
          logOutput.push(result.all.trim());
        }

        if (result.exitCode !== 0) {
          throw new Error(
            formatCommandFailure({
              label: "Rubric command",
              subject: input.stepPath,
              command: input.command,
              exitCode: result.exitCode ?? 1,
              output: logOutput.join("\n")
            })
          );
        }
      }
    } finally {
      try {
        await execa("playwright-cli", [`-s=${sessionId}`, "close"], {
          cwd: this.workspaceRoot,
          all: true,
          reject: false
        });
      } catch {
        // Ignore close failures. The scoring command already captured the relevant error.
      }

      await screenshotServer.close();
    }
  }

  private getJudge(provider: ScoringProvider): VoteJudge {
    const judge = this.judges[provider];
    if (!judge) {
      throw new Error(`Unsupported scoring provider: ${provider}`);
    }

    return judge;
  }

  private async readTextEvidence(
    resultPath: string,
    resolvedStepPath: string
  ): Promise<string> {
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

  private async readImageEvidence(
    resultPath: string,
    resolvedStepPath: string,
    label: string
  ): Promise<EvidenceItem> {
    const imagePath = path.resolve(
      this.workspaceRoot,
      interpolateStepPath(resultPath, resolvedStepPath)
    );
    const bytes = await fs.readFile(imagePath);
    if (bytes.length === 0) {
      throw new Error(`Image evidence is empty: ${imagePath}`);
    }
    const mimeType = inferImageMimeType(imagePath);
    assertImageBytesMatchMimeType(imagePath, mimeType, bytes);

    return {
      outputType: "image",
      label,
      path: imagePath,
      mimeType,
      bytes
    };
  }
}
