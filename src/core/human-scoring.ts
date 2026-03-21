import fs from "fs-extra";
import { spawn } from "node:child_process";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";
import { URL } from "node:url";

import { Logger } from "./logger.js";
import { ScoreVote } from "../types/rubric.js";
import { RunState } from "../types/state.js";

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

const ARTIFACT_HEIGHT_MESSAGE_TYPE = "skill-autoresearch:artifact-height";
const PREVIEW_VIEWPORTS = [480, 960] as const;
const DEFAULT_PREVIEW_VIEWPORT = 960;
const MIN_PREVIEW_HEIGHT = 320;
const DEFAULT_PREVIEW_HEIGHT = 420;

function buildArtifactHeightBridgeScript(): string {
  return String.raw`<script>
    (() => {
      let scheduled = false;
      let lastViewportWidth = window.innerWidth;

      const measureHeight = () => {
        const root = document.documentElement;
        const body = document.body;

        return Math.max(
          root ? root.scrollHeight : 0,
          root ? root.offsetHeight : 0,
          body ? body.scrollHeight : 0,
          body ? body.offsetHeight : 0
        );
      };

      const postHeight = () => {
        scheduled = false;
        window.parent.postMessage(
          {
            type: "${ARTIFACT_HEIGHT_MESSAGE_TYPE}",
            height: measureHeight()
          },
          "*"
        );
      };

      const schedulePost = () => {
        if (scheduled) {
          return;
        }

        scheduled = true;
        window.requestAnimationFrame(postHeight);
      };

      window.addEventListener("load", () => {
        lastViewportWidth = window.innerWidth;
        schedulePost();
      });
      window.addEventListener("resize", () => {
        if (window.innerWidth === lastViewportWidth) {
          return;
        }

        lastViewportWidth = window.innerWidth;
        schedulePost();
      });
      document.addEventListener("DOMContentLoaded", schedulePost);

      if (typeof MutationObserver === "function" && document.documentElement) {
        const mutationObserver = new MutationObserver(schedulePost);
        mutationObserver.observe(document.documentElement, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true
        });
      }

      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(schedulePost).catch(() => {});
      }

      schedulePost();
    })();
  </script>`;
}

function injectScriptBeforeBodyClose(html: string, script: string): string {
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${script}</body>`);
  }

  return `${html}${script}`;
}

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

  return injectScriptBeforeBodyClose(withBase, buildArtifactHeightBridgeScript());
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
  private readonly eventClients = new Set<ServerResponse>();

  public constructor(
    private readonly logger: Logger,
    private readonly browserOpener: BrowserOpener = new SystemBrowserOpener()
  ) {}

  public async startRun(state: RunState): Promise<void> {
    this.latestState = structuredClone(state);
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
        this.logger.phase(`Human scoring ready at ${this.baseUrl}`);
        void this.browserOpener
          .open(this.baseUrl)
          .then(() => {
            this.logger.info(`Opened human scoring in the default browser: ${this.baseUrl}`);
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
    const currentReview = this.buildCurrentReview();

    return {
      mode,
      runId: this.latestState?.runId ?? null,
      stepIndex: this.latestState?.stepIndex ?? 0,
      phaseLabel,
      summary,
      voteCount:
        this.activeReview?.input.voteCount ?? this.latestState?.voteCount ?? 0,
      completedUnits: progress.completed,
      totalUnits: progress.total,
      current: currentReview,
      candidates
    };
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

  private buildCurrentReview() {
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

    return {
      candidateIndex: current.candidateIndex,
      attempt: current.attempt,
      comparisonNumber: this.activeReview.activeIndex + 1,
      incumbentPath: this.activeReview.input.incumbentPath,
      candidatePath: candidate.path,
      incumbentUrl: `${this.baseUrl}/artifact/incumbent/`,
      candidateUrl: `${this.baseUrl}/artifact/candidate-${current.candidateIndex}/`
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
    const artifacts = this.activeReview?.artifacts;
    const artifact = artifacts?.get(artifactId);
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
        background: #f5f0e8;
        color: #1b1713;
        font-family: Georgia, "Times New Roman", serif;
      }

      a {
        color: #b43f28;
      }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(artifact.label)}</h1>
    <p>${escapeHtml(artifact.path)}</p>
    <ul>${body || "<li>No files found.</li>"}</ul>
    ${buildArtifactHeightBridgeScript()}
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
    <title>Human scoring</title>
    <style>
      :root {
        color-scheme: light;
        --paper: #f4eee4;
        --ink: #17120d;
        --muted: rgba(23, 18, 13, 0.72);
        --line: rgba(23, 18, 13, 0.14);
        --accent: #b43f28;
        --accent-strong: #8d2714;
        --panel: rgba(255, 252, 247, 0.92);
        --shadow: 0 24px 60px rgba(63, 37, 19, 0.14);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background:
          linear-gradient(135deg, rgba(180, 63, 40, 0.08), transparent 28%),
          linear-gradient(210deg, rgba(23, 18, 13, 0.08), transparent 36%),
          var(--paper);
        color: var(--ink);
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, serif;
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
        background: rgba(23, 18, 13, 0.08);
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

      .queue-list li + li {
        margin-top: 10px;
      }

      .queue-item {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        padding: 12px 14px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.65);
        font-size: 14px;
      }

      .workspace {
        display: grid;
        gap: 20px;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      }

      .panel {
        display: grid;
        align-content: start;
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

      .panel-title {
        margin: 0;
        font-size: 24px;
        line-height: 1.1;
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
      }

      .frame-wrap {
        position: relative;
        width: 100%;
        min-height: ${MIN_PREVIEW_HEIGHT}px;
        overflow: hidden;
        border: 1px solid var(--line);
        background:
          linear-gradient(180deg, rgba(23, 18, 13, 0.04), transparent 24%),
          #ffffff;
      }

      .frame-wrap[data-scaled="true"] iframe {
        position: absolute;
        top: 0;
      }

      iframe {
        display: block;
        border: 0;
        background: white;
        transform-origin: top left;
      }

      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        justify-content: space-between;
        padding: 20px;
        background: rgba(255, 252, 247, 0.94);
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

      .viewport-picker {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        padding: 8px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.68);
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
        color: #fffaf4;
        cursor: pointer;
        font: inherit;
        padding: 12px 18px;
        text-decoration: none;
        transition: transform 140ms ease, background-color 140ms ease;
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
        color: #fffaf4;
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
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="header">
        <div class="masthead">
          <p class="eyebrow">Human scoring</p>
          <h1>Pick the stronger artifact.</h1>
          <p class="subhead">Compare two versions of an artifact side by side and vote for the one that looks better. Progress updates automatically.</p>
        </div>
        <aside class="queue">
          <p class="eyebrow">Progress</p>
          <div id="queue-summary">Connecting…</div>
          <div class="progress-track" aria-hidden="true">
            <div class="progress-fill" id="progress-fill"></div>
          </div>
          <ul class="queue-list" id="queue-list"></ul>
        </aside>
      </section>

      <section class="controls">
        <div class="controls-copy">
          <strong id="prompt-title">Loading\u2026</strong>
          <span id="prompt-meta"></span>
        </div>
        <div class="controls-tools">
          <div class="viewport-picker" role="group" aria-label="Preview viewport">
            <span class="viewport-label">Viewport</span>
            <button class="viewport-button" type="button" data-viewport="${PREVIEW_VIEWPORTS[0]}" aria-pressed="false">${PREVIEW_VIEWPORTS[0]}px</button>
            <button class="viewport-button" type="button" data-viewport="${PREVIEW_VIEWPORTS[1]}" aria-pressed="false">${PREVIEW_VIEWPORTS[1]}px</button>
          </div>
        </div>
      </section>

      <section class="workspace">
        <article class="panel">
          <header class="panel-header">
            <div class="panel-heading">
              <h2 class="panel-title">Incumbent</h2>
            </div>
            <div class="panel-actions">
              <a class="link-button" id="open-incumbent" href="#" target="_blank" rel="noreferrer" data-variant="secondary" aria-disabled="true">Open</a>
              <button id="vote-incumbent" type="button" data-winner="A">Incumbent wins</button>
            </div>
          </header>
          <div class="panel-copy">
            <div class="panel-path" id="incumbent-path"></div>
          </div>
          <div class="preview-shell">
            <div class="frame-wrap" id="incumbent-wrap">
              <iframe id="incumbent-frame" title="Incumbent artifact" loading="eager"></iframe>
            </div>
          </div>
        </article>
        <article class="panel">
          <header class="panel-header">
            <div class="panel-heading">
              <h2 class="panel-title" id="candidate-label">Candidate</h2>
            </div>
            <div class="panel-actions">
              <a class="link-button" id="open-candidate" href="#" target="_blank" rel="noreferrer" data-variant="secondary" aria-disabled="true">Open</a>
              <button id="vote-candidate" type="button" data-winner="B">Candidate wins</button>
            </div>
          </header>
          <div class="panel-copy">
            <div class="panel-path" id="candidate-path"></div>
          </div>
          <div class="preview-shell">
            <div class="frame-wrap" id="candidate-wrap">
              <iframe id="candidate-frame" title="Candidate artifact" loading="eager"></iframe>
            </div>
          </div>
        </article>
      </section>

      <div class="status" id="status"></div>
    </main>

    <script>
      const queueSummary = document.getElementById("queue-summary");
      const queueList = document.getElementById("queue-list");
      const progressFill = document.getElementById("progress-fill");
      const promptTitle = document.getElementById("prompt-title");
      const promptMeta = document.getElementById("prompt-meta");
      const incumbentPath = document.getElementById("incumbent-path");
      const candidatePath = document.getElementById("candidate-path");
      const candidateLabel = document.getElementById("candidate-label");
      const incumbentWrap = document.getElementById("incumbent-wrap");
      const candidateWrap = document.getElementById("candidate-wrap");
      const incumbentFrame = document.getElementById("incumbent-frame");
      const candidateFrame = document.getElementById("candidate-frame");
      const openIncumbent = document.getElementById("open-incumbent");
      const openCandidate = document.getElementById("open-candidate");
      const status = document.getElementById("status");
      const voteButtons = Array.from(document.querySelectorAll("button[data-winner]"));
      const viewportButtons = Array.from(document.querySelectorAll("button[data-viewport]"));

      const VIEWPORT_STORAGE_KEY = "skill-autoresearch:human-scoring:viewport";
      const FRAME_HEIGHT_MESSAGE_TYPE = "${ARTIFACT_HEIGHT_MESSAGE_TYPE}";
      const DEFAULT_VIEWPORT_WIDTH = ${DEFAULT_PREVIEW_VIEWPORT};
      const DEFAULT_FRAME_HEIGHT = ${DEFAULT_PREVIEW_HEIGHT};
      const MIN_FRAME_HEIGHT = ${MIN_PREVIEW_HEIGHT};
      let currentSession = null;
      let viewportWidth = loadViewportWidth();
      const previewFrames = [
        { frame: incumbentFrame, wrap: incumbentWrap },
        { frame: candidateFrame, wrap: candidateWrap }
      ];
      const frameState = new WeakMap();

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

      function getFrameState(frame) {
        let state = frameState.get(frame);
        if (!state) {
          state = {
            cleanup: null,
            contentHeight: DEFAULT_FRAME_HEIGHT
          };
          frameState.set(frame, state);
        }

        return state;
      }

      function cleanupFrameState(frame) {
        const state = getFrameState(frame);
        if (typeof state.cleanup === "function") {
          state.cleanup();
        }

        state.cleanup = null;
      }

      function updateViewportButtons() {
        for (const button of viewportButtons) {
          const pressed = Number(button.dataset.viewport) === viewportWidth;
          button.setAttribute("aria-pressed", pressed ? "true" : "false");
        }
      }

      function measureFrameHeight(frame) {
        try {
          const documentRoot = frame.contentDocument && frame.contentDocument.documentElement;
          const documentBody = frame.contentDocument && frame.contentDocument.body;

          return Math.max(
            documentRoot ? documentRoot.scrollHeight : 0,
            documentRoot ? documentRoot.offsetHeight : 0,
            documentBody ? documentBody.scrollHeight : 0,
            documentBody ? documentBody.offsetHeight : 0
          );
        } catch (_error) {
          return 0;
        }
      }

      function updateFrameHeight(frame, nextHeight) {
        if (!Number.isFinite(nextHeight) || nextHeight <= 0) {
          return;
        }

        const state = getFrameState(frame);
        state.contentHeight = Math.max(MIN_FRAME_HEIGHT, Math.round(nextHeight));
        layoutPreviewFrames();
      }

      function layoutPreviewFrame(preview) {
        if (!preview || !preview.frame || !preview.wrap) {
          return;
        }

        const wrapWidth = preview.wrap.clientWidth;
        if (wrapWidth === 0) {
          return;
        }

        const state = getFrameState(preview.frame);
        const intrinsicHeight = Math.max(MIN_FRAME_HEIGHT, state.contentHeight || DEFAULT_FRAME_HEIGHT);
        const scale = Math.min(1, wrapWidth / viewportWidth);
        const scaledWidth = viewportWidth * scale;
        const scaledHeight = intrinsicHeight * scale;
        const horizontalOffset = Math.max(0, Math.round((wrapWidth - scaledWidth) / 2));

        preview.wrap.dataset.scaled = scale < 0.999 ? "true" : "false";
        preview.wrap.style.height = Math.max(MIN_FRAME_HEIGHT, Math.round(scaledHeight)) + "px";
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

      function installFrameObservers(preview) {
        cleanupFrameState(preview.frame);

        const frameDocument = preview.frame.contentDocument;
        if (!frameDocument || !frameDocument.documentElement) {
          return;
        }

        let queued = false;
        const requestMeasurement = () => {
          if (queued) {
            return;
          }

          queued = true;
          window.requestAnimationFrame(() => {
            queued = false;
            updateFrameHeight(preview.frame, measureFrameHeight(preview.frame));
          });
        };

        let mutationObserver = null;
        if (typeof MutationObserver === "function") {
          mutationObserver = new MutationObserver(requestMeasurement);
          mutationObserver.observe(frameDocument.documentElement, {
            attributes: true,
            characterData: true,
            childList: true,
            subtree: true
          });
        }

        if (frameDocument.fonts && frameDocument.fonts.ready) {
          frameDocument.fonts.ready.then(requestMeasurement).catch(() => {});
        }

        const state = getFrameState(preview.frame);
        state.cleanup = () => {
          if (mutationObserver) {
            mutationObserver.disconnect();
          }
        };

        requestMeasurement();
      }

      function isHtmlFrame(frame) {
        try {
          return Boolean(
            frame.contentDocument &&
              typeof frame.contentDocument.contentType === "string" &&
              frame.contentDocument.contentType.includes("html")
          );
        } catch (_error) {
          return false;
        }
      }

      function setVotingEnabled(enabled) {
        for (const button of voteButtons) {
          button.disabled = !enabled;
        }
        openIncumbent.setAttribute("aria-disabled", enabled ? "false" : "true");
        openCandidate.setAttribute("aria-disabled", enabled ? "false" : "true");
      }

      function resetPreviewFrame(preview) {
        cleanupFrameState(preview.frame);
        const state = getFrameState(preview.frame);
        state.contentHeight = DEFAULT_FRAME_HEIGHT;
        preview.wrap.style.height = DEFAULT_FRAME_HEIGHT + "px";
        preview.wrap.dataset.scaled = "false";
        preview.frame.style.position = "absolute";
        preview.frame.style.top = "0px";
        preview.frame.style.width = viewportWidth + "px";
        preview.frame.style.height = DEFAULT_FRAME_HEIGHT + "px";
        preview.frame.style.left = "0px";
        preview.frame.style.transform = "scale(1)";
      }

      function clearPreviewFrame(preview) {
        cleanupFrameState(preview.frame);
        preview.wrap.style.height = DEFAULT_FRAME_HEIGHT + "px";
        preview.wrap.dataset.scaled = "false";
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

      function handleFrameMessage(event) {
        if (!event.data || event.data.type !== FRAME_HEIGHT_MESSAGE_TYPE) {
          return;
        }

        const preview = previewFrames.find((candidate) => candidate.frame.contentWindow === event.source);
        if (!preview) {
          return;
        }

        updateFrameHeight(preview.frame, Number(event.data.height));
      }

      function clearFrames() {
        incumbentPath.textContent = "";
        candidatePath.textContent = "";
        candidateLabel.textContent = "Candidate";
        clearPreviewFrame(previewFrames[0]);
        clearPreviewFrame(previewFrames[1]);
        openIncumbent.href = "#";
        openCandidate.href = "#";
      }

      function render(session) {
        currentSession = session;
        const ratio = session.totalUnits === 0 ? 0 : session.completedUnits / session.totalUnits;
        progressFill.style.width = (ratio * 100).toFixed(1) + "%";
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

        promptTitle.textContent = session.phaseLabel;
        promptMeta.textContent = session.summary;

        if (session.mode !== "review" || !session.current) {
          clearFrames();
          setVotingEnabled(false);
          status.textContent =
            session.mode === "completed"
              ? "All done."
              : session.mode === "failed"
                ? "Something went wrong \u2014 check the terminal."
                : "Waiting for the next comparison\u2026";
          return;
        }

        candidateLabel.textContent = "Candidate " + session.current.candidateIndex;
        incumbentPath.textContent = session.current.incumbentPath;
        candidatePath.textContent = session.current.candidatePath;
        resetPreviewFrame(previewFrames[0]);
        resetPreviewFrame(previewFrames[1]);
        incumbentFrame.src = session.current.incumbentUrl;
        candidateFrame.src = session.current.candidateUrl;
        openIncumbent.href = session.current.incumbentUrl;
        openCandidate.href = session.current.candidateUrl;
        layoutPreviewFrames();
        setVotingEnabled(true);
        status.textContent = "Which version looks better?";
      }

      async function loadInitialSession() {
        const response = await fetch("/api/session", { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Couldn\u2019t load the review session.");
        }

        render(await response.json());
      }

      async function submitVote(winner) {
        if (!currentSession || currentSession.mode !== "review" || !currentSession.current) {
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
          updateFrameHeight(preview.frame, measureFrameHeight(preview.frame));
          if (!isHtmlFrame(preview.frame)) {
            installFrameObservers(preview);
          }
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

      window.addEventListener("message", handleFrameMessage);
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
