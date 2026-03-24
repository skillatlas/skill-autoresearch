import fs from "fs-extra";
import path from "node:path";

import {
  createWorkspaceCopy,
  FakeContainerRunner,
  FakeHumanReviewService,
  FakeScorer,
  readRunState,
  readSkillVersion,
  readSkillVersionFromPath,
  runOrchestrator
} from "./helpers.js";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function relativeTargetPath(workspaceRoot: string, targetPath: string): string {
  return path.relative(workspaceRoot, targetPath).split(path.sep).join("/");
}

function isCandidateExecution(
  execution: Parameters<FakeContainerRunner["runPrompt"]>[0]
): boolean {
  return /^Candidate \d+ generation for step \d+(?: \([^)]+\))?$/.test(execution.label);
}

class ConcurrentCandidateRunner {
  public maxActiveCandidateRuns = 0;
  private activeCandidateRuns = 0;
  private readonly delegate: FakeContainerRunner;

  public constructor(
    private readonly workspaceRoot: string,
    options: ConstructorParameters<typeof FakeContainerRunner>[1] = {}
  ) {
    this.delegate = new FakeContainerRunner(workspaceRoot, options);
  }

  public get executions(): string[] {
    return this.delegate.executions;
  }

  public async runPrompt(
    execution: Parameters<FakeContainerRunner["runPrompt"]>[0]
  ): Promise<void> {
    const isCandidateRun = isCandidateExecution(execution);

    if (!isCandidateRun) {
      await this.delegate.runPrompt(execution);
      return;
    }

    this.activeCandidateRuns += 1;
    this.maxActiveCandidateRuns = Math.max(
      this.maxActiveCandidateRuns,
      this.activeCandidateRuns
    );

    try {
      await delay(50);
      await this.delegate.runPrompt(execution);
    } finally {
      this.activeCandidateRuns -= 1;
    }
  }
}

class ConcurrentVoteScorer extends FakeScorer {
  public maxActiveVotes = 0;
  private activeVotes = 0;

  public override async runSingleVote(
    input: Parameters<FakeScorer["runSingleVote"]>[0]
  ) {
    this.activeVotes += 1;
    this.maxActiveVotes = Math.max(this.maxActiveVotes, this.activeVotes);

    try {
      await delay(50);
      return await super.runSingleVote(input);
    } finally {
      this.activeVotes -= 1;
    }
  }
}

describe("orchestrator integration", () => {
  it("uses the mutation provider and model from INSTRUCTIONS.md frontmatter", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    await fs.writeFile(
      path.join(workspaceRoot, "INSTRUCTIONS.md"),
      "---\nprovider: codex\nmodel: gpt-5\n---\nImprove the skill.\n",
      "utf8"
    );

    const mutationExecutions: Array<{ provider: string; modelId?: string }> = [];

    await runOrchestrator({
      workspaceRoot,
      options: {
        candidateCount: 1,
        voteCount: 1,
        maxSteps: 1
      },
      containerRunner: {
        async runPrompt(execution) {
          if (execution.label.startsWith("Skill mutation for step ")) {
            mutationExecutions.push({
              provider: execution.provider,
              modelId: execution.modelId
            });
            await fs.writeFile(
              path.join(execution.targetPath, "demo", "SKILL.md"),
              "version=1\n",
              "utf8"
            );
            return;
          }

          await fs.ensureDir(execution.targetPath);
          await fs.writeFile(
            path.join(execution.targetPath, "index.html"),
            "score=1\n",
            "utf8"
          );
        }
      },
      scorer: new FakeScorer(workspaceRoot)
    });

    expect(mutationExecutions).toEqual([
      {
        provider: "codex",
        modelId: "gpt-5"
      }
    ]);
  });

  it("applies a provider override to mutation, generation, and rubric loading", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const executionProviders: Array<{ label: string; provider: string }> = [];
    const scorer = new FakeScorer(workspaceRoot);

    await runOrchestrator({
      workspaceRoot,
      options: {
        candidateCount: 1,
        voteCount: 1,
        maxSteps: 1,
        providerOverride: "codex"
      },
      containerRunner: {
        async runPrompt(execution) {
          executionProviders.push({
            label: execution.label,
            provider: execution.provider
          });

          if (execution.label.startsWith("Skill mutation for step ")) {
            await fs.writeFile(
              path.join(execution.targetPath, "demo", "SKILL.md"),
              "version=1\n",
              "utf8"
            );
            return;
          }

          await fs.ensureDir(execution.targetPath);
          await fs.writeFile(
            path.join(execution.targetPath, "index.html"),
            "score=1\n",
            "utf8"
          );
        }
      },
      scorer
    });

    expect(
      executionProviders.map((execution) => execution.provider)
    ).toEqual(["codex", "codex", "codex"]);
    expect(scorer.providers).toEqual(["codex"]);
  });

  it("includes skill diff evidence in rubric scoring by default", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const scorer = new FakeScorer(workspaceRoot);

    await runOrchestrator({
      workspaceRoot,
      options: {
        candidateCount: 1,
        voteCount: 1,
        maxSteps: 1
      },
      containerRunner: new FakeContainerRunner(workspaceRoot),
      scorer
    });

    expect(scorer.comparisonEvidenceCalls).toHaveLength(1);
    expect(scorer.comparisonEvidenceCalls[0]).toEqual([
      {
        outputType: "text",
        label: "skill-diff",
        content: "Skill changed from version=0 to version=1."
      }
    ]);
  });

  it("omits skill diff evidence when requested", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const scorer = new FakeScorer(workspaceRoot);

    await runOrchestrator({
      workspaceRoot,
      options: {
        candidateCount: 1,
        voteCount: 1,
        maxSteps: 1,
        omitSkillDiff: true
      },
      containerRunner: new FakeContainerRunner(workspaceRoot),
      scorer
    });

    expect(scorer.comparisonEvidenceCalls).toHaveLength(1);
    expect(scorer.comparisonEvidenceCalls[0]).toEqual([]);
  });

  it("supports multiple numbered generation prompts per step", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    await fs.remove(path.join(workspaceRoot, "GENERATION.md"));
    await fs.writeFile(
      path.join(workspaceRoot, "GENERATION1.md"),
      "---\nprovider: codex\n---\nGenerate the first artifact.\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(workspaceRoot, "GENERATION2.md"),
      "---\nprovider: codex\n---\nGenerate the second artifact.\n",
      "utf8"
    );

    const containerRunner = new FakeContainerRunner(workspaceRoot, {
      candidateScores: {
        "1:0:GENERATION1": 5,
        "1:0:GENERATION2": 6,
        "1:1:GENERATION1": 0,
        "1:1:GENERATION2": 0
      }
    });

    await runOrchestrator({
      workspaceRoot,
      options: {
        candidateCount: 2,
        voteCount: 1,
        maxSteps: 1
      },
      containerRunner,
      scorer: new FakeScorer(workspaceRoot)
    });

    const state = await readRunState(workspaceRoot);
    expect(state.history[0]).toMatchObject({
      accepted: false,
      winningCandidateIndexes: [0]
    });
    expect(containerRunner.executions).toEqual(
      expect.arrayContaining([
        "steps/0/baseline/GENERATION1",
        "steps/0/baseline/GENERATION2",
        "steps/1/candidates/0/GENERATION1",
        "steps/1/candidates/0/GENERATION2",
        "steps/1/candidates/1/GENERATION1",
        "steps/1/candidates/1/GENERATION2"
      ])
    );
    expect(await fs.pathExists(path.join(workspaceRoot, "steps", "0", "baseline", "index.html"))).toBe(
      true
    );
    expect(
      await fs.pathExists(
        path.join(workspaceRoot, "steps", "1", "candidates", "0", "GENERATION1", "index.html")
      )
    ).toBe(true);
    expect(
      await fs.pathExists(
        path.join(workspaceRoot, "steps", "1", "candidates", "0", "GENERATION2", "index.html")
      )
    ).toBe(true);
  });

  it("reviews multiple numbered generation prompts in human scoring mode", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    await fs.remove(path.join(workspaceRoot, "GENERATION.md"));
    await fs.writeFile(
      path.join(workspaceRoot, "GENERATION1.md"),
      "---\nprovider: codex\n---\nGenerate the first artifact.\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(workspaceRoot, "GENERATION2.md"),
      "---\nprovider: codex\n---\nGenerate the second artifact.\n",
      "utf8"
    );

    const humanReview = new FakeHumanReviewService();
    await runOrchestrator({
      workspaceRoot,
      options: {
        scoringMode: "human",
        candidateCount: 1,
        voteCount: 1,
        maxSteps: 1
      },
      containerRunner: new FakeContainerRunner(workspaceRoot, {
        candidateScores: {
          "1:0:GENERATION1": 4,
          "1:0:GENERATION2": 5
        }
      }),
      scorer: new FakeScorer(workspaceRoot),
      humanReview
    });

    const state = await readRunState(workspaceRoot);
    expect(humanReview.sessions).toBe(2);
    expect(state.history[0]).toMatchObject({
      accepted: true,
      promotedCandidateIndex: 0
    });
  });

  it("fails fast when baseline generation produces no artifacts", async () => {
    const workspaceRoot = await createWorkspaceCopy();

    await expect(
      runOrchestrator({
        workspaceRoot,
        options: {
          maxSteps: 0
        },
        containerRunner: {
          async runPrompt(execution) {
            await fs.ensureDir(execution.targetPath);
          }
        },
        scorer: new FakeScorer(workspaceRoot)
      })
    ).rejects.toThrow("Baseline generation did not create any files in steps/0/baseline.");
  });

  it("fails fast when candidate generation produces no artifacts", async () => {
    const workspaceRoot = await createWorkspaceCopy();

    await expect(
      runOrchestrator({
        workspaceRoot,
        options: {
          maxSteps: 1
        },
        containerRunner: {
          async runPrompt(execution) {
            if (execution.label.startsWith("Skill mutation for step ")) {
              await fs.writeFile(
                path.join(execution.targetPath, "demo", "SKILL.md"),
                "version=1\n",
                "utf8"
              );
              return;
            }

            await fs.ensureDir(execution.targetPath);
            if (execution.label === "Baseline generation") {
              await fs.writeFile(
                path.join(execution.targetPath, "index.html"),
                "score=0\n",
                "utf8"
              );
            }
          }
        },
        scorer: new FakeScorer(workspaceRoot)
      })
    ).rejects.toThrow(
      "Candidate 0 generation for step 1 did not create any files in steps/1/candidates/0."
    );
  });

  it("treats max-steps zero as disabled", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const containerRunner = new FakeContainerRunner(workspaceRoot, {
      candidateScores: {
        "1:0": 0
      }
    });

    await runOrchestrator({
      workspaceRoot,
      options: {
        candidateCount: 1,
        voteCount: 1,
        maxSteps: 0,
        stasisSteps: 1
      },
      containerRunner,
      scorer: new FakeScorer(workspaceRoot)
    });

    const state = await readRunState(workspaceRoot);
    expect(state.status).toBe("completed");
    expect(state.completedReason).toBe("stasis");
    expect(state.history).toHaveLength(1);
    expect(state.incumbentPath).toBe("steps/0/baseline");
    expect(containerRunner.executions[0]).toBe("steps/0/baseline");
    expect(containerRunner.executions).toContain("steps/1/candidates/0");
    expect(containerRunner.executions).toHaveLength(3);
    expect(await fs.pathExists(path.join(workspaceRoot, "steps", "0", "baseline", "index.html"))).toBe(
      true
    );
    expect(
      await readSkillVersionFromPath(
        workspaceRoot,
        "steps/0/baseline/skills/demo/SKILL.md"
      )
    ).toBe(0);
  });

  it("starts the human review server before baseline generation", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    let reviewServerStarted = false;

    await runOrchestrator({
      workspaceRoot,
      options: {
        scoringMode: "human",
        maxSteps: 1
      },
      containerRunner: {
        async runPrompt(execution) {
          expect(reviewServerStarted).toBe(true);
          await new FakeContainerRunner(workspaceRoot).runPrompt(execution);
        }
      },
      scorer: new FakeScorer(workspaceRoot),
      humanReview: {
        async startRun() {
          expect(
            await readSkillVersionFromPath(
              workspaceRoot,
              "skills-original/demo/SKILL.md"
            )
          ).toBe(0);
          expect(
            await readSkillVersionFromPath(
              workspaceRoot,
              "skills-previous/demo/SKILL.md"
            )
          ).toBe(0);
          reviewServerStarted = true;
        },
        syncState() {},
        async reviewCandidates() {},
        async close() {}
      }
    });
  });

  it("starts the web interface before baseline generation in rubric mode", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    let reviewServerStarted = false;

    await runOrchestrator({
      workspaceRoot,
      options: {
        maxSteps: 1
      },
      containerRunner: {
        async runPrompt(execution) {
          expect(reviewServerStarted).toBe(true);
          await new FakeContainerRunner(workspaceRoot).runPrompt(execution);
        }
      },
      scorer: new FakeScorer(workspaceRoot),
      humanReview: {
        async startRun() {
          expect(
            await readSkillVersionFromPath(
              workspaceRoot,
              "skills-original/demo/SKILL.md"
            )
          ).toBe(0);
          expect(
            await readSkillVersionFromPath(
              workspaceRoot,
              "skills-previous/demo/SKILL.md"
            )
          ).toBe(0);
          reviewServerStarted = true;
        },
        syncState() {},
        async reviewCandidates() {
          throw new Error("Rubric mode should not request human reviews.");
        },
        async close() {}
      }
    });
  });

  it("archives old steps and promotes a step winner by candidate majority", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    await fs.ensureDir(path.join(workspaceRoot, "steps", "old"));
    await fs.writeFile(path.join(workspaceRoot, "steps", "old", "index.html"), "old");

    const containerRunner = new FakeContainerRunner(workspaceRoot, {
      mutationVersions: [2],
      candidateScores: {
        "1:0": 7,
        "1:1": 6,
        "1:2": 0
      }
    });

    await runOrchestrator({
      workspaceRoot,
      options: {
        candidateCount: 3,
        voteCount: 3,
        maxSteps: 1
      },
      containerRunner,
      scorer: new FakeScorer(workspaceRoot)
    });

    const state = await readRunState(workspaceRoot);
    expect(state.status).toBe("completed");
    expect(state.completedReason).toBe("max-steps");
    expect(state.history[0]).toMatchObject({
      accepted: true,
      promotedCandidateIndex: 0,
      winningCandidateIndexes: [0, 1]
    });
    expect(await fs.pathExists(path.join(workspaceRoot, state.archivePath, "old"))).toBe(
      true
    );
    expect(await readSkillVersion(workspaceRoot)).toBe(2);
    expect(state.incumbentPath).toBe("steps/1/candidates/0");
    expect(
      await readSkillVersionFromPath(
        workspaceRoot,
        "steps/1/candidates/0/skills/demo/SKILL.md"
      )
    ).toBe(2);
    expect(
      await readSkillVersionFromPath(
        workspaceRoot,
        "steps/1/candidates/1/skills/demo/SKILL.md"
      )
    ).toBe(2);
    expect(
      await readSkillVersionFromPath(
        workspaceRoot,
        "steps/1/candidates/2/skills/demo/SKILL.md"
      )
    ).toBe(2);
  });

  it("runs candidate generations concurrently", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const containerRunner = new ConcurrentCandidateRunner(workspaceRoot, {
      candidateScores: {
        "1:0": 2,
        "1:1": 3
      }
    });

    await runOrchestrator({
      workspaceRoot,
      options: {
        candidateCount: 2,
        maxSteps: 1
      },
      containerRunner,
      scorer: new FakeScorer(workspaceRoot)
    });

    expect(containerRunner.maxActiveCandidateRuns).toBeGreaterThan(1);
  });

  it("runs candidate scoring concurrently after generation completes", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const scorer = new ConcurrentVoteScorer(workspaceRoot);

    await runOrchestrator({
      workspaceRoot,
      options: {
        candidateCount: 2,
        maxSteps: 1
      },
      containerRunner: new FakeContainerRunner(workspaceRoot, {
        candidateScores: {
          "1:0": 2,
          "1:1": 3
        }
      }),
      scorer
    });

    expect(scorer.maxActiveVotes).toBeGreaterThan(1);
  });

  it("reverts skills when the incumbent wins", async () => {
    const workspaceRoot = await createWorkspaceCopy();

    await runOrchestrator({
      workspaceRoot,
      options: {
        candidateCount: 1,
        voteCount: 1
      },
      containerRunner: new FakeContainerRunner(workspaceRoot, {
        mutationVersions: [3],
        candidateScores: {
          "1:0": 0
        }
      }),
      scorer: new FakeScorer(workspaceRoot)
    });

    const state = await readRunState(workspaceRoot);
    expect(state.history[0]).toMatchObject({ accepted: false, winningCandidateIndexes: [] });
    expect(await readSkillVersion(workspaceRoot)).toBe(0);
    expect(state.incumbentPath).toBe("steps/0/baseline");
  });

  it("resumes candidate generation without rerunning completed candidates", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const failingRunner = new FakeContainerRunner(workspaceRoot, {
      candidateScores: {
        "1:0": 2,
        "1:1": 3
      },
      failOnce: (execution) =>
        execution.label === "Candidate 1 generation for step 1"
    });

    await expect(
      runOrchestrator({
        workspaceRoot,
        options: {
          candidateCount: 2,
          maxSteps: 1
        },
        containerRunner: failingRunner,
        scorer: new FakeScorer(workspaceRoot)
      })
    ).rejects.toThrow("Injected container failure");

    const intermediateState = await readRunState(workspaceRoot);
    expect(intermediateState.currentPhase).toBe("generate-candidates");
    expect(intermediateState.activeCandidates.map((candidate) => candidate.status)).toEqual([
      "generated",
      "pending"
    ]);

    const resumeRunner = new FakeContainerRunner(workspaceRoot, {
      candidateScores: {
        "1:0": 2,
        "1:1": 3
      }
    });

    await runOrchestrator({
      workspaceRoot,
      options: {
        candidateCount: 2,
        maxSteps: 1,
        resume: true
      },
      containerRunner: resumeRunner,
      scorer: new FakeScorer(workspaceRoot)
    });

    expect(resumeRunner.executions).toContain("steps/1/candidates/1");
    expect(resumeRunner.executions).not.toContain("steps/1/candidates/0");
  });

  it("resumes scoring from the persisted vote count", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const failingScorer = new FakeScorer(workspaceRoot, { failOnVoteNumber: 2 });

    await expect(
      runOrchestrator({
        workspaceRoot,
        options: {
          candidateCount: 1,
          voteCount: 3,
          maxSteps: 1
        },
        containerRunner: new FakeContainerRunner(workspaceRoot, {
          candidateScores: {
            "1:0": 4
          }
        }),
        scorer: failingScorer
      })
    ).rejects.toThrow("Injected scoring failure");

    const intermediateState = await readRunState(workspaceRoot);
    expect(intermediateState.currentPhase).toBe("score");
    expect(intermediateState.activeCandidates[0].votes).toHaveLength(1);

    const resumeScorer = new FakeScorer(workspaceRoot);
    await runOrchestrator({
      workspaceRoot,
      options: {
        candidateCount: 1,
        voteCount: 3,
        maxSteps: 1,
        resume: true
      },
      containerRunner: new FakeContainerRunner(workspaceRoot, {
        candidateScores: {
          "1:0": 4
        }
      }),
      scorer: resumeScorer
    });

    const finalState = await readRunState(workspaceRoot);
    expect(finalState.activeCandidates).toHaveLength(0);
    expect(finalState.history[0].accepted).toBe(true);
    expect(resumeScorer.voteCalls).toBe(2);
  });

  it("supports human scoring without RUBRIC.md", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    await fs.remove(path.join(workspaceRoot, "RUBRIC.md"));
    const humanReview = new FakeHumanReviewService({
      "0:0": "B",
      "1:0": "A"
    });

    await runOrchestrator({
      workspaceRoot,
      options: {
        scoringMode: "human",
        candidateCount: 2,
        voteCount: 1,
        maxSteps: 1
      },
      containerRunner: new FakeContainerRunner(workspaceRoot, {
        candidateScores: {
          "1:0": 5,
          "1:1": 1
        }
      }),
      scorer: new FakeScorer(workspaceRoot),
      humanReview
    });

    const state = await readRunState(workspaceRoot);
    expect(humanReview.sessions).toBe(1);
    expect(state.scoringMode).toBe("human");
    expect(state.history[0]).toMatchObject({
      accepted: false,
      winningCandidateIndexes: [0]
    });
    expect(state.history[0].incumbentPath).toBe("steps/0/baseline");
  });

  it("resumes human scoring from the persisted vote count", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const partialHumanReview = {
      async startRun() {},
      syncState() {},
      async close() {},
      async reviewCandidates(input: Parameters<FakeHumanReviewService["reviewCandidates"]>[0]) {
        await input.onVote({
          candidateIndex: 0,
          vote: {
            winner: "B" as const,
            confidence: 1,
            rationale: "First human vote."
          }
        });
        throw new Error("Injected human scoring failure");
      }
    };

    await expect(
      runOrchestrator({
        workspaceRoot,
        options: {
          scoringMode: "human",
          candidateCount: 1,
          voteCount: 2,
          maxSteps: 1
        },
        containerRunner: new FakeContainerRunner(workspaceRoot, {
          candidateScores: {
            "1:0": 4
          }
        }),
        scorer: new FakeScorer(workspaceRoot),
        humanReview: partialHumanReview
      })
    ).rejects.toThrow("Injected human scoring failure");

    const intermediateState = await readRunState(workspaceRoot);
    expect(intermediateState.currentPhase).toBe("score");
    expect(intermediateState.activeCandidates[0].votes).toHaveLength(1);

    const resumeHumanReview = new FakeHumanReviewService({
      "0:1": "B"
    });
    await runOrchestrator({
      workspaceRoot,
      options: {
        scoringMode: "human",
        candidateCount: 1,
        voteCount: 2,
        maxSteps: 1,
        resume: true
      },
      containerRunner: new FakeContainerRunner(workspaceRoot, {
        candidateScores: {
          "1:0": 4
        }
      }),
      scorer: new FakeScorer(workspaceRoot),
      humanReview: resumeHumanReview
    });

    const finalState = await readRunState(workspaceRoot);
    expect(resumeHumanReview.sessions).toBe(1);
    expect(finalState.history[0]).toMatchObject({
      accepted: true,
      promotedCandidateIndex: 0
    });
  });

  it("uses the scoring provider from the rubric", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const scorer = new FakeScorer(workspaceRoot, { rubricProvider: "codex" });

    await runOrchestrator({
      workspaceRoot,
      options: {
        candidateCount: 1,
        voteCount: 1,
        maxSteps: 1
      },
      containerRunner: new FakeContainerRunner(workspaceRoot, {
        candidateScores: {
          "1:0": 1
        }
      }),
      scorer
    });

    const state = await readRunState(workspaceRoot);
    expect("scoringProviderOverride" in state).toBe(false);
    expect(scorer.providers).toEqual(["codex"]);
  });

  it("honors min-steps before stasis termination", async () => {
    const workspaceRoot = await createWorkspaceCopy();

    await runOrchestrator({
      workspaceRoot,
      options: {
        candidateCount: 1,
        voteCount: 1,
        maxSteps: 5,
        minSteps: 2,
        stasisSteps: 1
      },
      containerRunner: new FakeContainerRunner(workspaceRoot, {
        mutationVersions: [1, 2, 3],
        candidateScores: {
          "1:0": 0,
          "2:0": 0,
          "3:0": 0
        }
      }),
      scorer: new FakeScorer(workspaceRoot)
    });

    const state = await readRunState(workspaceRoot);
    expect(state.completedReason).toBe("stasis");
    expect(state.history).toHaveLength(2);
    expect(state.history.every((entry) => entry.accepted === false)).toBe(true);
  });
});
