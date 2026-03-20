import fs from "fs-extra";
import path from "node:path";

import {
  createWorkspaceCopy,
  FakeContainerRunner,
  FakeScorer,
  readRunState,
  readSkillVersion,
  runOrchestrator
} from "./helpers.js";

describe("orchestrator integration", () => {
  it("generates the baseline even when max-steps is zero", async () => {
    const workspaceRoot = await createWorkspaceCopy();
    const containerRunner = new FakeContainerRunner(workspaceRoot);

    await runOrchestrator({
      workspaceRoot,
      options: {
        maxSteps: 0
      },
      containerRunner,
      scorer: new FakeScorer(workspaceRoot)
    });

    const state = await readRunState(workspaceRoot);
    expect(state.status).toBe("completed");
    expect(state.completedReason).toBe("max-steps");
    expect(state.history).toHaveLength(0);
    expect(state.incumbentPath).toBe("steps/0/baseline");
    expect(containerRunner.executions).toEqual(["steps/0/baseline"]);
    expect(await fs.pathExists(path.join(workspaceRoot, "steps", "0", "baseline", "index.html"))).toBe(
      true
    );
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
  });

  it("reverts skills when the incumbent wins", async () => {
    const workspaceRoot = await createWorkspaceCopy();

    await runOrchestrator({
      workspaceRoot,
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
        execution.targetPath.endsWith(path.join("steps", "1", "candidates", "1"))
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

  it("honors min-steps before stasis termination", async () => {
    const workspaceRoot = await createWorkspaceCopy();

    await runOrchestrator({
      workspaceRoot,
      options: {
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
