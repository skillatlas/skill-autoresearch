import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LocalHumanReviewService } from "../src/core/human-scoring.js";
import { Logger } from "../src/core/logger.js";

describe("LocalHumanReviewService", () => {
  it("serves viewport controls for fixed-height iframe previews", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "skill-autoresearch-human-scoring-")
    );
    const incumbentPath = path.join(workspaceRoot, "incumbent");
    const candidatePath = path.join(workspaceRoot, "candidate");
    await fs.ensureDir(incumbentPath);
    await fs.ensureDir(candidatePath);
    await fs.writeFile(
      path.join(incumbentPath, "index.html"),
      "<!doctype html><html><body><main style=\"height: 640px\">Incumbent</main></body></html>",
      "utf8"
    );
    await fs.writeFile(
      path.join(candidatePath, "index.html"),
      "<!doctype html><html><body><main style=\"height: 720px\">Candidate</main></body></html>",
      "utf8"
    );

    let openedUrlResolve: ((url: string) => void) | undefined;
    const openedUrl = new Promise<string>((resolve) => {
      openedUrlResolve = resolve;
    });
    const recordedWinners: string[] = [];
    const service = new LocalHumanReviewService(new Logger(false), {
      async open(url: string): Promise<void> {
        openedUrlResolve?.(url);
      }
    });

    await service.startRun({
      version: 1,
      runId: "run-1",
      workspaceRoot,
      scoringMode: "human",
      status: "running",
      stepIndex: 1,
      candidateCount: 1,
      voteCount: 1,
      minSteps: 0,
      maxSteps: 1,
      consecutiveRejections: 0,
      archivePath: "archive/run-1",
      skillsOriginalPath: "skills-original",
      skillsPreviousPath: "skills-previous",
      incumbentPath,
      currentPhase: "score",
      activeCandidates: [
        {
          index: 0,
          path: candidatePath,
          status: "generated",
          votes: []
        }
      ],
      history: []
    });

    const reviewPromise = service.reviewCandidates({
      runId: "run-1",
      stepIndex: 1,
      voteCount: 1,
      incumbentPath,
      candidates: [
        {
          index: 0,
          path: candidatePath,
          completedVotes: 0
        }
      ],
      async onVote({ vote }): Promise<void> {
        recordedWinners.push(vote.winner);
      }
    });

    const baseUrl = await openedUrl;
    const shellResponse = await fetch(baseUrl);
    const shellHtml = await shellResponse.text();
    expect(shellResponse.ok).toBe(true);
    expect(shellHtml).toContain('data-viewport="480"');
    expect(shellHtml).toContain('data-viewport="960"');
    expect(shellHtml).toContain('id="review-workspace" hidden');
    expect(shellHtml).toContain('id="incumbent-preview" hidden');
    expect(shellHtml).toContain('id="candidate-preview" hidden');

    const sessionResponse = await fetch(`${baseUrl}/api/session`);
    const session = (await sessionResponse.json()) as {
      current: {
        attempt: number;
        candidateIndex: number;
        incumbentUrl: string;
      };
    };
    const artifactResponse = await fetch(session.current.incumbentUrl);
    const artifactHtml = await artifactResponse.text();
    expect(artifactResponse.ok).toBe(true);
    expect(artifactHtml).toContain('<base href="/artifact/incumbent/">');

    const voteResponse = await fetch(`${baseUrl}/api/vote`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        candidateIndex: session.current.candidateIndex,
        attempt: session.current.attempt,
        winner: "B"
      })
    });
    expect(voteResponse.ok).toBe(true);

    await reviewPromise;
    expect(recordedWinners).toEqual(["B"]);

    const finalSessionResponse = await fetch(`${baseUrl}/api/session`);
    const finalSession = (await finalSessionResponse.json()) as {
      mode: string;
      current: unknown;
    };
    expect(finalSession.mode).toBe("running");
    expect(finalSession.current).toBeNull();

    await service.close();
  });
});
