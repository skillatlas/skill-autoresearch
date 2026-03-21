import fs from "fs-extra";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";
import { URL } from "node:url";

import { Logger } from "./logger.js";
import { ScoreVote } from "../types/rubric.js";

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

export interface HumanReviewService {
  reviewCandidates(input: HumanReviewInput): Promise<void>;
}

interface ReviewItem {
  candidateIndex: number;
  attempt: number;
}

interface ArtifactRef {
  id: string;
  label: string;
  path: string;
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
  const withBase =
    /<head[^>]*>/i.test(html)
      ? html.replace(/<head([^>]*)>/i, `<head$1><base href="${basePath}">`)
      : `<head><base href="${basePath}"></head>${html}`;

  return withBase
    .replaceAll('href="/', `href="${basePath}`)
    .replaceAll("href='/", `href='${basePath}`)
    .replaceAll('src="/', `src="${basePath}`)
    .replaceAll("src='/", `src='${basePath}`)
    .replaceAll('action="/', `action="${basePath}`)
    .replaceAll("action='/", `action='${basePath}`)
    .replaceAll("url(/", `url(${basePath}`)
    .replaceAll('url("/', `url("${basePath}`)
    .replaceAll("url('/", `url('${basePath}`);
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

export class LocalHumanReviewService implements HumanReviewService {
  public constructor(private readonly logger: Logger) {}

  public async reviewCandidates(input: HumanReviewInput): Promise<void> {
    const reviewQueue = input.candidates.flatMap((candidate) =>
      Array.from(
        { length: Math.max(0, input.voteCount - candidate.completedVotes) },
        (_, offset) => ({
          candidateIndex: candidate.index,
          attempt: candidate.completedVotes + offset
        })
      )
    );

    if (reviewQueue.length === 0) {
      return;
    }

    const candidateByIndex = new Map(
      input.candidates.map((candidate) => [candidate.index, candidate])
    );
    const candidateProgress = new Map(
      input.candidates.map((candidate) => [candidate.index, candidate.completedVotes])
    );
    const artifactEntries: Array<[string, ArtifactRef]> = [
      [
        "incumbent",
        {
          id: "incumbent",
          label: "Incumbent",
          path: input.incumbentPath
        }
      ],
      ...input.candidates.map(
        (candidate): [string, ArtifactRef] => [
          `candidate-${candidate.index}`,
          {
            id: `candidate-${candidate.index}`,
            label: `Candidate ${candidate.index}`,
            path: candidate.path
          }
        ]
      )
    ];
    const artifacts = new Map<string, ArtifactRef>(artifactEntries);

    let activeIndex = 0;
    let server: Server | undefined;
    let baseUrl = "";

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = (error?: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        if (!server) {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
          return;
        }

        server.close(() => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      };

      const buildSessionPayload = () => {
        const currentItem = reviewQueue[activeIndex];
        const currentCandidate =
          currentItem == null
            ? undefined
            : candidateByIndex.get(currentItem.candidateIndex);

        return {
          runId: input.runId,
          stepIndex: input.stepIndex,
          voteCount: input.voteCount,
          done: currentItem == null,
          totalComparisons: reviewQueue.length,
          completedComparisons: activeIndex,
          current:
            currentItem && currentCandidate
              ? {
                  candidateIndex: currentItem.candidateIndex,
                  attempt: currentItem.attempt,
                  comparisonNumber: activeIndex + 1,
                  completedVotes: candidateProgress.get(currentItem.candidateIndex) ?? 0,
                  incumbentUrl: `${baseUrl}/artifact/incumbent/`,
                  candidateUrl: `${baseUrl}/artifact/candidate-${currentItem.candidateIndex}/`,
                  incumbentPath: input.incumbentPath,
                  candidatePath: currentCandidate.path
                }
              : null,
          candidates: input.candidates.map((candidate) => ({
            index: candidate.index,
            completedVotes: candidateProgress.get(candidate.index) ?? candidate.completedVotes,
            totalVotes: input.voteCount,
            path: candidate.path
          }))
        };
      };

      const handleArtifactRequest = async (
        response: ServerResponse,
        artifactId: string,
        rawArtifactPath: string
      ) => {
        const artifact = artifacts.get(artifactId);
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
      :root {
        color-scheme: light;
        --paper: #f5f0e8;
        --ink: #1b1713;
        --accent: #b43f28;
        --line: rgba(27, 23, 19, 0.16);
      }

      body {
        margin: 0;
        padding: 24px;
        background:
          radial-gradient(circle at top left, rgba(180, 63, 40, 0.12), transparent 32%),
          var(--paper);
        color: var(--ink);
        font-family: Georgia, "Times New Roman", serif;
      }

      h1 {
        margin: 0 0 8px;
        font-size: clamp(28px, 4vw, 44px);
        line-height: 1.08;
      }

      p {
        margin: 0 0 20px;
        max-width: 64ch;
      }

      ul {
        margin: 0;
        padding-left: 20px;
      }

      li + li {
        margin-top: 8px;
      }

      a {
        color: var(--accent);
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
      };

      const requestHandler = async (request: IncomingMessage, response: ServerResponse) => {
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
          sendHtml(
            response,
            200,
            `<!doctype html>
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
        grid-template-rows: auto auto minmax(420px, 1fr);
      }

      .panel-header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 18px 10px;
        border-bottom: 1px solid var(--line);
      }

      .panel-title {
        margin: 0;
        font-size: 24px;
        line-height: 1.1;
      }

      .panel-path {
        padding: 0 18px 12px;
        color: var(--muted);
        font-family: "Courier New", monospace;
        font-size: 12px;
        word-break: break-all;
      }

      iframe {
        width: 100%;
        min-height: 420px;
        border: 0;
        background: white;
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

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
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

      button[data-variant="secondary"] {
        background: transparent;
        color: var(--ink);
      }

      button:hover,
      .link-button:hover {
        transform: translateY(-1px);
      }

      button:focus-visible,
      .link-button:focus-visible {
        outline: 3px solid rgba(180, 63, 40, 0.35);
        outline-offset: 2px;
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

        iframe {
          min-height: 320px;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        button,
        .link-button {
          transition: none;
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
          <p class="subhead">Each submission is written straight into the run state, so you can stop and resume without losing already-reviewed comparisons.</p>
        </div>
        <aside class="queue">
          <p class="eyebrow">Queue</p>
          <div id="queue-summary">Loading review queue…</div>
          <ul class="queue-list" id="queue-list"></ul>
        </aside>
      </section>

      <section class="controls">
        <div class="controls-copy">
          <strong id="prompt-title">Loading comparison…</strong>
          <span id="prompt-meta"></span>
        </div>
        <div class="actions">
          <a class="link-button" id="open-incumbent" href="#" target="_blank" rel="noreferrer">Open incumbent</a>
          <a class="link-button" id="open-candidate" href="#" target="_blank" rel="noreferrer">Open candidate</a>
          <button id="vote-incumbent" type="button" data-winner="A" data-variant="secondary">Incumbent wins</button>
          <button id="vote-candidate" type="button" data-winner="B">Candidate wins</button>
        </div>
      </section>

      <section class="workspace">
        <article class="panel">
          <header class="panel-header">
            <h2 class="panel-title">Incumbent</h2>
          </header>
          <div class="panel-path" id="incumbent-path"></div>
          <iframe id="incumbent-frame" title="Incumbent artifact" loading="eager"></iframe>
        </article>
        <article class="panel">
          <header class="panel-header">
            <h2 class="panel-title" id="candidate-label">Candidate</h2>
          </header>
          <div class="panel-path" id="candidate-path"></div>
          <iframe id="candidate-frame" title="Candidate artifact" loading="eager"></iframe>
        </article>
      </section>

      <div class="status" id="status"></div>
    </main>

    <script>
      const queueSummary = document.getElementById("queue-summary");
      const queueList = document.getElementById("queue-list");
      const promptTitle = document.getElementById("prompt-title");
      const promptMeta = document.getElementById("prompt-meta");
      const incumbentPath = document.getElementById("incumbent-path");
      const candidatePath = document.getElementById("candidate-path");
      const candidateLabel = document.getElementById("candidate-label");
      const incumbentFrame = document.getElementById("incumbent-frame");
      const candidateFrame = document.getElementById("candidate-frame");
      const openIncumbent = document.getElementById("open-incumbent");
      const openCandidate = document.getElementById("open-candidate");
      const status = document.getElementById("status");
      const voteButtons = Array.from(document.querySelectorAll("button[data-winner]"));

      let currentSession = null;

      function setVotingEnabled(enabled) {
        for (const button of voteButtons) {
          button.disabled = !enabled;
        }
      }

      function render(session) {
        currentSession = session;
        queueSummary.textContent = session.done
          ? "All comparisons submitted."
          : "Comparison " + session.current.comparisonNumber + " of " + session.totalComparisons;

        queueList.innerHTML = "";
        for (const candidate of session.candidates) {
          const item = document.createElement("li");
          item.className = "queue-item";
          item.innerHTML =
            "<span>Candidate " + candidate.index + "</span>" +
            "<span>" + candidate.completedVotes + "/" + candidate.totalVotes + " vote(s)</span>";
          queueList.appendChild(item);
        }

        if (session.done) {
          promptTitle.textContent = "Review complete";
          promptMeta.textContent = "You can close this tab.";
          incumbentPath.textContent = "";
          candidatePath.textContent = "";
          candidateLabel.textContent = "Candidate";
          incumbentFrame.removeAttribute("src");
          candidateFrame.removeAttribute("src");
          openIncumbent.href = "#";
          openCandidate.href = "#";
          status.textContent = "The local review server will stop after this submission completes.";
          setVotingEnabled(false);
          return;
        }

        promptTitle.textContent = "Step " + session.stepIndex + ", candidate " + session.current.candidateIndex;
        promptMeta.textContent = "Vote " + (session.current.attempt + 1) + " of " + session.voteCount;
        incumbentPath.textContent = session.current.incumbentPath;
        candidatePath.textContent = session.current.candidatePath;
        candidateLabel.textContent = "Candidate " + session.current.candidateIndex;
        incumbentFrame.src = session.current.incumbentUrl;
        candidateFrame.src = session.current.candidateUrl;
        openIncumbent.href = session.current.incumbentUrl;
        openCandidate.href = session.current.candidateUrl;
        status.textContent = "Choose the stronger artifact for this comparison.";
        setVotingEnabled(true);
      }

      async function loadSession() {
        const response = await fetch("/api/session", { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Failed to load review session.");
        }

        const session = await response.json();
        render(session);
      }

      async function submitVote(winner) {
        if (!currentSession || currentSession.done) {
          return;
        }

        setVotingEnabled(false);
        status.textContent = "Recording vote…";

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
          status.textContent = errorText || "Unable to record vote.";
          setVotingEnabled(true);
          return;
        }

        const session = await response.json();
        render(session);
      }

      voteButtons.forEach((button) => {
        button.addEventListener("click", () => {
          submitVote(button.dataset.winner);
        });
      });

      loadSession().catch((error) => {
        status.textContent = error instanceof Error ? error.message : String(error);
        setVotingEnabled(false);
      });
    </script>
  </body>
</html>`
          );
          return;
        }

        if (request.method === "GET" && pathname === "/api/session") {
          sendJson(response, 200, buildSessionPayload());
          return;
        }

        if (request.method === "POST" && pathname === "/api/vote") {
          const currentItem = reviewQueue[activeIndex];
          if (!currentItem) {
            sendJson(response, 409, {
              error: "All reviews are already complete."
            });
            return;
          }

          const body = await readRequestBody(request);
          const payload = JSON.parse(body) as {
            candidateIndex?: number;
            attempt?: number;
            winner?: "A" | "B";
          };

          if (
            payload.candidateIndex !== currentItem.candidateIndex ||
            payload.attempt !== currentItem.attempt
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

          await input.onVote({
            candidateIndex: currentItem.candidateIndex,
            vote: {
              winner: payload.winner,
              confidence: 1,
              rationale:
                payload.winner === "A"
                  ? "Human reviewer selected the incumbent artifact."
                  : "Human reviewer selected the candidate artifact."
            }
          });

          candidateProgress.set(
            currentItem.candidateIndex,
            (candidateProgress.get(currentItem.candidateIndex) ?? 0) + 1
          );
          activeIndex += 1;

          const sessionPayload = buildSessionPayload();
          sendJson(response, 200, sessionPayload);

          if (sessionPayload.done) {
            setImmediate(() => finish());
          }
          return;
        }

        if (request.method === "GET" && pathname.startsWith("/artifact/")) {
          const [, , artifactId, ...artifactPathSegments] = pathname.split("/");
          await handleArtifactRequest(
            response,
            artifactId ?? "",
            artifactPathSegments.join("/")
          );
          return;
        }

        sendHtml(response, 404, "<h1>Not found.</h1>");
      };

      server = createServer((request, response) => {
        void requestHandler(request, response).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          response.writeHead(500, {
            "content-type": "text/plain; charset=utf-8"
          });
          response.end(`${message}\n`);
        });
      });

      server.on("error", (error) => {
        finish(error);
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        if (!address || typeof address === "string") {
          finish(new Error("Failed to determine local review server address."));
          return;
        }

        baseUrl = `http://127.0.0.1:${address.port}`;
        this.logger.phase(
          `Human scoring ready at ${baseUrl} (${reviewQueue.length} comparison(s))`
        );
      });
    });
  }
}
