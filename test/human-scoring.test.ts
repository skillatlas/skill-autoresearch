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
    const originalSkillsPath = path.join(workspaceRoot, "skills-original");
    const currentSkillsPath = path.join(workspaceRoot, "skills");
    await fs.ensureDir(incumbentPath);
    await fs.ensureDir(candidatePath);
    await fs.ensureDir(originalSkillsPath);
    await fs.ensureDir(currentSkillsPath);
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
    await fs.writeFile(
      path.join(originalSkillsPath, "SKILL.md"),
      "# Frontend Design\n\n- Original line\n- Shared line\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(currentSkillsPath, "SKILL.md"),
      "# Frontend Design\n\n- Original line\n- Candidate line\n- Shared line\n",
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
    expect(shellHtml).toContain(".controls-tools[hidden]");
    expect(shellHtml).toContain('id="preview-controls" hidden');
    expect(shellHtml).toContain(".workspace[hidden]");
    expect(shellHtml).toContain('id="review-workspace" hidden');
    expect(shellHtml).toContain('id="incumbent-preview" hidden');
    expect(shellHtml).toContain('id="candidate-preview" hidden');
    expect(shellHtml).toContain('id="skill-diff-section" hidden');
    expect(shellHtml).toContain('id="skill-diff-files"');
    expect(shellHtml).toContain('id="status" hidden');
    expect(shellHtml).toContain('id="queue-step"');
    expect(shellHtml).toContain('queueStep.textContent = "Current step · " + session.phaseLabel;');

    const sessionResponse = await fetch(`${baseUrl}/api/session`);
    const session = (await sessionResponse.json()) as {
      phaseLabel: string;
      current: {
        attempt: number;
        candidateIndex: number;
        incumbentUrl: string;
      };
      skillDiff: {
        changedFileCount: number;
        files: Array<{
          path: string;
          status: string;
          addedLineCount: number;
          removedLineCount: number;
          lines: Array<{
            type: string;
            text: string;
            omittedLineCount?: number;
          }>;
        }>;
      };
    };
    expect(session.phaseLabel).toBe("Step 1 · Scoring");
    expect(session.skillDiff.changedFileCount).toBe(1);
    expect(session.skillDiff.files).toHaveLength(1);
    expect(session.skillDiff.files[0]).toMatchObject({
      path: "SKILL.md",
      status: "modified",
      addedLineCount: 1,
      removedLineCount: 0
    });
    expect(session.skillDiff.files[0]?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "added",
          text: "- Candidate line"
        })
      ])
    );
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

  it("publishes skill diffs even without an active review", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "skill-autoresearch-human-scoring-")
    );
    const originalSkillsPath = path.join(workspaceRoot, "skills-original");
    const currentSkillsPath = path.join(workspaceRoot, "skills");
    await fs.ensureDir(originalSkillsPath);
    await fs.ensureDir(currentSkillsPath);
    await fs.writeFile(
      path.join(originalSkillsPath, "SKILL.md"),
      "# Frontend Design\n\n- Original line\n- Shared line\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(currentSkillsPath, "SKILL.md"),
      "# Frontend Design\n\n- Shared line\n- Mutated line\n",
      "utf8"
    );

    let openedUrlResolve: ((url: string) => void) | undefined;
    const openedUrl = new Promise<string>((resolve) => {
      openedUrlResolve = resolve;
    });
    const service = new LocalHumanReviewService(new Logger(false), {
      async open(url: string): Promise<void> {
        openedUrlResolve?.(url);
      }
    });

    await service.startRun({
      version: 1,
      runId: "run-2",
      workspaceRoot,
      scoringMode: "human",
      status: "running",
      stepIndex: 1,
      candidateCount: 1,
      voteCount: 1,
      minSteps: 0,
      maxSteps: 1,
      consecutiveRejections: 0,
      archivePath: "archive/run-2",
      skillsOriginalPath: "skills-original",
      skillsPreviousPath: "skills-previous",
      incumbentPath: undefined,
      currentPhase: "mutate-skills",
      activeCandidates: [],
      history: []
    });

    const baseUrl = await openedUrl;
    const sessionResponse = await fetch(`${baseUrl}/api/session`);
    const session = (await sessionResponse.json()) as {
      mode: string;
      current: unknown;
      skillDiff: {
        changedFileCount: number;
        files: Array<{
          path: string;
          status: string;
          addedLineCount: number;
          removedLineCount: number;
          lines: Array<{
            type: string;
            text: string;
          }>;
        }>;
      };
    };

    expect(session.mode).toBe("running");
    expect(session.current).toBeNull();
    expect(session.skillDiff.changedFileCount).toBe(1);
    expect(session.skillDiff.files[0]).toMatchObject({
      path: "SKILL.md",
      status: "modified",
      addedLineCount: 1,
      removedLineCount: 1
    });
    expect(session.skillDiff.files[0]?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "removed",
          text: "- Original line"
        }),
        expect.objectContaining({
          type: "added",
          text: "- Mutated line"
        })
      ])
    );

    await service.close();
  });
});
