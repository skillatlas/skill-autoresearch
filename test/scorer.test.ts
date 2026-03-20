import { selectBestWinningCandidate, summarizeVotes } from "../src/core/scorer.js";

describe("scoring helpers", () => {
  it("aggregates candidate votes", () => {
    const summary = summarizeVotes([
      { attempt: 0, winner: "B", confidence: 0.9, rationale: "better" },
      { attempt: 1, winner: "A", confidence: 0.5, rationale: "worse" },
      { attempt: 2, winner: "B", confidence: 0.8, rationale: "better" }
    ]);

    expect(summary).toEqual({
      aVotes: 1,
      bVotes: 2,
      averageConfidence: (0.9 + 0.5 + 0.8) / 3,
      isWinner: true
    });
  });

  it("selects the strongest winning candidate deterministically", () => {
    const candidate = selectBestWinningCandidate([
      {
        index: 2,
        path: "steps/1/candidates/2",
        status: "scored",
        votes: [],
        comparison: { aVotes: 0, bVotes: 3, averageConfidence: 0.7, isWinner: true }
      },
      {
        index: 1,
        path: "steps/1/candidates/1",
        status: "scored",
        votes: [],
        comparison: { aVotes: 0, bVotes: 3, averageConfidence: 0.9, isWinner: true }
      }
    ]);

    expect(candidate?.index).toBe(1);
  });
});
