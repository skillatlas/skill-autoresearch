import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

import { Logger } from "../src/core/logger.js";
import {
  CodexVoteJudge,
  OpenRouterVoteJudge,
  Scorer,
  selectBestWinningCandidate,
  summarizeVotes
} from "../src/core/scorer.js";

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

  it("rejects image evidence when the file bytes are not an image", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scorer-"));
    await fs.ensureDir(path.join(workspaceRoot, "step"));
    const scorer = new Scorer(
      workspaceRoot,
      new Logger(false),
      {
        openrouter: {
          async generateVote() {
            throw new Error("generateVote should not be called in this test");
          }
        },
        codex: {
          async generateVote() {
            throw new Error("generateVote should not be called in this test");
          }
        }
      },
      false
    );

    await expect(
      scorer.collectEvidence(
        {
          sourcePath: "RUBRIC.md",
          provider: "openrouter",
          modelId: "test-model",
          commands: [
            {
              outputType: "image",
              command:
                "node -e \"require('fs').writeFileSync(process.env.STEP_PATH + '/bad.png', 'not an image')\"",
              resultPath: "$STEP_PATH/bad.png"
            }
          ],
          prompt: "Judge screenshots."
        },
        "step"
      )
    ).rejects.toThrow("does not match the expected image/png format");
  });

  it("collects mixed text and image evidence from one rubric", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scorer-"));
    await fs.ensureDir(path.join(workspaceRoot, "step"));
    const scorer = new Scorer(
      workspaceRoot,
      new Logger(false),
      {
        openrouter: {
          async generateVote() {
            throw new Error("generateVote should not be called in this test");
          }
        },
        codex: {
          async generateVote() {
            throw new Error("generateVote should not be called in this test");
          }
        }
      },
      false
    );

    const evidence = await scorer.collectEvidence(
      {
        sourcePath: "RUBRIC.md",
        provider: "openrouter",
        modelId: "test-model",
        commands: [
          {
            outputType: "text",
            command: "node -e \"process.stdout.write('headline\\n')\""
          },
          {
            outputType: "image",
            command:
              "node -e \"require('fs').writeFileSync(process.env.STEP_PATH + '/shot.png', Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))\"",
            resultPath: "$STEP_PATH/shot.png"
          }
        ],
        prompt: "Judge both evidence types."
      },
      "step"
    );

    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toEqual({
      outputType: "text",
      label: "command-1",
      content: "headline"
    });
    expect(evidence[1]).toMatchObject({
      outputType: "image",
      label: "command-2",
      path: path.join(workspaceRoot, "step", "shot.png"),
      mimeType: "image/png"
    });
  });

  it("builds a mixed OpenRouter evidence message", () => {
    const imageBytes = Buffer.from("image");
    const message = (new OpenRouterVoteJudge() as any).buildEvidenceMessage(
      "Candidate A",
      [
        {
          outputType: "text",
          label: "markup",
          content: "<main>Hello</main>"
        },
        {
          outputType: "image",
          label: "screenshot",
          path: "/tmp/shot.png",
          mimeType: "image/png",
          bytes: imageBytes
        }
      ]
    );

    expect(Array.isArray(message.content)).toBe(true);
    expect(message.content[1]).toEqual({
      type: "text",
      text: "Evidence 1 (markup):\n<main>Hello</main>"
    });
    expect(message.content[2]).toEqual({
      type: "text",
      text: "Evidence 2 (screenshot)"
    });
    expect(message.content[3]).toEqual({
      type: "image",
      image: imageBytes
    });
  });

  it("builds a mixed Codex prompt with stable image ordering", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-"));
    const prompt = (new CodexVoteJudge(workspaceRoot, new Logger(false), false) as any)
      .buildPrompt({
        rubricPrompt: "Pick the stronger candidate.",
        incumbentEvidence: [
          {
            outputType: "text",
            label: "markup",
            content: "<main>A</main>"
          },
          {
            outputType: "image",
            label: "hero",
            path: path.join(workspaceRoot, "a.png"),
            mimeType: "image/png",
            bytes: Buffer.from("a")
          }
        ],
        candidateEvidence: [
          {
            outputType: "image",
            label: "hero",
            path: path.join(workspaceRoot, "b.png"),
            mimeType: "image/png",
            bytes: Buffer.from("b")
          },
          {
            outputType: "text",
            label: "markup",
            content: "<main>B</main>"
          }
        ]
      });

    expect(prompt).toContain("Evidence 1 (markup) [text]:");
    expect(prompt).toContain("<main>A</main>");
    expect(prompt).toContain("Evidence 2 (hero) [image attachment 1]: a.png");
    expect(prompt).toContain("Evidence 1 (hero) [image attachment 2]: b.png");
    expect(prompt).toContain("Evidence 2 (markup) [text]:");
    expect(prompt).toContain("Image attachments are provided in the numbered order above.");
  });
});
