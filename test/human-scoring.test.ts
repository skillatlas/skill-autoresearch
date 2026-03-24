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
    const previousSkillsPath = path.join(workspaceRoot, "skills-previous");
    const currentSkillsPath = path.join(workspaceRoot, "skills");
    await fs.ensureDir(incumbentPath);
    await fs.ensureDir(candidatePath);
    await fs.ensureDir(originalSkillsPath);
    await fs.ensureDir(previousSkillsPath);
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
      path.join(previousSkillsPath, "SKILL.md"),
      "# Frontend Design\n\n- Original line\n- Draft candidate line\n- Shared line\n",
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
      omitSkillDiff: false,
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
    expect(shellHtml).toContain("color: var(--paper);");
    expect(shellHtml).toContain(".controls-tools[hidden]");
    expect(shellHtml).toContain('id="preview-controls" hidden');
    expect(shellHtml).toContain(".workspace[hidden]");
    expect(shellHtml).toContain('id="review-workspace" hidden');
    expect(shellHtml).toContain('id="incumbent-preview" hidden');
    expect(shellHtml).toContain('id="candidate-preview" hidden');
    expect(shellHtml).toContain('id="skill-diff-section" hidden');
    expect(shellHtml).toContain('id="skill-diff-toggle"');
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
        visible: boolean;
        preferredTarget: string;
        targets: {
          original: {
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
          previous: {
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
      };
    };
    expect(session.phaseLabel).toBe("Step 1 · Scoring");
    expect(session.skillDiff.visible).toBe(true);
    expect(session.skillDiff.preferredTarget).toBe("previous");
    expect(session.skillDiff.targets.original.changedFileCount).toBe(1);
    expect(session.skillDiff.targets.original.files).toHaveLength(1);
    expect(session.skillDiff.targets.original.files[0]).toMatchObject({
      path: "SKILL.md",
      status: "modified",
      addedLineCount: 1,
      removedLineCount: 0
    });
    expect(session.skillDiff.targets.original.files[0]?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "added",
          text: "- Candidate line"
        })
      ])
    );
    expect(session.skillDiff.targets.previous.changedFileCount).toBe(1);
    expect(session.skillDiff.targets.previous.files[0]).toMatchObject({
      path: "SKILL.md",
      status: "modified",
      addedLineCount: 1,
      removedLineCount: 1
    });
    expect(session.skillDiff.targets.previous.files[0]?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "removed",
          text: "- Draft candidate line"
        }),
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
      omitSkillDiff: false,
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
        visible: boolean;
        preferredTarget: string;
        targets: {
          original: {
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
          } | null;
          previous: {
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
          } | null;
        };
      };
    };

    expect(session.mode).toBe("running");
    expect(session.current).toBeNull();
    expect(session.skillDiff.visible).toBe(true);
    expect(session.skillDiff.preferredTarget).toBe("original");
    expect(session.skillDiff.targets.original?.changedFileCount).toBe(1);
    expect(session.skillDiff.targets.original?.files[0]).toMatchObject({
      path: "SKILL.md",
      status: "modified",
      addedLineCount: 1,
      removedLineCount: 1
    });
    expect(session.skillDiff.targets.previous).toBeNull();
    expect(session.skillDiff.targets.original?.files[0]?.lines).toEqual(
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

  it("keeps candidate score summaries disabled in human scoring mode", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "skill-autoresearch-human-scoring-")
    );
    const baselinePath = path.join(workspaceRoot, "steps", "0", "baseline");
    const candidatePath = path.join(workspaceRoot, "steps", "1", "candidates", "0");
    await fs.ensureDir(baselinePath);
    await fs.ensureDir(candidatePath);
    await fs.ensureDir(path.join(workspaceRoot, "skills-original"));
    await fs.ensureDir(path.join(workspaceRoot, "skills-previous"));
    await fs.ensureDir(path.join(workspaceRoot, "skills"));
    await fs.writeFile(
      path.join(baselinePath, "index.html"),
      "<!doctype html><html><body><main>Baseline</main></body></html>",
      "utf8"
    );
    await fs.writeFile(
      path.join(candidatePath, "index.html"),
      "<!doctype html><html><body><main>Candidate</main></body></html>",
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
      runId: "run-human-current",
      workspaceRoot,
      scoringMode: "human",
      status: "running",
      stepIndex: 1,
      candidateCount: 1,
      voteCount: 3,
      minSteps: 0,
      maxSteps: 1,
      consecutiveRejections: 0,
      archivePath: "archive/run-human-current",
      skillsOriginalPath: "skills-original",
      skillsPreviousPath: "skills-previous",
      omitSkillDiff: false,
      incumbentPath: path.relative(workspaceRoot, baselinePath),
      currentPhase: "promote",
      activeCandidates: [
        {
          index: 0,
          path: path.relative(workspaceRoot, candidatePath),
          status: "scored",
          votes: [
            { attempt: 0, winner: "B", confidence: 1, rationale: "Better" },
            { attempt: 1, winner: "B", confidence: 0.8, rationale: "Still better" },
            { attempt: 2, winner: "A", confidence: 0.6, rationale: "Closer" }
          ],
          comparison: {
            aVotes: 1,
            bVotes: 2,
            averageConfidence: 0.8,
            isWinner: true
          }
        }
      ],
      history: []
    });

    const baseUrl = await openedUrl;
    const sessionResponse = await fetch(`${baseUrl}/api/session`);
    const session = (await sessionResponse.json()) as {
      scoringMode: string;
      candidates: Array<{
        index: number;
        score: unknown;
      }>;
    };

    expect(session.scoringMode).toBe("human");
    expect(session.candidates).toEqual([
      expect.objectContaining({
        index: 0,
        score: null
      })
    ]);

    await service.close();
  });

  it("keeps the latest rubric comparison visible after scoring completes", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "skill-autoresearch-human-scoring-")
    );
    const baselinePath = path.join(workspaceRoot, "steps", "0", "baseline");
    const candidatePath = path.join(workspaceRoot, "steps", "1", "candidates", "0");
    const originalSkillsPath = path.join(workspaceRoot, "skills-original");
    const previousSkillsPath = path.join(workspaceRoot, "skills-previous");
    const currentSkillsPath = path.join(workspaceRoot, "skills");
    await fs.ensureDir(baselinePath);
    await fs.ensureDir(candidatePath);
    await fs.ensureDir(originalSkillsPath);
    await fs.ensureDir(previousSkillsPath);
    await fs.ensureDir(currentSkillsPath);
    await fs.writeFile(
      path.join(baselinePath, "index.html"),
      "<!doctype html><html><body><main>Baseline</main></body></html>",
      "utf8"
    );
    await fs.writeFile(
      path.join(candidatePath, "index.html"),
      "<!doctype html><html><body><main>Candidate</main></body></html>",
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
      runId: "run-rubric",
      workspaceRoot,
      scoringMode: "rubric",
      status: "running",
      stepIndex: 1,
      candidateCount: 1,
      voteCount: 3,
      minSteps: 0,
      maxSteps: 1,
      consecutiveRejections: 0,
      archivePath: "archive/run-rubric",
      skillsOriginalPath: "skills-original",
      skillsPreviousPath: "skills-previous",
      omitSkillDiff: false,
      incumbentPath: path.relative(workspaceRoot, baselinePath),
      currentPhase: "generate-candidates",
      activeCandidates: [],
      history: []
    });

    service.syncState({
      version: 1,
      runId: "run-rubric",
      workspaceRoot,
      scoringMode: "rubric",
      status: "running",
      stepIndex: 1,
      candidateCount: 1,
      voteCount: 3,
      minSteps: 0,
      maxSteps: 1,
      consecutiveRejections: 0,
      archivePath: "archive/run-rubric",
      skillsOriginalPath: "skills-original",
      skillsPreviousPath: "skills-previous",
      omitSkillDiff: false,
      incumbentPath: path.relative(workspaceRoot, baselinePath),
      currentPhase: "promote",
      activeCandidates: [
        {
          index: 0,
          path: path.relative(workspaceRoot, candidatePath),
          status: "scored",
          votes: [
            {
              attempt: 0,
              winner: "B",
              confidence: 1,
              rationale: "Better"
            },
            {
              attempt: 1,
              winner: "B",
              confidence: 1,
              rationale: "Still better"
            },
            {
              attempt: 2,
              winner: "A",
              confidence: 1,
              rationale: "Closer"
            }
          ],
          comparison: {
            aVotes: 1,
            bVotes: 2,
            averageConfidence: 1,
            isWinner: true
          }
        }
      ],
      history: []
    });

    service.syncState({
      version: 1,
      runId: "run-rubric",
      workspaceRoot,
      scoringMode: "rubric",
      status: "running",
      stepIndex: 2,
      candidateCount: 1,
      voteCount: 3,
      minSteps: 0,
      maxSteps: 1,
      consecutiveRejections: 0,
      archivePath: "archive/run-rubric",
      skillsOriginalPath: "skills-original",
      skillsPreviousPath: "skills-previous",
      omitSkillDiff: false,
      incumbentPath: path.relative(workspaceRoot, candidatePath),
      currentPhase: "snapshot",
      activeCandidates: [],
      history: [
        {
          timestamp: new Date().toISOString(),
          stepIndex: 1,
          accepted: true,
          incumbentPath: path.relative(workspaceRoot, candidatePath),
          promotedCandidateIndex: 0,
          promotedCandidatePath: path.relative(workspaceRoot, candidatePath),
          winningCandidateIndexes: [0],
          consecutiveRejections: 0
        }
      ]
    });

    const baseUrl = await openedUrl;
    const sessionResponse = await fetch(`${baseUrl}/api/session`);
    const session = (await sessionResponse.json()) as {
      mode: string;
      scoringMode: string;
      current: {
        candidateIndex: number;
        incumbentPath: string;
        candidatePath: string;
        votingEnabled: boolean;
        statusLabel: string;
        incumbentUrl: string;
      };
    };

    expect(session.mode).toBe("running");
    expect(session.scoringMode).toBe("rubric");
    expect(session.current).toMatchObject({
      candidateIndex: 0,
      incumbentPath: path.resolve(baselinePath),
      candidatePath: path.resolve(candidatePath),
      votingEnabled: false
    });
    expect(session.current.statusLabel).toContain("kept candidate 0");

    const artifactResponse = await fetch(session.current.incumbentUrl);
    const artifactHtml = await artifactResponse.text();
    expect(artifactResponse.ok).toBe(true);
    expect(artifactHtml).toContain("Baseline");

    await service.close();
  });

  it("only reuses a winning candidate as the incumbent for the next rubric comparison", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "skill-autoresearch-human-scoring-")
    );
    const baselinePath = path.join(workspaceRoot, "steps", "0", "baseline");
    const candidateZeroPath = path.join(workspaceRoot, "steps", "1", "candidates", "0");
    const candidateOnePath = path.join(workspaceRoot, "steps", "1", "candidates", "1");
    await fs.ensureDir(baselinePath);
    await fs.ensureDir(candidateZeroPath);
    await fs.ensureDir(candidateOnePath);
    await fs.ensureDir(path.join(workspaceRoot, "skills-original"));
    await fs.ensureDir(path.join(workspaceRoot, "skills-previous"));
    await fs.ensureDir(path.join(workspaceRoot, "skills"));
    await fs.writeFile(
      path.join(baselinePath, "index.html"),
      "<!doctype html><html><body><main>Baseline</main></body></html>",
      "utf8"
    );
    await fs.writeFile(
      path.join(candidateZeroPath, "index.html"),
      "<!doctype html><html><body><main>Winning candidate</main></body></html>",
      "utf8"
    );
    await fs.writeFile(
      path.join(candidateOnePath, "index.html"),
      "<!doctype html><html><body><main>Losing candidate</main></body></html>",
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
      runId: "run-rubric-history-winner-only",
      workspaceRoot,
      scoringMode: "rubric",
      status: "running",
      stepIndex: 2,
      candidateCount: 2,
      voteCount: 3,
      minSteps: 0,
      maxSteps: 2,
      consecutiveRejections: 0,
      archivePath: "archive/run-rubric-history-winner-only",
      skillsOriginalPath: "skills-original",
      skillsPreviousPath: "skills-previous",
      omitSkillDiff: false,
      incumbentPath: path.relative(workspaceRoot, candidateOnePath),
      currentPhase: "snapshot",
      activeCandidates: [],
      history: [
        {
          timestamp: "2026-03-23T18:00:00.000Z",
          stepIndex: 1,
          accepted: true,
          incumbentPath: path.relative(workspaceRoot, candidateOnePath),
          promotedCandidateIndex: 1,
          promotedCandidatePath: path.relative(workspaceRoot, candidateOnePath),
          winningCandidateIndexes: [0],
          consecutiveRejections: 0,
          candidates: [
            {
              index: 0,
              path: path.relative(workspaceRoot, candidateZeroPath),
              status: "accepted",
              votes: [
                { attempt: 0, winner: "B", confidence: 1, rationale: "Clear winner." }
              ],
              comparison: {
                aVotes: 0,
                bVotes: 1,
                averageConfidence: 1,
                isWinner: true
              }
            },
            {
              index: 1,
              path: path.relative(workspaceRoot, candidateOnePath),
              status: "rejected",
              votes: [{ attempt: 0, winner: "A", confidence: 0.8, rationale: "Lost." }],
              comparison: {
                aVotes: 1,
                bVotes: 0,
                averageConfidence: 0.8,
                isWinner: false
              }
            }
          ]
        }
      ]
    });

    const baseUrl = await openedUrl;
    const sessionResponse = await fetch(`${baseUrl}/api/session`);
    const session = (await sessionResponse.json()) as {
      current: {
        candidateIndex: number;
        incumbentPath: string;
        candidatePath: string;
        statusLabel: string;
      };
    };

    expect(session.current).toMatchObject({
      candidateIndex: 0,
      incumbentPath: path.resolve(baselinePath),
      candidatePath: path.resolve(candidateZeroPath)
    });
    expect(session.current.statusLabel).toContain("kept candidate 0");

    await service.close();
  });

  it("publishes rubric candidate choices and score summaries for the current step", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "skill-autoresearch-human-scoring-")
    );
    const baselinePath = path.join(workspaceRoot, "steps", "0", "baseline");
    const candidateZeroPath = path.join(workspaceRoot, "steps", "1", "candidates", "0");
    const candidateOnePath = path.join(workspaceRoot, "steps", "1", "candidates", "1");
    await fs.ensureDir(baselinePath);
    await fs.ensureDir(candidateZeroPath);
    await fs.ensureDir(candidateOnePath);
    await fs.ensureDir(path.join(workspaceRoot, "skills-original"));
    await fs.ensureDir(path.join(workspaceRoot, "skills-previous"));
    await fs.ensureDir(path.join(workspaceRoot, "skills"));
    await fs.writeFile(
      path.join(baselinePath, "index.html"),
      "<!doctype html><html><body><main>Baseline</main></body></html>",
      "utf8"
    );
    await fs.writeFile(
      path.join(candidateZeroPath, "index.html"),
      "<!doctype html><html><body><main>Candidate zero</main></body></html>",
      "utf8"
    );
    await fs.writeFile(
      path.join(candidateOnePath, "index.html"),
      "<!doctype html><html><body><main>Candidate one</main></body></html>",
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
      runId: "run-rubric-current",
      workspaceRoot,
      scoringMode: "rubric",
      status: "running",
      stepIndex: 1,
      candidateCount: 2,
      voteCount: 3,
      minSteps: 0,
      maxSteps: 1,
      consecutiveRejections: 0,
      archivePath: "archive/run-rubric-current",
      skillsOriginalPath: "skills-original",
      skillsPreviousPath: "skills-previous",
      omitSkillDiff: false,
      incumbentPath: path.relative(workspaceRoot, baselinePath),
      currentPhase: "promote",
      activeCandidates: [
        {
          index: 0,
          path: path.relative(workspaceRoot, candidateZeroPath),
          status: "scored",
          votes: [
            { attempt: 0, winner: "B", confidence: 1, rationale: "Better" },
            { attempt: 1, winner: "B", confidence: 0.8, rationale: "Still better" },
            { attempt: 2, winner: "A", confidence: 0.6, rationale: "Closer" }
          ],
          comparison: {
            aVotes: 1,
            bVotes: 2,
            averageConfidence: 0.8,
            isWinner: true
          }
        },
        {
          index: 1,
          path: path.relative(workspaceRoot, candidateOnePath),
          status: "scored",
          votes: [
            { attempt: 0, winner: "A", confidence: 0.9, rationale: "Worse" },
            { attempt: 1, winner: "B", confidence: 0.7, rationale: "Some merit" },
            { attempt: 2, winner: "A", confidence: 0.8, rationale: "Still worse" }
          ],
          comparison: {
            aVotes: 2,
            bVotes: 1,
            averageConfidence: 0.8,
            isWinner: false
          }
        }
      ],
      history: []
    });

    const baseUrl = await openedUrl;
    const sessionResponse = await fetch(`${baseUrl}/api/session`);
    const session = (await sessionResponse.json()) as {
      candidates: Array<{
        index: number;
        score: {
          summary: string;
          detail: string;
          tone: string;
        } | null;
      }>;
      stepViews: Array<{
        key: string;
        defaultCandidateIndex: number | null;
        candidateChoices: Array<{
          index: number;
          url: string;
          score: {
            summary: string;
            detail: string;
            tone: string;
          } | null;
        }>;
      }>;
    };

    expect(session.candidates).toEqual([
      expect.objectContaining({
        index: 0,
        score: expect.objectContaining({
          summary: "2 candidate · 1 incumbent",
          detail: "Won · avg confidence 80%",
          tone: "winner"
        })
      }),
      expect.objectContaining({
        index: 1,
        score: expect.objectContaining({
          summary: "1 candidate · 2 incumbent",
          detail: "Lost · avg confidence 80%",
          tone: "loser"
        })
      })
    ]);

    const currentView = session.stepViews[0];
    expect(currentView.key).toBe("current");
    expect(currentView.defaultCandidateIndex).toBe(0);
    expect(currentView.candidateChoices).toHaveLength(2);
    expect(currentView.candidateChoices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          index: 0,
          score: expect.objectContaining({
            summary: "2 candidate · 1 incumbent",
            tone: "winner"
          })
        }),
        expect.objectContaining({
          index: 1,
          score: expect.objectContaining({
            summary: "1 candidate · 2 incumbent",
            tone: "loser"
          })
        })
      ])
    );

    const secondCandidate = currentView.candidateChoices.find((choice) => choice.index === 1);
    const secondCandidateResponse = await fetch(secondCandidate?.url ?? "");
    expect(secondCandidateResponse.ok).toBe(true);
    expect(await secondCandidateResponse.text()).toContain("Candidate one");

    await service.close();
  });

  it("publishes rubric candidate choices and rationales for historical steps", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "skill-autoresearch-human-scoring-")
    );
    const baselinePath = path.join(workspaceRoot, "steps", "0", "baseline");
    const candidateZeroPath = path.join(workspaceRoot, "steps", "1", "candidates", "0");
    const candidateOnePath = path.join(workspaceRoot, "steps", "1", "candidates", "1");
    await fs.ensureDir(baselinePath);
    await fs.ensureDir(candidateZeroPath);
    await fs.ensureDir(candidateOnePath);
    await fs.ensureDir(path.join(workspaceRoot, "skills-original"));
    await fs.ensureDir(path.join(workspaceRoot, "skills-previous"));
    await fs.ensureDir(path.join(workspaceRoot, "skills"));
    await fs.writeFile(
      path.join(baselinePath, "index.html"),
      "<!doctype html><html><body><main>Baseline</main></body></html>",
      "utf8"
    );
    await fs.writeFile(
      path.join(candidateZeroPath, "index.html"),
      "<!doctype html><html><body><main>Candidate zero</main></body></html>",
      "utf8"
    );
    await fs.writeFile(
      path.join(candidateOnePath, "index.html"),
      "<!doctype html><html><body><main>Candidate one</main></body></html>",
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
      runId: "run-rubric-history",
      workspaceRoot,
      scoringMode: "rubric",
      status: "running",
      stepIndex: 2,
      candidateCount: 2,
      voteCount: 3,
      minSteps: 0,
      maxSteps: 2,
      consecutiveRejections: 0,
      archivePath: "archive/run-rubric-history",
      skillsOriginalPath: "skills-original",
      skillsPreviousPath: "skills-previous",
      omitSkillDiff: false,
      incumbentPath: path.relative(workspaceRoot, candidateZeroPath),
      currentPhase: "snapshot",
      activeCandidates: [],
      history: [
        {
          timestamp: "2026-03-23T18:00:00.000Z",
          stepIndex: 1,
          accepted: true,
          incumbentPath: path.relative(workspaceRoot, candidateZeroPath),
          promotedCandidateIndex: 0,
          promotedCandidatePath: path.relative(workspaceRoot, candidateZeroPath),
          winningCandidateIndexes: [0],
          consecutiveRejections: 0,
          candidates: [
            {
              index: 0,
              path: path.relative(workspaceRoot, candidateZeroPath),
              status: "accepted",
              votes: [
                { attempt: 0, winner: "B", confidence: 1, rationale: "Clearer layout." },
                {
                  attempt: 1,
                  winner: "B",
                  confidence: 0.8,
                  rationale: "More coherent typography."
                }
              ],
              comparison: {
                aVotes: 0,
                bVotes: 2,
                averageConfidence: 0.9,
                isWinner: true
              }
            },
            {
              index: 1,
              path: path.relative(workspaceRoot, candidateOnePath),
              status: "rejected",
              votes: [
                {
                  attempt: 0,
                  winner: "A",
                  confidence: 0.7,
                  rationale: "The baseline has cleaner spacing."
                }
              ],
              comparison: {
                aVotes: 1,
                bVotes: 0,
                averageConfidence: 0.7,
                isWinner: false
              }
            }
          ]
        }
      ]
    });

    const baseUrl = await openedUrl;
    const sessionResponse = await fetch(`${baseUrl}/api/session`);
    const session = (await sessionResponse.json()) as {
      stepViews: Array<{
        key: string;
        defaultCandidateIndex: number | null;
        candidateChoices: Array<{
          index: number;
          url: string;
          score: {
            summary: string;
            detail: string;
            tone: string;
          } | null;
          rationales: string[];
        }>;
      }>;
    };

    const historicalView = session.stepViews.find((view) => view.key === "step-1");
    expect(historicalView).toBeDefined();
    expect(historicalView?.defaultCandidateIndex).toBe(0);
    expect(historicalView?.candidateChoices).toHaveLength(2);
    expect(historicalView?.candidateChoices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          index: 0,
          score: expect.objectContaining({
            summary: "2 candidate · 0 incumbent",
            detail: "Won · avg confidence 90%",
            tone: "winner"
          }),
          rationales: ["Clearer layout.", "More coherent typography."]
        }),
        expect.objectContaining({
          index: 1,
          score: expect.objectContaining({
            summary: "0 candidate · 1 incumbent",
            detail: "Lost · avg confidence 70%",
            tone: "loser"
          }),
          rationales: ["The baseline has cleaner spacing."]
        })
      ])
    );

    const secondCandidate = historicalView?.candidateChoices.find((choice) => choice.index === 1);
    const secondCandidateResponse = await fetch(secondCandidate?.url ?? "");
    expect(secondCandidateResponse.ok).toBe(true);
    expect(await secondCandidateResponse.text()).toContain("Candidate one");

    await service.close();
  });

  it("publishes completed step views with the winning outcome and step diff", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "skill-autoresearch-human-scoring-")
    );
    const baselinePath = path.join(workspaceRoot, "steps", "0", "baseline");
    const candidatePath = path.join(workspaceRoot, "steps", "1", "candidates", "0");
    const originalSkillsPath = path.join(workspaceRoot, "skills-original");
    const previousSkillsPath = path.join(workspaceRoot, "skills-previous");
    const currentSkillsPath = path.join(workspaceRoot, "skills");
    await fs.ensureDir(path.join(baselinePath, "skills"));
    await fs.ensureDir(path.join(candidatePath, "skills"));
    await fs.ensureDir(originalSkillsPath);
    await fs.ensureDir(previousSkillsPath);
    await fs.ensureDir(currentSkillsPath);
    await fs.writeFile(
      path.join(baselinePath, "index.html"),
      "<!doctype html><html><body><main>Baseline</main></body></html>",
      "utf8"
    );
    await fs.writeFile(
      path.join(candidatePath, "index.html"),
      "<!doctype html><html><body><main>Mutated</main></body></html>",
      "utf8"
    );
    await fs.writeFile(
      path.join(baselinePath, "skills", "SKILL.md"),
      "# Demo\n\n- Baseline line\n- Shared line\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(candidatePath, "skills", "SKILL.md"),
      "# Demo\n\n- Baseline line\n- Mutated line\n- Shared line\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(originalSkillsPath, "SKILL.md"),
      "# Demo\n\n- Original line\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(previousSkillsPath, "SKILL.md"),
      "# Demo\n\n- Baseline line\n- Shared line\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(currentSkillsPath, "SKILL.md"),
      "# Demo\n\n- Baseline line\n- Shared line\n",
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
      runId: "run-3",
      workspaceRoot,
      scoringMode: "human",
      status: "running",
      stepIndex: 2,
      candidateCount: 1,
      voteCount: 1,
      minSteps: 0,
      maxSteps: 2,
      consecutiveRejections: 1,
      archivePath: "archive/run-3",
      skillsOriginalPath: "skills-original",
      skillsPreviousPath: "skills-previous",
      omitSkillDiff: false,
      incumbentPath: "steps/0/baseline",
      currentPhase: "snapshot",
      activeCandidates: [],
      history: [
        {
          timestamp: "2026-03-21T10:00:00.000Z",
          stepIndex: 1,
          accepted: false,
          incumbentPath: "steps/0/baseline",
          winningCandidateIndexes: [],
          consecutiveRejections: 1
        }
      ]
    });

    const baseUrl = await openedUrl;
    const sessionResponse = await fetch(`${baseUrl}/api/session`);
    const session = (await sessionResponse.json()) as {
      stepViews: Array<{
        key: string;
        outcome: string;
        winnerLabel: string;
        candidate: {
          label: string;
          url: string;
          isWinner: boolean;
        } | null;
        incumbent: {
          url: string;
          isWinner: boolean;
        } | null;
        skillDiff: {
          visible: boolean;
          preferredTarget: string;
          targets: {
            original: null;
            previous: {
              basePath: string;
              currentPath: string;
              files: Array<{
                path: string;
                lines: Array<{
                  type: string;
                  text: string;
                }>;
              }>;
            } | null;
          };
        } | null;
      }>;
    };

    expect(session.stepViews.map((view) => view.key)).toEqual(["current", "step-1"]);
    const historicalView = session.stepViews[1];
    expect(historicalView).toMatchObject({
      key: "step-1",
      outcome: "rejected",
      winnerLabel: "Incumbent kept",
      candidate: {
        label: "Mutated artifact",
        isWinner: false
      },
      incumbent: {
        isWinner: true
      },
      skillDiff: {
        visible: true,
        preferredTarget: "previous"
      }
    });
    expect(historicalView.skillDiff?.targets.previous).toMatchObject({
      basePath: "steps/0/baseline/skills",
      currentPath: "steps/1/candidates/0/skills"
    });
    expect(historicalView.skillDiff?.targets.previous?.files[0]).toMatchObject({
      path: "SKILL.md"
    });
    expect(historicalView.skillDiff?.targets.previous?.files[0]?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "added",
          text: "- Mutated line"
        })
      ])
    );

    const incumbentResponse = await fetch(historicalView.incumbent?.url ?? "");
    expect(incumbentResponse.ok).toBe(true);
    expect(await incumbentResponse.text()).toContain("<main>Baseline</main>");

    const candidateResponse = await fetch(historicalView.candidate?.url ?? "");
    expect(candidateResponse.ok).toBe(true);
    expect(await candidateResponse.text()).toContain("<main>Mutated</main>");

    await service.close();
  });
});
