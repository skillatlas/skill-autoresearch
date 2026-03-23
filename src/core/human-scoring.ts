import fs from "fs-extra";
import { spawn } from "node:child_process";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";
import { URL } from "node:url";

import { Logger } from "./logger.js";
import { selectBestWinningCandidate } from "./scorer.js";
import { ScoreVote } from "../types/rubric.js";
import { ActiveCandidate, RunState } from "../types/state.js";

export interface HumanReviewCandidate {
  index: number;
  path: string;
  completedVotes: number;
}

export interface HumanReviewInput {
  runId: string;
  stepIndex: number;
  voteCount: number;
  incumbentPath: string;
  candidates: HumanReviewCandidate[];
  onVote(input: { candidateIndex: number; vote: ScoreVote }): Promise<void>;
}

export interface BrowserOpener {
  open(url: string): Promise<void>;
}

export interface HumanReviewService {
  startRun(state: RunState): Promise<void>;
  syncState(state: RunState): void;
  reviewCandidates(input: HumanReviewInput): Promise<void>;
  close(): Promise<void>;
}

interface ReviewItem {
  candidateIndex: number;
  attempt: number;
}

interface ArtifactRef {
  label: string;
  path: string;
}

interface ReviewSession {
  input: HumanReviewInput;
  queue: ReviewItem[];
  activeIndex: number;
  candidateByIndex: Map<number, HumanReviewCandidate>;
  candidateProgress: Map<number, number>;
  artifacts: Map<string, ArtifactRef>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface SessionCandidate {
  index: number;
  completedVotes: number;
  totalVotes: number;
  status: string;
  path: string;
}

interface SessionDiffLine {
  type: "context" | "added" | "removed" | "spacer";
  oldLineNumber: number | null;
  newLineNumber: number | null;
  text: string;
  omittedLineCount?: number;
}

interface SessionDiffFile {
  path: string;
  status: "added" | "removed" | "modified";
  addedLineCount: number;
  removedLineCount: number;
  lines: SessionDiffLine[];
}

interface SessionSkillDiff {
  compareTarget: "original" | "previous";
  label: string;
  basePath: string;
  currentPath: string;
  changedFileCount: number;
  files: SessionDiffFile[];
}

interface SessionSkillDiffState {
  visible: boolean;
  preferredTarget: "original" | "previous";
  targets: {
    original: SessionSkillDiff | null;
    previous: SessionSkillDiff | null;
  };
}

interface SessionCurrentComparison {
  candidateIndex: number;
  candidateLabel: string;
  attempt: number | null;
  comparisonNumber: number | null;
  incumbentPath: string;
  candidatePath: string;
  incumbentUrl: string;
  candidateUrl: string;
  votingEnabled: boolean;
  statusLabel: string;
}

interface SessionCurrentSnapshot {
  comparison: SessionCurrentComparison;
  artifacts: Map<string, ArtifactRef>;
}

interface RubricComparisonSnapshot {
  stepIndex: number;
  candidateIndex: number;
  incumbentPath: string;
  candidatePath: string;
  accepted: boolean;
}

interface SessionArtifactView {
  label: string;
  path: string;
  url: string | null;
  isWinner: boolean;
}

interface SessionStepView {
  key: string;
  title: string;
  stepIndex: number;
  phaseLabel: string;
  summary: string;
  outcome: "current" | "accepted" | "rejected";
  winnerLabel: string;
  canVote: boolean;
  incumbent: SessionArtifactView | null;
  candidate: SessionArtifactView | null;
  skillDiff: SessionSkillDiffState | null;
  statusText: string;
}

const PREVIEW_VIEWPORTS = [480, 960] as const;
const DEFAULT_PREVIEW_VIEWPORT = 960;
const DEFAULT_PREVIEW_HEIGHT = 420;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inferMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".txt":
    case ".md":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function rewriteHtml(html: string, basePath: string): string {
  const rewrittenPaths = html
    .replaceAll('href="/', `href="${basePath}`)
    .replaceAll("href='/", `href='${basePath}`)
    .replaceAll('src="/', `src="${basePath}`)
    .replaceAll("src='/", `src='${basePath}`)
    .replaceAll('action="/', `action="${basePath}`)
    .replaceAll("action='/", `action='${basePath}`)
    .replaceAll("url(/", `url(${basePath}`)
    .replaceAll('url("/', `url("${basePath}`)
    .replaceAll("url('/", `url('${basePath}`);

  const withBase =
    /<head[^>]*>/i.test(rewrittenPaths)
      ? rewrittenPaths.replace(/<head([^>]*)>/i, `<head$1><base href="${basePath}">`)
      : `<head><base href="${basePath}"></head>${rewrittenPaths}`;

  return withBase;
}

async function listArtifactFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      files.push(path.relative(rootPath, absolutePath).split(path.sep).join("/"));
    }
  }

  await walk(rootPath);
  return files;
}

function listRelativeFilesSync(rootPath: string): string[] {
  if (!fs.existsSync(rootPath)) {
    return [];
  }

  const files: string[] = [];

  function walk(currentPath: string): void {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }

      files.push(path.relative(rootPath, absolutePath).split(path.sep).join("/"));
    }
  }

  walk(rootPath);
  return files;
}

function normalizeFileContent(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

function splitFileLines(value: string): string[] {
  if (value.length === 0) {
    return [];
  }

  const normalized = normalizeFileContent(value);
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

function buildRawDiffLines(
  beforeLines: string[],
  afterLines: string[]
): SessionDiffLine[] {
  const lcs = Array.from({ length: beforeLines.length + 1 }, () =>
    Array<number>(afterLines.length + 1).fill(0)
  );

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lcs[beforeIndex]![afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? (lcs[beforeIndex + 1]?.[afterIndex + 1] ?? 0) + 1
          : Math.max(
              lcs[beforeIndex + 1]?.[afterIndex] ?? 0,
              lcs[beforeIndex]?.[afterIndex + 1] ?? 0
            );
    }
  }

  const lines: SessionDiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  let oldLineNumber = 1;
  let newLineNumber = 1;

  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      lines.push({
        type: "context",
        oldLineNumber,
        newLineNumber,
        text: beforeLines[beforeIndex]
      });
      beforeIndex += 1;
      afterIndex += 1;
      oldLineNumber += 1;
      newLineNumber += 1;
      continue;
    }

    if ((lcs[beforeIndex + 1]?.[afterIndex] ?? 0) >= (lcs[beforeIndex]?.[afterIndex + 1] ?? 0)) {
      lines.push({
        type: "removed",
        oldLineNumber,
        newLineNumber: null,
        text: beforeLines[beforeIndex]
      });
      beforeIndex += 1;
      oldLineNumber += 1;
      continue;
    }

    lines.push({
      type: "added",
      oldLineNumber: null,
      newLineNumber,
      text: afterLines[afterIndex]
    });
    afterIndex += 1;
    newLineNumber += 1;
  }

  while (beforeIndex < beforeLines.length) {
    lines.push({
      type: "removed",
      oldLineNumber,
      newLineNumber: null,
      text: beforeLines[beforeIndex]
    });
    beforeIndex += 1;
    oldLineNumber += 1;
  }

  while (afterIndex < afterLines.length) {
    lines.push({
      type: "added",
      oldLineNumber: null,
      newLineNumber,
      text: afterLines[afterIndex]
    });
    afterIndex += 1;
    newLineNumber += 1;
  }

  return lines;
}

function compactDiffLines(
  lines: SessionDiffLine[],
  contextRadius = 3
): SessionDiffLine[] {
  const changedIndexes = lines.flatMap((line, index) =>
    line.type === "added" || line.type === "removed" ? [index] : []
  );

  if (changedIndexes.length === 0) {
    return [];
  }

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - contextRadius);
    const end = Math.min(lines.length - 1, index + contextRadius);
    const previousRange = ranges[ranges.length - 1];

    if (previousRange && start <= previousRange.end + 1) {
      previousRange.end = Math.max(previousRange.end, end);
      continue;
    }

    ranges.push({ start, end });
  }

  const compacted: SessionDiffLine[] = [];
  let cursor = 0;

  for (const range of ranges) {
    if (range.start > cursor) {
      compacted.push({
        type: "spacer",
        oldLineNumber: null,
        newLineNumber: null,
        text: "",
        omittedLineCount: range.start - cursor
      });
    }

    compacted.push(...lines.slice(range.start, range.end + 1));
    cursor = range.end + 1;
  }

  if (cursor < lines.length) {
    compacted.push({
      type: "spacer",
      oldLineNumber: null,
      newLineNumber: null,
      text: "",
      omittedLineCount: lines.length - cursor
    });
  }

  return compacted;
}

function buildSkillDiffFromDirectories(input: {
  basePath: string;
  baseLabel: string;
  currentPath: string;
  currentLabel: string;
  compareTarget: "original" | "previous";
  label: string;
}): SessionSkillDiff | null {
  if (!fs.existsSync(input.basePath) || !fs.existsSync(input.currentPath)) {
    return null;
  }

  const filePaths = [
    ...new Set([
      ...listRelativeFilesSync(input.basePath),
      ...listRelativeFilesSync(input.currentPath)
    ])
  ].sort((left, right) => left.localeCompare(right));
  const files: SessionDiffFile[] = [];

  for (const relativePath of filePaths) {
    const baseFilePath = path.join(input.basePath, relativePath);
    const currentFilePath = path.join(input.currentPath, relativePath);
    const hasBaseFile = fs.existsSync(baseFilePath);
    const hasCurrentFile = fs.existsSync(currentFilePath);

    if (!hasBaseFile && !hasCurrentFile) {
      continue;
    }

    const baseContent = hasBaseFile
      ? normalizeFileContent(fs.readFileSync(baseFilePath, "utf8"))
      : "";
    const currentContent = hasCurrentFile
      ? normalizeFileContent(fs.readFileSync(currentFilePath, "utf8"))
      : "";

    if (baseContent === currentContent) {
      continue;
    }

    const rawLines = buildRawDiffLines(
      splitFileLines(baseContent),
      splitFileLines(currentContent)
    );

    files.push({
      path: relativePath,
      status:
        !hasBaseFile ? "added" : !hasCurrentFile ? "removed" : "modified",
      addedLineCount: rawLines.filter((line) => line.type === "added").length,
      removedLineCount: rawLines.filter((line) => line.type === "removed").length,
      lines: compactDiffLines(rawLines)
    });
  }

  if (files.length === 0) {
    return null;
  }

  return {
    compareTarget: input.compareTarget,
    label: input.label,
    basePath: input.baseLabel,
    currentPath: input.currentLabel,
    changedFileCount: files.length,
    files
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function sendHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(html);
}

class SystemBrowserOpener implements BrowserOpener {
  public async open(url: string): Promise<void> {
    const command =
      process.platform === "darwin"
        ? { bin: "open", args: [url] }
        : process.platform === "win32"
          ? { bin: "cmd", args: ["/c", "start", "", url] }
          : { bin: "xdg-open", args: [url] };

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.bin, command.args, {
        stdio: "ignore",
        detached: process.platform !== "win32"
      });

      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }
}

export class LocalHumanReviewService implements HumanReviewService {
  private server?: Server;
  private baseUrl?: string;
  private latestState?: RunState;
  private activeReview?: ReviewSession;
  private latestRubricComparison?: RubricComparisonSnapshot;
  private readonly eventClients = new Set<ServerResponse>();

  public constructor(
    private readonly logger: Logger,
    private readonly browserOpener: BrowserOpener = new SystemBrowserOpener()
  ) {}

  public async startRun(state: RunState): Promise<void> {
    this.latestState = structuredClone(state);
    this.captureRubricComparison(this.latestState);
    if (this.server) {
      this.broadcastSession();
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        if (error) {
          reject(error);
          return;
        }

        resolve();
      };

      this.server = createServer((request, response) => {
        void this.handleRequest(request, response).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          response.writeHead(500, {
            "content-type": "text/plain; charset=utf-8"
          });
          response.end(`${message}\n`);
        });
      });

      this.server.on("error", (error) => {
        finish(error);
      });

      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server?.address();
        if (!address || typeof address === "string") {
          finish(new Error("Failed to determine local review server address."));
          return;
        }

        this.baseUrl = `http://127.0.0.1:${address.port}`;
        this.logger.phase(`Web interface ready at ${this.baseUrl}`);
        void this.browserOpener
          .open(this.baseUrl)
          .then(() => {
            this.logger.info(`Opened the web interface in the default browser: ${this.baseUrl}`);
            this.broadcastSession();
            finish();
          })
          .catch((error: unknown) => {
            finish(error);
          });
      });
    });
  }

  public syncState(state: RunState): void {
    this.latestState = structuredClone(state);
    this.captureRubricComparison(this.latestState);
    this.broadcastSession();
  }

  public async reviewCandidates(input: HumanReviewInput): Promise<void> {
    if (!this.server) {
      throw new Error("Human review server has not been started.");
    }

    const queue = input.candidates.flatMap((candidate) =>
      Array.from(
        { length: Math.max(0, input.voteCount - candidate.completedVotes) },
        (_, offset) => ({
          candidateIndex: candidate.index,
          attempt: candidate.completedVotes + offset
        })
      )
    );

    if (queue.length === 0) {
      return;
    }

    const candidateByIndex = new Map(
      input.candidates.map((candidate) => [candidate.index, candidate])
    );
    const candidateProgress = new Map(
      input.candidates.map((candidate) => [candidate.index, candidate.completedVotes])
    );
    const artifacts = new Map<string, ArtifactRef>([
      ["incumbent", { label: "Incumbent", path: input.incumbentPath }],
      ...input.candidates.map((candidate): [string, ArtifactRef] => [
        `candidate-${candidate.index}`,
        {
          label: `Candidate ${candidate.index}`,
          path: candidate.path
        }
      ])
    ]);

    await new Promise<void>((resolve, reject) => {
      this.activeReview = {
        input,
        queue,
        activeIndex: 0,
        candidateByIndex,
        candidateProgress,
        artifacts,
        resolve,
        reject
      };
      this.broadcastSession();
      this.logPendingComparison();
    });
  }

  public async close(): Promise<void> {
    const currentReview = this.activeReview;
    this.activeReview = undefined;
    if (currentReview) {
      currentReview.reject(new Error("Human review server closed before review completed."));
    }

    for (const client of this.eventClients) {
      client.end();
    }
    this.eventClients.clear();

    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private buildSessionPayload() {
    const mode = this.getMode();
    const phaseLabel = this.describePhase();
    const summary = this.describeSummary(mode);
    const progress = this.buildProgress(mode);
    const candidates = this.buildCandidates();
    const currentSnapshot = this.buildCurrentSnapshot();
    const stepViews = this.buildStepViews(mode);
    const currentStepView = stepViews.find((view) => view.key === "current") ?? null;

    return {
      mode,
      runId: this.latestState?.runId ?? null,
      scoringMode: this.latestState?.scoringMode ?? null,
      stepIndex: this.latestState?.stepIndex ?? 0,
      phaseLabel,
      summary,
      voteCount:
        this.activeReview?.input.voteCount ?? this.latestState?.voteCount ?? 0,
      completedUnits: progress.completed,
      totalUnits: progress.total,
      current: currentSnapshot?.comparison ?? null,
      candidates,
      skillDiff: currentStepView?.skillDiff ?? null,
      stepViews
    };
  }

  private buildSkillDiff(): SessionSkillDiffState | null {
    const state = this.latestState;
    if (!state) {
      return null;
    }

    const original = this.buildSkillDiffTarget(
      state.skillsOriginalPath,
      "original",
      "original"
    );
    const previous = this.buildSkillDiffTarget(
      state.skillsPreviousPath,
      "previous",
      "previous step"
    );

    if (!original && !previous) {
      return null;
    }

    const originalChanges = original?.changedFileCount ?? 0;
    const previousChanges = previous?.changedFileCount ?? 0;

    return {
      visible: originalChanges > 0 || previousChanges > 0,
      preferredTarget: previousChanges > 0 ? "previous" : "original",
      targets: {
        original,
        previous
      }
    };
  }

  private buildSkillDiffTarget(
    relativeBasePath: string,
    compareTarget: "original" | "previous",
    label: string
  ): SessionSkillDiff | null {
    const state = this.latestState;
    if (!state) {
      return null;
    }

    return buildSkillDiffFromDirectories({
      basePath: path.resolve(state.workspaceRoot, relativeBasePath),
      baseLabel: relativeBasePath,
      currentPath: path.resolve(state.workspaceRoot, "skills"),
      currentLabel: "skills",
      compareTarget,
      label
    });
  }

  private buildHistoricalSkillDiff(
    baseArtifactPath: string,
    candidateArtifactPath: string
  ): SessionSkillDiff | null {
    return buildSkillDiffFromDirectories({
      basePath: path.join(baseArtifactPath, "skills"),
      baseLabel: this.relativeToWorkspace(path.join(baseArtifactPath, "skills")),
      currentPath: path.join(candidateArtifactPath, "skills"),
      currentLabel: this.relativeToWorkspace(path.join(candidateArtifactPath, "skills")),
      compareTarget: "previous",
      label: "step snapshot"
    });
  }

  private getMode(): "starting" | "running" | "review" | "completed" | "failed" {
    if (!this.latestState) {
      return "starting";
    }
    if (this.activeReview) {
      return "review";
    }
    if (this.latestState.status === "completed") {
      return "completed";
    }
    if (this.latestState.status === "failed") {
      return "failed";
    }

    return "running";
  }

  private describePhase(): string {
    const state = this.latestState;
    if (!state) {
      return "Starting\u2026";
    }

    switch (state.currentPhase) {
      case "generate-baseline":
        return "Baseline";
      case "snapshot":
        return "Snapshot";
      case "mutate-skills":
        return `Step ${state.stepIndex} \u00B7 Mutating`;
      case "generate-candidates":
        return `Step ${state.stepIndex} \u00B7 Generating`;
      case "score":
        return `Step ${state.stepIndex} \u00B7 Scoring`;
      case "promote":
        return `Step ${state.stepIndex} \u00B7 Promoting`;
      default:
        return "Running";
    }
  }

  private describeSummary(mode: ReturnType<typeof this.getMode>): string {
    const state = this.latestState;
    if (!state) {
      return "Setting up\u2026";
    }

    if (mode === "review" && this.activeReview) {
      const current = this.activeReview.queue[this.activeReview.activeIndex];
      if (!current) {
        return "All votes recorded. Wrapping up this step.";
      }

      return `Candidate ${current.candidateIndex} \u00B7 vote ${current.attempt + 1} of ${this.activeReview.input.voteCount}`;
    }

    if (mode === "completed") {
      return `Run complete (${state.completedReason ?? "done"}).`;
    }

    if (mode === "failed") {
      return "Run failed \u2014 check the terminal for details.";
    }

    switch (state.currentPhase) {
      case "generate-baseline":
        return "Building the baseline artifact\u2026";
      case "snapshot":
        return "Saving a snapshot of the current skills\u2026";
      case "mutate-skills":
        return "Applying the mutation\u2026";
      case "generate-candidates":
        return `${state.activeCandidates.filter((candidate) => candidate.status !== "pending").length} of ${state.candidateCount} candidates generated`;
      case "score":
        return `${state.activeCandidates.reduce((sum, candidate) => sum + candidate.votes.length, 0)} of ${state.activeCandidates.length * state.voteCount} votes collected`;
      case "promote":
        return "Deciding whether to keep or revert this mutation\u2026";
      default:
        return "Working\u2026";
    }
  }

  private buildProgress(
    mode: ReturnType<typeof this.getMode>
  ): { completed: number; total: number } {
    if (mode === "review" && this.activeReview) {
      return {
        completed: this.activeReview.activeIndex,
        total: this.activeReview.queue.length
      };
    }

    const state = this.latestState;
    if (!state) {
      return { completed: 0, total: 1 };
    }

    if (state.status === "completed") {
      return { completed: 1, total: 1 };
    }

    switch (state.currentPhase) {
      case "generate-candidates":
        return {
          completed: state.activeCandidates.filter((candidate) => candidate.status !== "pending")
            .length,
          total: state.candidateCount
        };
      case "score":
        return {
          completed: state.activeCandidates.reduce(
            (sum, candidate) => sum + candidate.votes.length,
            0
          ),
          total: Math.max(1, state.activeCandidates.length * state.voteCount)
        };
      case "generate-baseline":
      case "snapshot":
      case "mutate-skills":
      case "promote":
        return { completed: 0, total: 1 };
      default:
        return { completed: 0, total: 1 };
    }
  }

  private buildCandidates(): SessionCandidate[] {
    const state = this.latestState;
    if (!state) {
      return [];
    }

    return state.activeCandidates.map((candidate) => ({
      index: candidate.index,
      completedVotes:
        this.activeReview?.candidateProgress.get(candidate.index) ?? candidate.votes.length,
      totalVotes: state.voteCount,
      status: candidate.status,
      path: path.resolve(state.workspaceRoot, candidate.path)
    }));
  }

  private buildCurrentSnapshot(): SessionCurrentSnapshot | null {
    return this.buildActiveReviewSnapshot() ?? this.buildRubricSnapshot();
  }

  private buildActiveReviewSnapshot(): SessionCurrentSnapshot | null {
    if (!this.activeReview || !this.baseUrl) {
      return null;
    }

    const current = this.activeReview.queue[this.activeReview.activeIndex];
    if (!current) {
      return null;
    }

    const candidate = this.activeReview.candidateByIndex.get(current.candidateIndex);
    if (!candidate) {
      return null;
    }

    const incumbentArtifactId = "incumbent";
    const candidateArtifactId = `candidate-${current.candidateIndex}`;

    return {
      comparison: {
        candidateIndex: current.candidateIndex,
        candidateLabel: `Candidate ${current.candidateIndex}`,
        attempt: current.attempt,
        comparisonNumber: this.activeReview.activeIndex + 1,
        incumbentPath: this.activeReview.input.incumbentPath,
        candidatePath: candidate.path,
        incumbentUrl: `${this.baseUrl}/artifact/${incumbentArtifactId}/`,
        candidateUrl: `${this.baseUrl}/artifact/${candidateArtifactId}/`,
        votingEnabled: true,
        statusLabel: "Which version looks better?"
      },
      artifacts: new Map<string, ArtifactRef>([
        [incumbentArtifactId, { label: "Incumbent", path: this.activeReview.input.incumbentPath }],
        [
          candidateArtifactId,
          {
            label: `Candidate ${current.candidateIndex}`,
            path: candidate.path
          }
        ]
      ])
    };
  }

  private buildRubricSnapshot(): SessionCurrentSnapshot | null {
    if (!this.baseUrl || this.latestState?.scoringMode !== "rubric") {
      return null;
    }

    const comparison =
      this.latestRubricComparison ?? this.deriveRubricComparisonFromHistory(this.latestState);
    if (!comparison) {
      return null;
    }

    const incumbentArtifactId = "incumbent";
    const candidateArtifactId = `candidate-${comparison.candidateIndex}`;

    return {
      comparison: {
        candidateIndex: comparison.candidateIndex,
        candidateLabel: `Candidate ${comparison.candidateIndex}`,
        attempt: null,
        comparisonNumber: null,
        incumbentPath: comparison.incumbentPath,
        candidatePath: comparison.candidatePath,
        incumbentUrl: `${this.baseUrl}/artifact/${incumbentArtifactId}/`,
        candidateUrl: `${this.baseUrl}/artifact/${candidateArtifactId}/`,
        votingEnabled: false,
        statusLabel: comparison.accepted
          ? `Latest completed rubric step kept candidate ${comparison.candidateIndex}.`
          : `Latest completed rubric step kept the incumbent over candidate ${comparison.candidateIndex}.`
      },
      artifacts: new Map<string, ArtifactRef>([
        [incumbentArtifactId, { label: "Incumbent", path: comparison.incumbentPath }],
        [
          candidateArtifactId,
          {
            label: `Candidate ${comparison.candidateIndex}`,
            path: comparison.candidatePath
          }
        ]
      ])
    };
  }

  private captureRubricComparison(state: RunState): void {
    if (state.scoringMode !== "rubric") {
      return;
    }

    const currentStepComparison = this.deriveRubricComparisonFromState(state);
    if (currentStepComparison) {
      this.latestRubricComparison = currentStepComparison;
      return;
    }

    if (!this.latestRubricComparison) {
      this.latestRubricComparison = this.deriveRubricComparisonFromHistory(state);
    }
  }

  private deriveRubricComparisonFromState(
    state: RunState
  ): RubricComparisonSnapshot | undefined {
    if (
      state.currentPhase !== "promote" ||
      !state.incumbentPath ||
      state.activeCandidates.length === 0
    ) {
      return undefined;
    }

    const selectedCandidate = this.selectDisplayCandidate(state.activeCandidates);
    if (!selectedCandidate) {
      return undefined;
    }

    const acceptedCandidateCount = state.activeCandidates.filter(
      (candidate) => candidate.comparison?.isWinner
    ).length;

    return {
      stepIndex: state.stepIndex,
      candidateIndex: selectedCandidate.index,
      incumbentPath: path.resolve(state.workspaceRoot, state.incumbentPath),
      candidatePath: path.resolve(state.workspaceRoot, selectedCandidate.path),
      accepted: acceptedCandidateCount > state.activeCandidates.length / 2
    };
  }

  private deriveRubricComparisonFromHistory(
    state: RunState
  ): RubricComparisonSnapshot | undefined {
    const latestEntry = state.history[state.history.length - 1];
    if (
      !latestEntry?.accepted ||
      latestEntry.promotedCandidateIndex == null ||
      !latestEntry.promotedCandidatePath
    ) {
      return undefined;
    }

    const previousEntry = state.history[state.history.length - 2];
    const previousIncumbentPath =
      previousEntry?.incumbentPath ??
      path.join("steps", "0", "baseline");

    return {
      stepIndex: latestEntry.stepIndex,
      candidateIndex: latestEntry.promotedCandidateIndex,
      incumbentPath: path.resolve(state.workspaceRoot, previousIncumbentPath),
      candidatePath: path.resolve(state.workspaceRoot, latestEntry.promotedCandidatePath),
      accepted: true
    };
  }

  private selectDisplayCandidate(
    candidates: ReadonlyArray<ActiveCandidate>
  ): ActiveCandidate | undefined {
    const winningCandidate = selectBestWinningCandidate(candidates);
    if (winningCandidate) {
      return winningCandidate;
    }

    return [...candidates]
      .filter((candidate) => candidate.comparison)
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

  private buildStepViews(
    mode: ReturnType<typeof this.getMode>
  ): SessionStepView[] {
    const currentStepView = this.buildCurrentStepView(mode);
    const historicalStepViews = this.buildHistoricalStepViews();

    return currentStepView ? [currentStepView, ...historicalStepViews] : historicalStepViews;
  }

  private buildCurrentStepView(
    mode: ReturnType<typeof this.getMode>
  ): SessionStepView | null {
    const state = this.latestState;
    if (!state) {
      return null;
    }

    const currentSnapshot = this.buildCurrentSnapshot();
    const comparison = currentSnapshot?.comparison ?? null;

    return {
      key: "current",
      title: "Current",
      stepIndex: state.stepIndex,
      phaseLabel: this.describePhase(),
      summary: this.describeSummary(mode),
      outcome: "current",
      winnerLabel:
        comparison?.votingEnabled ? "Live vote in progress" : "Following run progress",
      canVote: comparison?.votingEnabled ?? false,
      incumbent:
        comparison
          ? {
              label: "Incumbent",
              path: comparison.incumbentPath,
              url: `${this.baseUrl}/artifact/current-incumbent/`,
              isWinner: false
            }
          : null,
      candidate:
        comparison
          ? {
              label: comparison.candidateLabel,
              path: comparison.candidatePath,
              url: `${this.baseUrl}/artifact/current-candidate-${comparison.candidateIndex}/`,
              isWinner: false
            }
          : null,
      skillDiff: this.buildSkillDiff(),
      statusText:
        comparison?.statusLabel ?? "Select Current to follow progress as the run advances."
    };
  }

  private buildHistoricalStepViews(): SessionStepView[] {
    const state = this.latestState;
    if (!state || !this.baseUrl) {
      return [];
    }

    const baselinePath = path.join(state.workspaceRoot, "steps", "0", "baseline");
    let incumbentBeforePath = baselinePath;

    return state.history.map((entry) => {
      const view = this.buildHistoricalStepView(entry, incumbentBeforePath);
      incumbentBeforePath = this.resolveWorkspacePath(entry.incumbentPath);
      return view;
    });
  }

  private buildHistoricalStepView(
    entry: RunState["history"][number],
    incumbentBeforePath: string
  ): SessionStepView {
    const comparisonArtifact = this.resolveHistoricalComparisonArtifact(entry);
    const outcome = entry.accepted ? "accepted" : "rejected";
    const promotedLabel =
      entry.promotedCandidateIndex === undefined
        ? "Mutated artifact promoted"
        : `Candidate ${entry.promotedCandidateIndex} promoted`;
    const winnerLabel = entry.accepted ? promotedLabel : "Incumbent kept";
    const candidateLabel =
      entry.accepted &&
      comparisonArtifact !== null &&
      comparisonArtifact.index !== null
        ? `Candidate ${comparisonArtifact.index}`
        : "Mutated artifact";
    const historicalSkillDiff =
      comparisonArtifact === null
        ? null
        : this.buildHistoricalSkillDiff(incumbentBeforePath, comparisonArtifact.path);

    return {
      key: `step-${entry.stepIndex}`,
      title: `Step ${entry.stepIndex}`,
      stepIndex: entry.stepIndex,
      phaseLabel: `Step ${entry.stepIndex} · ${entry.accepted ? "Accepted" : "Rejected"}`,
      summary: entry.accepted
        ? `${winnerLabel}. ${entry.winningCandidateIndexes.length} of ${this.latestState?.candidateCount ?? 0} candidate${this.latestState?.candidateCount === 1 ? "" : "s"} beat the incumbent.`
        : `Mutation rejected. ${entry.winningCandidateIndexes.length} of ${this.latestState?.candidateCount ?? 0} candidate${this.latestState?.candidateCount === 1 ? "" : "s"} beat the incumbent.`,
      outcome,
      winnerLabel,
      canVote: false,
      incumbent: this.baseUrl
        ? {
            label: "Incumbent",
            path: incumbentBeforePath,
            url: `${this.baseUrl}/artifact/step-${entry.stepIndex}-incumbent/`,
            isWinner: !entry.accepted
          }
        : null,
      candidate:
        comparisonArtifact && this.baseUrl
          ? {
              label: candidateLabel,
              path: comparisonArtifact.path,
              url: `${this.baseUrl}/artifact/step-${entry.stepIndex}-candidate/`,
              isWinner: entry.accepted
            }
          : null,
      skillDiff:
        historicalSkillDiff === null
          ? null
          : {
              visible: true,
              preferredTarget: "previous",
              targets: {
                original: null,
                previous: historicalSkillDiff
              }
            },
      statusText: `Winner: ${winnerLabel}.`
    };
  }

  private resolveHistoricalComparisonArtifact(
    entry: RunState["history"][number]
  ): { index: number | null; path: string } | null {
    const state = this.latestState;
    if (!state) {
      return null;
    }

    const preferredIndexes =
      entry.accepted && entry.promotedCandidateIndex !== undefined
        ? [entry.promotedCandidateIndex]
        : entry.winningCandidateIndexes;
    const allCandidateIndexes = Array.from({ length: state.candidateCount }, (_, index) => index);
    const candidateIndexes = [...new Set([...preferredIndexes, ...allCandidateIndexes])];

    if (entry.accepted && entry.promotedCandidatePath) {
      const promotedCandidatePath = this.resolveWorkspacePath(entry.promotedCandidatePath);
      if (fs.existsSync(promotedCandidatePath)) {
        return {
          index: entry.promotedCandidateIndex ?? null,
          path: promotedCandidatePath
        };
      }
    }

    for (const candidateIndex of candidateIndexes) {
      const candidatePath = this.resolveWorkspacePath(
        path.join("steps", String(entry.stepIndex), "candidates", String(candidateIndex))
      );
      if (fs.existsSync(candidatePath)) {
        return {
          index: candidateIndex,
          path: candidatePath
        };
      }
    }

    return null;
  }

  private relativeToWorkspace(targetPath: string): string {
    const state = this.latestState;
    if (!state) {
      return targetPath;
    }

    return path.relative(state.workspaceRoot, targetPath).split(path.sep).join("/");
  }

  private resolveWorkspacePath(relativePath: string): string {
    const state = this.latestState;
    if (!state) {
      return relativePath;
    }

    return path.resolve(state.workspaceRoot, relativePath);
  }

  private resolveArtifactRef(artifactId: string): ArtifactRef | null {
    const currentSnapshot = this.buildCurrentSnapshot();
    if (artifactId === "current-incumbent") {
      return currentSnapshot?.artifacts.get("incumbent") ?? null;
    }

    if (artifactId.startsWith("current-candidate-")) {
      const candidateIndex = Number(artifactId.replace("current-candidate-", ""));
      if (!Number.isInteger(candidateIndex) || candidateIndex < 0) {
        return null;
      }

      return currentSnapshot?.artifacts.get(`candidate-${candidateIndex}`) ?? null;
    }

    const historicalArtifactMatch = /^step-(\d+)-(incumbent|candidate)$/.exec(artifactId);
    if (!historicalArtifactMatch) {
      return (
        currentSnapshot?.artifacts.get(artifactId) ??
        this.activeReview?.artifacts.get(artifactId) ??
        null
      );
    }

    const [, rawStepIndex, artifactRole] = historicalArtifactMatch;
    const stepIndex = Number(rawStepIndex);
    const state = this.latestState;
    if (!state || !Number.isInteger(stepIndex) || stepIndex <= 0) {
      return null;
    }

    const historyIndex = state.history.findIndex((entry) => entry.stepIndex === stepIndex);
    if (historyIndex < 0) {
      return null;
    }

    const entry = state.history[historyIndex];
    const incumbentBeforePath =
      historyIndex === 0
        ? path.join(state.workspaceRoot, "steps", "0", "baseline")
        : this.resolveWorkspacePath(state.history[historyIndex - 1]!.incumbentPath);
    if (artifactRole === "incumbent") {
      return {
        label: "Incumbent",
        path: incumbentBeforePath
      };
    }

    const comparisonArtifact = this.resolveHistoricalComparisonArtifact(entry);
    if (!comparisonArtifact) {
      return null;
    }

    return {
      label: entry.accepted ? `Candidate ${comparisonArtifact.index ?? ""}`.trim() : "Mutated artifact",
      path: comparisonArtifact.path
    };
  }

  private logPendingComparison(): void {
    if (!this.activeReview) {
      return;
    }

    const current = this.activeReview.queue[this.activeReview.activeIndex];
    if (!current) {
      return;
    }

    this.logger.info(
      `Awaiting vote ${this.activeReview.activeIndex + 1}/${this.activeReview.queue.length}: candidate ${current.candidateIndex}, vote ${current.attempt + 1}/${this.activeReview.input.voteCount}`
    );
  }

  private broadcastSession(): void {
    if (this.eventClients.size === 0) {
      return;
    }

    const payload = JSON.stringify(this.buildSessionPayload());
    for (const client of this.eventClients) {
      client.write(`event: session\ndata: ${payload}\n\n`);
    }
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (!request.url) {
      sendHtml(response, 400, "<h1>Missing request URL.</h1>");
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && pathname === "/") {
      sendHtml(response, 200, this.renderAppHtml());
      return;
    }

    if (request.method === "GET" && pathname === "/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive"
      });
      response.write(`event: session\ndata: ${JSON.stringify(this.buildSessionPayload())}\n\n`);
      this.eventClients.add(response);
      request.on("close", () => {
        this.eventClients.delete(response);
      });
      return;
    }

    if (request.method === "GET" && pathname === "/api/session") {
      sendJson(response, 200, this.buildSessionPayload());
      return;
    }

    if (request.method === "POST" && pathname === "/api/vote") {
      await this.handleVoteRequest(request, response);
      return;
    }

    if (request.method === "GET" && pathname.startsWith("/artifact/")) {
      const [, , artifactId, ...artifactPathSegments] = pathname.split("/");
      await this.handleArtifactRequest(
        response,
        artifactId ?? "",
        artifactPathSegments.join("/")
      );
      return;
    }

    sendHtml(response, 404, "<h1>Not found.</h1>");
  }

  private async handleVoteRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (!this.activeReview) {
      sendJson(response, 409, { error: "No active human review is ready yet." });
      return;
    }

    const current = this.activeReview.queue[this.activeReview.activeIndex];
    if (!current) {
      sendJson(response, 409, { error: "All human reviews are already complete." });
      return;
    }

    const body = await readRequestBody(request);
    const payload = JSON.parse(body) as {
      candidateIndex?: number;
      attempt?: number;
      winner?: "A" | "B";
    };

    if (
      payload.candidateIndex !== current.candidateIndex ||
      payload.attempt !== current.attempt
    ) {
      sendJson(response, 409, {
        error: "Review session advanced. Reload the page and try again."
      });
      return;
    }

    if (payload.winner !== "A" && payload.winner !== "B") {
      sendJson(response, 400, {
        error: 'Winner must be "A" or "B".'
      });
      return;
    }

    await this.activeReview.input.onVote({
      candidateIndex: current.candidateIndex,
      vote: {
        winner: payload.winner,
        confidence: 1,
        rationale:
          payload.winner === "A"
            ? "Human reviewer selected the incumbent artifact."
            : "Human reviewer selected the candidate artifact."
      }
    });

    this.activeReview.candidateProgress.set(
      current.candidateIndex,
      (this.activeReview.candidateProgress.get(current.candidateIndex) ?? 0) + 1
    );
    this.activeReview.activeIndex += 1;
    this.logger.info(
      `Recorded human vote ${this.activeReview.activeIndex}/${this.activeReview.queue.length}: candidate ${current.candidateIndex} -> ${payload.winner}.`
    );

    const sessionPayload = this.buildSessionPayload();
    sendJson(response, 200, sessionPayload);
    this.broadcastSession();

    const review = this.activeReview;
    if (review.activeIndex >= review.queue.length) {
      setImmediate(() => {
        if (this.activeReview === review) {
          this.activeReview = undefined;
          review.resolve();
        }
      });
      return;
    }

    this.logPendingComparison();
  }

  private async handleArtifactRequest(
    response: ServerResponse,
    artifactId: string,
    rawArtifactPath: string
  ): Promise<void> {
    const artifact = this.resolveArtifactRef(artifactId);
    if (!artifact) {
      sendHtml(response, 404, "<h1>Artifact not found.</h1>");
      return;
    }

    const relativeArtifactPath = rawArtifactPath
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment))
      .join(path.sep);
    const resolvedPath = path.resolve(artifact.path, relativeArtifactPath || ".");
    const relativeResolvedPath = path.relative(artifact.path, resolvedPath);
    if (
      relativeResolvedPath.startsWith("..") ||
      path.isAbsolute(relativeResolvedPath)
    ) {
      sendHtml(response, 404, "<h1>Artifact not found.</h1>");
      return;
    }

    if (!(await fs.pathExists(resolvedPath))) {
      sendHtml(response, 404, "<h1>Artifact not found.</h1>");
      return;
    }

    const stats = await fs.stat(resolvedPath);
    const artifactBasePath = `/artifact/${artifactId}/`;

    if (stats.isDirectory()) {
      const htmlIndexPath = ["index.html", "index.htm"]
        .map((fileName) => path.join(resolvedPath, fileName))
        .find((filePath) => fs.existsSync(filePath));

      if (htmlIndexPath) {
        const html = await fs.readFile(htmlIndexPath, "utf8");
        sendHtml(response, 200, rewriteHtml(html, artifactBasePath));
        return;
      }

      const files = await listArtifactFiles(resolvedPath);
      const body = files
        .map(
          (filePath) =>
            `<li><a href="${artifactBasePath}${encodeURI(filePath)}" target="_blank" rel="noreferrer">${escapeHtml(
              filePath
            )}</a></li>`
        )
        .join("");
      sendHtml(
        response,
        200,
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(artifact.label)}</title>
    <style>
      body {
        margin: 0;
        padding: 24px;
        background: #111114;
        color: #e4e4e7;
        font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      a {
        color: #d97757;
      }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(artifact.label)}</h1>
    <p>${escapeHtml(artifact.path)}</p>
    <ul>${body || "<li>No files found.</li>"}</ul>
  </body>
</html>`
      );
      return;
    }

    const mimeType = inferMimeType(resolvedPath);
    if (mimeType.startsWith("text/html")) {
      const html = await fs.readFile(resolvedPath, "utf8");
      sendHtml(response, 200, rewriteHtml(html, artifactBasePath));
      return;
    }

    response.writeHead(200, { "content-type": mimeType });
    fs.createReadStream(resolvedPath).pipe(response);
  }

  private renderAppHtml(): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Skill autoresearch monitor</title>
    <style>
      :root {
        color-scheme: dark;
        --paper: #111114;
        --ink: #e4e4e7;
        --muted: rgba(228, 228, 231, 0.55);
        --line: rgba(228, 228, 231, 0.12);
        --accent: #d97757;
        --accent-strong: #e8896a;
        --panel: rgba(26, 26, 31, 0.92);
        --shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background:
          linear-gradient(135deg, rgba(217, 119, 87, 0.06), transparent 28%),
          linear-gradient(210deg, rgba(228, 228, 231, 0.04), transparent 36%),
          var(--paper);
        color: var(--ink);
        font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .shell {
        display: grid;
        gap: 20px;
        min-height: 100vh;
        padding: 20px;
      }

      .header {
        display: grid;
        gap: 14px;
        grid-template-columns: minmax(0, 1.3fr) minmax(280px, 0.7fr);
      }

      .masthead,
      .queue,
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        box-shadow: var(--shadow);
      }

      .masthead,
      .queue {
        padding: 20px;
      }

      .eyebrow {
        margin: 0 0 10px;
        color: var(--accent-strong);
        font-family: "Courier New", monospace;
        font-size: 13px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      h1 {
        margin: 0;
        font-size: clamp(34px, 5vw, 60px);
        line-height: 0.98;
        letter-spacing: -0.03em;
      }

      .subhead {
        margin: 14px 0 0;
        max-width: 56ch;
        color: var(--muted);
        font-size: 16px;
        line-height: 1.6;
      }

      .progress-track {
        height: 10px;
        margin-top: 16px;
        background: rgba(228, 228, 231, 0.06);
      }

      .progress-fill {
        width: 0%;
        height: 100%;
        background: linear-gradient(90deg, var(--accent), var(--accent-strong));
        transition: width 180ms ease-out;
      }

      .queue-list {
        margin: 16px 0 0;
        padding: 0;
        list-style: none;
      }

      .queue-step {
        margin-top: 12px;
        color: var(--accent-strong);
        font-family: "Courier New", monospace;
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .queue-list li + li {
        margin-top: 10px;
      }

      .queue-item {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        padding: 12px 14px;
        border: 1px solid var(--line);
        background: rgba(26, 26, 31, 0.65);
        font-size: 14px;
      }

      .step-browser {
        display: grid;
        gap: 16px;
        padding: 20px;
        background: rgba(26, 26, 31, 0.94);
        border: 1px solid var(--line);
        box-shadow: var(--shadow);
      }

      .step-browser-copy {
        margin: 0;
        max-width: 72ch;
        color: var(--muted);
        font-size: 15px;
        line-height: 1.6;
      }

      .step-tabs {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      }

      .step-tab {
        display: grid;
        gap: 8px;
        padding: 16px;
        text-align: left;
        border-color: var(--line);
        background: rgba(26, 26, 31, 0.74);
        color: var(--ink);
      }

      .step-tab[aria-pressed="true"] {
        border-color: var(--accent-strong);
        background:
          linear-gradient(135deg, rgba(217, 119, 87, 0.1), transparent 72%),
          rgba(26, 26, 31, 0.94);
      }

      .step-tab[data-outcome="accepted"] {
        border-left: 4px solid #6ee7b7;
      }

      .step-tab[data-outcome="rejected"] {
        border-left: 4px solid #f87171;
      }

      .step-tab[data-outcome="current"] {
        border-left: 4px solid var(--accent-strong);
      }

      .step-tab-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .step-tab-title strong {
        font-size: 17px;
      }

      .step-tab-outcome {
        color: var(--muted);
        font-family: "Courier New", monospace;
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .step-tab-meta {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.5;
      }

      .workspace {
        display: grid;
        gap: 20px;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      }

      .workspace[hidden] {
        display: none;
      }

      .panel {
        display: grid;
        grid-template-rows: auto auto minmax(0, 1fr);
        min-height: 100vh;
      }

      .panel-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 18px 10px;
        border-bottom: 1px solid var(--line);
      }

      .panel-heading {
        display: grid;
        gap: 4px;
      }

      .panel-title-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .panel-title {
        margin: 0;
        font-size: 24px;
        line-height: 1.1;
      }

      .panel-badge {
        display: inline-flex;
        align-items: center;
        padding: 5px 8px;
        border: 1px solid var(--line);
        background: rgba(26, 26, 31, 0.76);
        font-family: "Courier New", monospace;
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .panel-badge[data-tone="winner"] {
        border-color: rgba(110, 231, 183, 0.24);
        color: #6ee7b7;
        background: rgba(110, 231, 183, 0.08);
      }

      .panel-badge[data-tone="loser"] {
        border-color: rgba(248, 113, 113, 0.22);
        color: #f87171;
        background: rgba(248, 113, 113, 0.08);
      }

      .panel-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 10px;
      }

      .panel-path {
        color: var(--muted);
        font-family: "Courier New", monospace;
        font-size: 12px;
        word-break: break-all;
      }

      .panel-copy {
        padding: 0 18px 14px;
      }

      .preview-shell {
        padding: 0 18px 18px;
        min-height: 0;
      }

      .preview-shell[hidden] {
        display: none;
      }

      .frame-wrap {
        position: relative;
        width: 100%;
        height: 100%;
        min-height: ${DEFAULT_PREVIEW_HEIGHT}px;
        overflow: hidden;
        border: 1px solid var(--line);
        background:
          linear-gradient(180deg, rgba(228, 228, 231, 0.03), transparent 24%),
          #1a1a1f;
      }

      iframe {
        display: block;
        border: 0;
        background: #1a1a1f;
        transform-origin: top left;
        overflow: auto;
      }

      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        justify-content: space-between;
        padding: 20px;
        background: rgba(26, 26, 31, 0.94);
        border: 1px solid var(--line);
        box-shadow: var(--shadow);
      }

      .controls-copy {
        display: grid;
        gap: 4px;
      }

      .controls-copy strong {
        font-size: 18px;
      }

      .controls-copy span {
        color: var(--muted);
      }

      .controls-tools {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        justify-content: flex-end;
      }

      .controls-tools[hidden] {
        display: none;
      }

      .viewport-picker {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        padding: 8px;
        border: 1px solid var(--line);
        background: rgba(26, 26, 31, 0.68);
      }

      .viewport-label {
        color: var(--muted);
        font-family: "Courier New", monospace;
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      button,
      .link-button {
        appearance: none;
        border: 1px solid var(--ink);
        background: var(--ink);
        color: #e4e4e7;
        cursor: pointer;
        font: inherit;
        padding: 12px 18px;
        text-decoration: none;
        transition: transform 140ms ease, background-color 140ms ease;
      }

      [hidden] {
        display: none !important;
      }

      button[data-variant="secondary"],
      .link-button[data-variant="secondary"] {
        background: transparent;
        color: var(--ink);
      }

      button.viewport-button {
        min-width: 72px;
        padding: 9px 14px;
        background: transparent;
        color: var(--ink);
      }

      button.viewport-button[aria-pressed="true"] {
        background: var(--ink);
        color: #e4e4e7;
      }

      button:disabled,
      .link-button[aria-disabled="true"] {
        opacity: 0.5;
        cursor: not-allowed;
        pointer-events: none;
      }

      button:hover:not(:disabled),
      .link-button:hover:not([aria-disabled="true"]) {
        transform: translateY(-1px);
      }

      .status {
        padding: 0 20px 20px;
        color: var(--muted);
        font-size: 14px;
      }

      .diff-section {
        display: grid;
        gap: 16px;
        padding: 22px;
        background: rgba(26, 26, 31, 0.94);
        border: 1px solid var(--line);
        box-shadow: var(--shadow);
      }

      .diff-section[hidden] {
        display: none;
      }

      .diff-header {
        display: grid;
        gap: 8px;
      }

      .diff-header-row {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
      }

      .diff-header-tools {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
      }

      .diff-title {
        margin: 0;
        font-size: clamp(24px, 3vw, 34px);
        line-height: 1.04;
        letter-spacing: -0.02em;
      }

      .diff-toggle {
        display: inline-flex;
        flex-wrap: wrap;
        padding: 5px;
        border: 1px solid var(--line);
        background: rgba(26, 26, 31, 0.7);
      }

      .diff-toggle[hidden] {
        display: none;
      }

      .diff-toggle-button {
        padding: 8px 12px;
        border: 0;
        background: transparent;
        color: var(--muted);
        font-family: "Courier New", monospace;
        font-size: 12px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .diff-toggle-button[aria-pressed="true"] {
        background: var(--ink);
        color: #e4e4e7;
      }

      .diff-summary {
        color: var(--muted);
        font-family: "Courier New", monospace;
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .diff-subhead {
        margin: 0;
        max-width: 72ch;
        color: var(--muted);
        font-size: 15px;
        line-height: 1.6;
      }

      .diff-files {
        display: grid;
        gap: 16px;
      }

      .diff-empty {
        padding: 18px 20px;
        border: 1px solid var(--line);
        background: rgba(26, 26, 31, 0.72);
        color: var(--muted);
        font-size: 15px;
        line-height: 1.6;
      }

      .diff-file {
        overflow: hidden;
        border: 1px solid var(--line);
        background: rgba(26, 26, 31, 0.75);
      }

      .diff-file-header {
        position: sticky;
        top: 0;
        z-index: 1;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px;
        border-bottom: 1px solid var(--line);
        background:
          linear-gradient(90deg, rgba(217, 119, 87, 0.08), transparent 42%),
          rgba(26, 26, 31, 0.98);
      }

      .diff-file-path {
        margin: 0;
        font-family: "Courier New", monospace;
        font-size: 13px;
        line-height: 1.5;
        word-break: break-all;
      }

      .diff-file-meta {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
      }

      .diff-pill {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border: 1px solid var(--line);
        background: rgba(26, 26, 31, 0.78);
        font-family: "Courier New", monospace;
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .diff-pill[data-tone="added"] {
        border-color: rgba(110, 231, 183, 0.24);
        color: #6ee7b7;
        background: rgba(110, 231, 183, 0.08);
      }

      .diff-pill[data-tone="removed"] {
        border-color: rgba(248, 113, 113, 0.22);
        color: #f87171;
        background: rgba(248, 113, 113, 0.08);
      }

      .diff-code {
        overflow-x: auto;
        background:
          linear-gradient(180deg, rgba(228, 228, 231, 0.02), transparent 18%),
          rgba(17, 17, 20, 0.96);
      }

      .diff-line {
        display: grid;
        grid-template-columns: 56px 56px 22px minmax(0, 1fr);
        align-items: stretch;
        min-width: min(100%, 840px);
        border-bottom: 1px solid rgba(228, 228, 231, 0.06);
        font-family: "SFMono-Regular", "Menlo", "Monaco", "Courier New", monospace;
        font-size: 12px;
        line-height: 1.6;
      }

      .diff-line:last-child {
        border-bottom: 0;
      }

      .diff-line--added {
        background: rgba(110, 231, 183, 0.08);
      }

      .diff-line--removed {
        background: rgba(248, 113, 113, 0.08);
      }

      .diff-line--spacer {
        display: block;
        min-width: 0;
        padding: 10px 16px;
        color: var(--muted);
        font-family: "Courier New", monospace;
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        background: rgba(228, 228, 231, 0.04);
      }

      .diff-line-number,
      .diff-line-sign,
      .diff-line-code {
        padding: 6px 10px;
      }

      .diff-line-number {
        color: rgba(228, 228, 231, 0.35);
        text-align: right;
        user-select: none;
      }

      .diff-line-sign {
        color: rgba(228, 228, 231, 0.45);
        text-align: center;
        user-select: none;
      }

      .diff-line--added .diff-line-sign {
        color: #6ee7b7;
      }

      .diff-line--removed .diff-line-sign {
        color: #f87171;
      }

      .diff-line-code {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
      }

      @media (max-width: 960px) {
        .header,
        .workspace {
          grid-template-columns: 1fr;
        }

        .controls {
          align-items: flex-start;
        }

        .controls-tools {
          width: 100%;
          justify-content: flex-start;
        }

        .panel-header {
          flex-direction: column;
        }

        .panel-actions {
          justify-content: flex-start;
        }

        .diff-file-header {
          position: static;
        }

        .diff-line {
          grid-template-columns: 48px 48px 18px minmax(240px, 1fr);
        }

        .diff-header-tools {
          width: 100%;
          justify-content: flex-start;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="header">
        <div class="masthead">
          <p class="eyebrow">Skill autoresearch</p>
          <h1>Track the current artifact pair.</h1>
          <p class="subhead">The monitor keeps the latest comparison in view, and switches into side-by-side voting when human scoring is active. Progress updates automatically.</p>
        </div>
        <aside class="queue">
          <p class="eyebrow">Progress</p>
          <div class="queue-step" id="queue-step">Current step · Loading\u2026</div>
          <div id="queue-summary">Connecting…</div>
          <div class="progress-track" aria-hidden="true">
            <div class="progress-fill" id="progress-fill"></div>
          </div>
          <ul class="queue-list" id="queue-list"></ul>
        </aside>
      </section>

      <section class="step-browser">
        <div>
          <p class="eyebrow">Step viewer</p>
        </div>
        <div class="step-tabs" id="step-tabs"></div>
      </section>

      <section class="controls">
        <div class="controls-copy">
          <strong id="prompt-title">Loading\u2026</strong>
          <span id="prompt-meta"></span>
        </div>
        <div class="controls-tools" id="preview-controls" hidden>
          <div class="viewport-picker" role="group" aria-label="Preview viewport">
            <span class="viewport-label">Viewport</span>
            <button class="viewport-button" type="button" data-viewport="${PREVIEW_VIEWPORTS[0]}" aria-pressed="false">${PREVIEW_VIEWPORTS[0]}px</button>
            <button class="viewport-button" type="button" data-viewport="${PREVIEW_VIEWPORTS[1]}" aria-pressed="false">${PREVIEW_VIEWPORTS[1]}px</button>
          </div>
        </div>
      </section>

      <section class="workspace" id="review-workspace" hidden>
        <article class="panel">
          <header class="panel-header">
            <div class="panel-heading">
              <div class="panel-title-row">
                <h2 class="panel-title">Incumbent</h2>
                <span class="panel-badge" id="incumbent-badge" hidden></span>
              </div>
            </div>
            <div class="panel-actions">
              <a class="link-button" id="open-incumbent" href="#" target="_blank" rel="noreferrer" data-variant="secondary" aria-disabled="true">Open</a>
              <button id="vote-incumbent" type="button" data-winner="A">Incumbent wins</button>
            </div>
          </header>
          <div class="panel-copy">
            <div class="panel-path" id="incumbent-path"></div>
          </div>
          <div class="preview-shell" id="incumbent-preview" hidden>
            <div class="frame-wrap" id="incumbent-wrap">
              <iframe id="incumbent-frame" title="Incumbent artifact" loading="eager"></iframe>
            </div>
          </div>
        </article>
        <article class="panel">
          <header class="panel-header">
            <div class="panel-heading">
              <div class="panel-title-row">
                <h2 class="panel-title" id="candidate-label">Candidate</h2>
                <span class="panel-badge" id="candidate-badge" hidden></span>
              </div>
            </div>
            <div class="panel-actions">
              <a class="link-button" id="open-candidate" href="#" target="_blank" rel="noreferrer" data-variant="secondary" aria-disabled="true">Open</a>
              <button id="vote-candidate" type="button" data-winner="B">Candidate wins</button>
            </div>
          </header>
          <div class="panel-copy">
            <div class="panel-path" id="candidate-path"></div>
          </div>
          <div class="preview-shell" id="candidate-preview" hidden>
            <div class="frame-wrap" id="candidate-wrap">
              <iframe id="candidate-frame" title="Candidate artifact" loading="eager"></iframe>
            </div>
          </div>
        </article>
      </section>

      <section class="diff-section" id="skill-diff-section" hidden>
        <div class="diff-header">
          <p class="eyebrow">Skill diff</p>
          <div class="diff-header-row">
            <h2 class="diff-title" id="skill-diff-title">Current skill diff</h2>
            <div class="diff-header-tools">
              <div class="diff-toggle" id="skill-diff-toggle" role="group" aria-label="Skill diff comparison target" hidden></div>
              <div class="diff-summary" id="skill-diff-summary"></div>
            </div>
          </div>
          <p class="diff-subhead" id="skill-diff-paths"></p>
        </div>
        <div class="diff-files" id="skill-diff-files"></div>
      </section>

      <div class="status" id="status" hidden></div>
    </main>

    <script>
      const queueStep = document.getElementById("queue-step");
      const queueSummary = document.getElementById("queue-summary");
      const queueList = document.getElementById("queue-list");
      const progressFill = document.getElementById("progress-fill");
      const stepTabs = document.getElementById("step-tabs");
      const promptTitle = document.getElementById("prompt-title");
      const promptMeta = document.getElementById("prompt-meta");
      const previewControls = document.getElementById("preview-controls");
      const reviewWorkspace = document.getElementById("review-workspace");
      const incumbentPath = document.getElementById("incumbent-path");
      const candidatePath = document.getElementById("candidate-path");
      const candidateLabel = document.getElementById("candidate-label");
      const incumbentBadge = document.getElementById("incumbent-badge");
      const candidateBadge = document.getElementById("candidate-badge");
      const incumbentPreview = document.getElementById("incumbent-preview");
      const candidatePreview = document.getElementById("candidate-preview");
      const incumbentWrap = document.getElementById("incumbent-wrap");
      const candidateWrap = document.getElementById("candidate-wrap");
      const incumbentFrame = document.getElementById("incumbent-frame");
      const candidateFrame = document.getElementById("candidate-frame");
      const openIncumbent = document.getElementById("open-incumbent");
      const openCandidate = document.getElementById("open-candidate");
      const voteIncumbent = document.getElementById("vote-incumbent");
      const voteCandidate = document.getElementById("vote-candidate");
      const skillDiffSection = document.getElementById("skill-diff-section");
      const skillDiffToggle = document.getElementById("skill-diff-toggle");
      const skillDiffTitle = document.getElementById("skill-diff-title");
      const skillDiffSummary = document.getElementById("skill-diff-summary");
      const skillDiffPaths = document.getElementById("skill-diff-paths");
      const skillDiffFiles = document.getElementById("skill-diff-files");
      const status = document.getElementById("status");
      const voteButtons = Array.from(document.querySelectorAll("button[data-winner]"));
      const viewportButtons = Array.from(document.querySelectorAll("button[data-viewport]"));

      const VIEWPORT_STORAGE_KEY = "skill-autoresearch:human-scoring:viewport";
      const SKILL_DIFF_TARGET_STORAGE_KEY = "skill-autoresearch:human-scoring:diff-target";
      const DEFAULT_VIEWPORT_WIDTH = ${DEFAULT_PREVIEW_VIEWPORT};
      const DEFAULT_FRAME_HEIGHT = ${DEFAULT_PREVIEW_HEIGHT};
      let currentSession = null;
      let selectedStepKey = "current";
      let viewportWidth = loadViewportWidth();
      let selectedSkillDiffTarget = loadSkillDiffTarget();
      const previewFrames = [
        { frame: incumbentFrame, wrap: incumbentWrap },
        { frame: candidateFrame, wrap: candidateWrap }
      ];

      function normalizeViewportWidth(rawValue) {
        const value = Number(rawValue);
        return value === ${PREVIEW_VIEWPORTS[0]} ? ${PREVIEW_VIEWPORTS[0]} : ${PREVIEW_VIEWPORTS[1]};
      }

      function loadViewportWidth() {
        try {
          return normalizeViewportWidth(window.localStorage.getItem(VIEWPORT_STORAGE_KEY));
        } catch (_error) {
          return DEFAULT_VIEWPORT_WIDTH;
        }
      }

      function saveViewportWidth(nextWidth) {
        try {
          window.localStorage.setItem(VIEWPORT_STORAGE_KEY, String(nextWidth));
        } catch (_error) {
          // Ignore storage access failures.
        }
      }

      function normalizeSkillDiffTarget(rawValue) {
        return rawValue === "original" ? "original" : "previous";
      }

      function loadSkillDiffTarget() {
        try {
          return normalizeSkillDiffTarget(
            window.localStorage.getItem(SKILL_DIFF_TARGET_STORAGE_KEY)
          );
        } catch (_error) {
          return "previous";
        }
      }

      function saveSkillDiffTarget(nextTarget) {
        try {
          window.localStorage.setItem(SKILL_DIFF_TARGET_STORAGE_KEY, nextTarget);
        } catch (_error) {
          // Ignore storage access failures.
        }
      }

      function updateViewportButtons() {
        for (const button of viewportButtons) {
          const pressed = Number(button.dataset.viewport) === viewportWidth;
          button.setAttribute("aria-pressed", pressed ? "true" : "false");
        }
      }

      function layoutPreviewFrame(preview) {
        if (!preview || !preview.frame || !preview.wrap) {
          return;
        }

        const wrapWidth = preview.wrap.clientWidth;
        const wrapHeight = preview.wrap.clientHeight;
        if (wrapWidth === 0 || wrapHeight === 0) {
          return;
        }

        const scale = Math.min(1, wrapWidth / viewportWidth);
        const intrinsicHeight = Math.max(
          DEFAULT_FRAME_HEIGHT,
          Math.round(wrapHeight / Math.max(scale, 0.01))
        );
        const scaledWidth = viewportWidth * scale;
        const horizontalOffset = Math.max(0, Math.round((wrapWidth - scaledWidth) / 2));

        preview.frame.style.position = "absolute";
        preview.frame.style.top = "0px";
        preview.frame.style.width = viewportWidth + "px";
        preview.frame.style.height = intrinsicHeight + "px";
        preview.frame.style.left = horizontalOffset + "px";
        preview.frame.style.transform = "scale(" + scale + ")";
      }

      function layoutPreviewFrames() {
        for (const preview of previewFrames) {
          layoutPreviewFrame(preview);
        }
      }

      function setOpenLinksEnabled(enabled) {
        openIncumbent.setAttribute("aria-disabled", enabled ? "false" : "true");
        openCandidate.setAttribute("aria-disabled", enabled ? "false" : "true");
      }

      function setVotingEnabled(enabled) {
        for (const button of voteButtons) {
          button.disabled = !enabled;
          button.hidden = !enabled;
        }
      }

      function resetPreviewFrame(preview) {
        preview.frame.style.position = "absolute";
        preview.frame.style.top = "0px";
        preview.frame.style.width = viewportWidth + "px";
        preview.frame.style.height = DEFAULT_FRAME_HEIGHT + "px";
        preview.frame.style.left = "0px";
        preview.frame.style.transform = "scale(1)";
      }

      function clearPreviewFrame(preview) {
        preview.frame.style.position = "absolute";
        preview.frame.style.top = "0px";
        preview.frame.style.left = "0px";
        preview.frame.style.transform = "scale(1)";
        preview.frame.removeAttribute("src");
      }

      function updateViewportWidth(nextWidth) {
        viewportWidth = normalizeViewportWidth(nextWidth);
        saveViewportWidth(viewportWidth);
        updateViewportButtons();
        layoutPreviewFrames();
      }

      function clearFrames() {
        incumbentPath.textContent = "";
        candidatePath.textContent = "";
        candidateLabel.textContent = "Candidate";
        clearPreviewFrame(previewFrames[0]);
        clearPreviewFrame(previewFrames[1]);
        setPanelBadge(incumbentBadge, "", "");
        setPanelBadge(candidateBadge, "", "");
        setOpenLink(openIncumbent, null);
        setOpenLink(openCandidate, null);
      }

      function pluralize(count, singular, plural) {
        return count === 1 ? singular : plural;
      }

      function createDiffPill(text, tone) {
        const pill = document.createElement("span");
        pill.className = "diff-pill";
        if (tone) {
          pill.dataset.tone = tone;
        }
        pill.textContent = text;
        return pill;
      }

      function setOpenLink(link, url) {
        link.href = url || "#";
        link.setAttribute("aria-disabled", url ? "false" : "true");
      }

      function setStatusText(message) {
        status.hidden = !message;
        status.textContent = message || "";
      }

      function setVoteVisibility(visible) {
        voteIncumbent.hidden = !visible;
        voteCandidate.hidden = !visible;
      }

      function setPanelBadge(element, text, tone) {
        if (!text) {
          element.hidden = true;
          element.textContent = "";
          delete element.dataset.tone;
          return;
        }

        element.hidden = false;
        element.textContent = text;
        element.dataset.tone = tone;
      }

      function clearSkillDiff(title) {
        skillDiffSection.hidden = true;
        skillDiffToggle.hidden = true;
        skillDiffToggle.innerHTML = "";
        skillDiffTitle.textContent = title || "Skill diff";
        skillDiffSummary.textContent = "";
        skillDiffPaths.textContent = "";
        skillDiffFiles.innerHTML = "";
      }

      function resolveSkillDiffTarget(skillDiff) {
        const targets = skillDiff && skillDiff.targets ? skillDiff.targets : null;
        if (!targets) {
          return null;
        }

        const availableTargets = ["previous", "original"].filter((target) => Boolean(targets[target]));
        if (availableTargets.length === 0) {
          return null;
        }

        if (availableTargets.includes(selectedSkillDiffTarget)) {
          return selectedSkillDiffTarget;
        }

        if (availableTargets.includes(skillDiff.preferredTarget)) {
          return skillDiff.preferredTarget;
        }

        return availableTargets[0];
      }

      function renderSkillDiffToggle(skillDiff, activeTarget) {
        const availableTargets = ["previous", "original"].filter((target) =>
          Boolean(skillDiff.targets && skillDiff.targets[target])
        );

        skillDiffToggle.innerHTML = "";
        skillDiffToggle.hidden = availableTargets.length < 2;
        if (availableTargets.length < 2) {
          return;
        }

        for (const target of availableTargets) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "diff-toggle-button";
          button.textContent = target === "previous" ? "Previous step" : "Original";
          button.setAttribute("aria-pressed", target === activeTarget ? "true" : "false");
          button.addEventListener("click", () => {
            selectedSkillDiffTarget = target;
            saveSkillDiffTarget(target);
            if (currentSession) {
              render(currentSession);
            }
          });
          skillDiffToggle.appendChild(button);
        }
      }

      function renderSkillDiff(skillDiff, title) {
        if (!skillDiff || !skillDiff.visible) {
          clearSkillDiff(title);
          return;
        }

        const activeTarget = resolveSkillDiffTarget(skillDiff);
        if (!activeTarget) {
          clearSkillDiff(title);
          return;
        }

        const activeDiff = skillDiff.targets[activeTarget];
        if (!activeDiff) {
          clearSkillDiff(title);
          return;
        }

        skillDiffSection.hidden = false;
        renderSkillDiffToggle(skillDiff, activeTarget);
        skillDiffTitle.textContent = title;
        skillDiffSummary.textContent =
          activeDiff.changedFileCount +
          " " +
          pluralize(activeDiff.changedFileCount, "changed file", "changed files") +
          " \u00B7 " +
          activeDiff.label;
        skillDiffPaths.textContent =
          activeDiff.basePath + " compared with " + activeDiff.currentPath;
        skillDiffFiles.innerHTML = "";

        if (activeDiff.changedFileCount === 0) {
          const empty = document.createElement("div");
          empty.className = "diff-empty";
          empty.textContent = "No skill changes compared with " + activeDiff.label + ".";
          skillDiffFiles.appendChild(empty);
          return;
        }

        for (const file of activeDiff.files) {
          const card = document.createElement("article");
          card.className = "diff-file";

          const header = document.createElement("header");
          header.className = "diff-file-header";

          const filePath = document.createElement("p");
          filePath.className = "diff-file-path";
          filePath.textContent = file.path;

          const meta = document.createElement("div");
          meta.className = "diff-file-meta";
          meta.appendChild(createDiffPill(file.status, null));
          meta.appendChild(
            createDiffPill(
              "+" + file.addedLineCount + " " + pluralize(file.addedLineCount, "line", "lines"),
              "added"
            )
          );
          meta.appendChild(
            createDiffPill(
              "-" +
                file.removedLineCount +
                " " +
                pluralize(file.removedLineCount, "line", "lines"),
              "removed"
            )
          );

          header.appendChild(filePath);
          header.appendChild(meta);

          const code = document.createElement("div");
          code.className = "diff-code";

          for (const line of file.lines) {
            if (line.type === "spacer") {
              const spacer = document.createElement("div");
              spacer.className = "diff-line diff-line--spacer";
              spacer.textContent =
                (line.omittedLineCount ?? 0) +
                " unchanged " +
                pluralize(line.omittedLineCount ?? 0, "line", "lines");
              code.appendChild(spacer);
              continue;
            }

            const row = document.createElement("div");
            row.className = "diff-line diff-line--" + line.type;

            const oldNumber = document.createElement("span");
            oldNumber.className = "diff-line-number";
            oldNumber.textContent =
              line.oldLineNumber === null ? "" : String(line.oldLineNumber);

            const newNumber = document.createElement("span");
            newNumber.className = "diff-line-number";
            newNumber.textContent =
              line.newLineNumber === null ? "" : String(line.newLineNumber);

            const sign = document.createElement("span");
            sign.className = "diff-line-sign";
            sign.textContent =
              line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";

            const content = document.createElement("pre");
            content.className = "diff-line-code";
            content.textContent = line.text.length === 0 ? " " : line.text;

            row.appendChild(oldNumber);
            row.appendChild(newNumber);
            row.appendChild(sign);
            row.appendChild(content);
            code.appendChild(row);
          }

          card.appendChild(header);
          card.appendChild(code);
          skillDiffFiles.appendChild(card);
        }
      }

      function getStepViews(session) {
        return Array.isArray(session?.stepViews) ? session.stepViews : [];
      }

      function ensureSelectedStep(session) {
        const stepViews = getStepViews(session);
        if (stepViews.some((view) => view.key === selectedStepKey)) {
          return;
        }

        selectedStepKey = stepViews.some((view) => view.key === "current")
          ? "current"
          : stepViews[0]?.key || "current";
      }

      function getSelectedStepView(session) {
        ensureSelectedStep(session);
        return getStepViews(session).find((view) => view.key === selectedStepKey) || null;
      }

      function renderStepTabs(session) {
        const stepViews = getStepViews(session);
        stepTabs.innerHTML = "";

        for (const view of stepViews) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "step-tab";
          button.dataset.outcome = view.outcome;
          button.setAttribute("aria-pressed", view.key === selectedStepKey ? "true" : "false");
          button.addEventListener("click", () => {
            selectedStepKey = view.key;
            if (currentSession) {
              render(currentSession);
            }
          });

          const title = document.createElement("div");
          title.className = "step-tab-title";

          const heading = document.createElement("strong");
          heading.textContent = view.title;

          const outcome = document.createElement("span");
          outcome.className = "step-tab-outcome";
          outcome.textContent = view.outcome === "current" ? "live" : view.outcome;

          const meta = document.createElement("div");
          meta.className = "step-tab-meta";
          meta.textContent = view.phaseLabel;

          const detail = document.createElement("div");
          detail.className = "step-tab-meta";
          detail.textContent = view.winnerLabel;

          title.appendChild(heading);
          title.appendChild(outcome);
          button.appendChild(title);
          button.appendChild(meta);
          button.appendChild(detail);
          stepTabs.appendChild(button);
        }
      }

      function setPreviewVisibility(visible) {
        previewControls.hidden = !visible;
        reviewWorkspace.hidden = !visible;
        incumbentPreview.hidden = !visible;
        candidatePreview.hidden = !visible;

        if (visible) {
          layoutPreviewFrames();
        }
      }

      function renderSelectedStep(view) {
        const diffTitle = (view?.title || "Current") + " skill diff";
        promptTitle.textContent = view?.phaseLabel || "Loading\u2026";
        promptMeta.textContent = view?.summary || "";
        renderSkillDiff(view?.skillDiff || null, diffTitle);

        const incumbentView = view?.incumbent || null;
        const candidateView = view?.candidate || null;
        const canPreview =
          Boolean(incumbentView?.url) &&
          Boolean(candidateView?.url);

        if (!canPreview || !incumbentView || !candidateView) {
          setPreviewVisibility(false);
          clearFrames();
          setVotingEnabled(false);
          setVoteVisibility(false);
          setStatusText(view?.statusText || "");
          return;
        }

        candidateLabel.textContent = candidateView.label || "Candidate";
        incumbentPath.textContent = incumbentView.path || "";
        candidatePath.textContent = candidateView.path || "";
        resetPreviewFrame(previewFrames[0]);
        resetPreviewFrame(previewFrames[1]);
        setPreviewVisibility(true);
        incumbentFrame.src = incumbentView.url;
        candidateFrame.src = candidateView.url;
        setOpenLink(openIncumbent, incumbentView.url);
        setOpenLink(openCandidate, candidateView.url);
        setVotingEnabled(Boolean(view?.canVote));
        setVoteVisibility(Boolean(view?.canVote));
        setPanelBadge(
          incumbentBadge,
          view?.outcome === "current"
            ? ""
            : incumbentView.isWinner
              ? "Won"
              : "Lost",
          incumbentView.isWinner ? "winner" : "loser"
        );
        setPanelBadge(
          candidateBadge,
          view?.outcome === "current"
            ? ""
            : candidateView.isWinner
              ? "Won"
              : "Lost",
          candidateView.isWinner ? "winner" : "loser"
        );
        setStatusText(view?.statusText || "");
      }

      function render(session) {
        currentSession = session;
        const ratio = session.totalUnits === 0 ? 0 : session.completedUnits / session.totalUnits;
        progressFill.style.width = (ratio * 100).toFixed(1) + "%";
        queueStep.textContent = "Current step · " + session.phaseLabel;
        queueSummary.textContent = session.summary;

        queueList.innerHTML = "";
        for (const candidate of session.candidates) {
          const item = document.createElement("li");
          item.className = "queue-item";
          item.innerHTML =
            "<span>Candidate " + candidate.index + " \u00B7 " + candidate.status + "</span>" +
            "<span>" + candidate.completedVotes + " / " + candidate.totalVotes + " votes</span>";
          queueList.appendChild(item);
        }

        renderStepTabs(session);
        renderSelectedStep(getSelectedStepView(session));
      }

      async function loadInitialSession() {
        const response = await fetch("/api/session", { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Couldn\u2019t load the review session.");
        }

        render(await response.json());
      }

      async function submitVote(winner) {
        if (
          !currentSession ||
          currentSession.mode !== "review" ||
          !currentSession.current ||
          !currentSession.current.votingEnabled
        ) {
          return;
        }

        setVotingEnabled(false);
        status.textContent = "Saving\u2026";

        const response = await fetch("/api/vote", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            candidateIndex: currentSession.current.candidateIndex,
            attempt: currentSession.current.attempt,
            winner
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          status.textContent = errorText || "Couldn\u2019t save that vote. Try again.";
          return;
        }

        render(await response.json());
      }

      voteButtons.forEach((button) => {
        button.addEventListener("click", () => {
          submitVote(button.dataset.winner);
        });
      });

      viewportButtons.forEach((button) => {
        button.addEventListener("click", () => {
          updateViewportWidth(button.dataset.viewport);
        });
      });

      previewFrames.forEach((preview) => {
        preview.frame.addEventListener("load", () => {
          layoutPreviewFrames();
        });
      });

      const previewResizeObserver =
        typeof ResizeObserver === "function"
          ? new ResizeObserver(() => {
              layoutPreviewFrames();
            })
          : null;
      if (previewResizeObserver) {
        previewFrames.forEach((preview) => {
          previewResizeObserver.observe(preview.wrap);
        });
      } else {
        window.addEventListener("resize", layoutPreviewFrames);
      }

      updateViewportButtons();
      layoutPreviewFrames();

      loadInitialSession().catch((error) => {
        status.textContent = error instanceof Error ? error.message : String(error);
      });

      const stream = new EventSource("/events");
      stream.addEventListener("session", (event) => {
        render(JSON.parse(event.data));
      });
      stream.onerror = () => {
        status.textContent = "Connection lost. Reload the page to reconnect.";
      };
    </script>
  </body>
</html>`;
  }
}
