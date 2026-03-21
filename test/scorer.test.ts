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

  it("includes rubric command output when evidence collection fails", async () => {
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

    let thrownError: Error | undefined;

    try {
      await scorer.collectEvidence(
        {
          sourcePath: "RUBRIC.md",
          provider: "openrouter",
          modelId: "test-model",
          commands: [
            {
              outputType: "text",
              command:
                "node -e \"console.log('stdout-line'); console.error('stderr-line'); process.exit(7)\"",
              resultPath: "$STEP_PATH/output.txt"
            }
          ],
          prompt: "Judge the outputs."
        },
        "step"
      );
    } catch (error) {
      thrownError = error as Error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect(thrownError?.message).toContain(
      "Rubric command failed for step with exit code 7."
    );
    expect(thrownError?.message).toContain("Command: node -e");
    expect(thrownError?.message).toContain("stdout-line");
    expect(thrownError?.message).toContain("stderr-line");
  });

  it("collects mixed text and image evidence from one rubric", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scorer-"));
    await fs.ensureDir(path.join(workspaceRoot, "step"));
    await fs.writeFile(path.join(workspaceRoot, "step", "headline.txt"), "headline\n", "utf8");
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
            resultPath: "$STEP_PATH/headline.txt"
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
      label: "evidence-1",
      content: "headline"
    });
    expect(evidence[1]).toMatchObject({
      outputType: "image",
      label: "evidence-2",
      path: path.join(workspaceRoot, "step", "shot.png"),
      mimeType: "image/png"
    });
  });

  it("provides STEP_ORIGIN when `http_server` is enabled", async () => {
    const workspaceParent = await fs.mkdtemp(path.join(os.tmpdir(), "scorer-"));
    const workspaceRoot = path.join(workspaceParent, "workspace with space");
    const stepPath = "step with space";
    const absoluteStepPath = path.join(workspaceRoot, stepPath);
    await fs.ensureDir(absoluteStepPath);
    await fs.writeFile(
      path.join(absoluteStepPath, "index.html"),
      "<!doctype html><html><body><main>hello</main></body></html>",
      "utf8"
    );

    const fakeBinDir = path.join(workspaceParent, "bin");
    const logPath = path.join(workspaceParent, "playwright.log");
    await fs.ensureDir(fakeBinDir);
    await fs.writeFile(
      path.join(fakeBinDir, "playwright-cli"),
      `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
fs.appendFileSync(process.env.PLAYWRIGHT_CLI_LOG_PATH, \`\${JSON.stringify(args)}\\n\`);

const commandIndex = args[0]?.startsWith("-s=") ? 1 : 0;
const command = args[commandIndex];

if (command === "screenshot") {
  const filenameIndex = args.indexOf("--filename");
  if (filenameIndex === -1 || !args[filenameIndex + 1]) {
    console.error("missing --filename");
    process.exit(2);
  }

  fs.mkdirSync(path.dirname(args[filenameIndex + 1]), { recursive: true });
  fs.writeFileSync(
    args[filenameIndex + 1],
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  );
}
`,
      "utf8"
    );
    await fs.chmod(path.join(fakeBinDir, "playwright-cli"), 0o755);

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

    const previousPath = process.env.PATH;
    const previousLogPath = process.env.PLAYWRIGHT_CLI_LOG_PATH;
    process.env.PATH = `${fakeBinDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.PLAYWRIGHT_CLI_LOG_PATH = logPath;

    try {
      const evidence = await scorer.collectEvidence(
        {
          sourcePath: "RUBRIC.md",
          provider: "openrouter",
          modelId: "test-model",
          httpServerPort: 0,
          commands: [
            {
              outputType: "image",
              command:
                'playwright-cli -s="$RUBRIC_RUN_ID" open "$STEP_ORIGIN/index.html" && playwright-cli -s="$RUBRIC_RUN_ID" resize 1440 1080 && playwright-cli -s="$RUBRIC_RUN_ID" screenshot --filename "$STEP_PATH/index.png" && playwright-cli -s="$RUBRIC_RUN_ID" close',
              resultPath: "$STEP_PATH/index.png"
            }
          ],
          prompt: "Judge screenshots."
        },
        stepPath
      );

      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        outputType: "image",
        label: "evidence-1",
        path: path.join(absoluteStepPath, "index.png"),
        mimeType: "image/png"
      });

      const commandLog = (await fs.readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(commandLog).toHaveLength(4);
      const sessionFlag = commandLog[0]?.[0];
      expect(sessionFlag).toMatch(/^-s=rubric-/);
      expect(commandLog[0]).toEqual([
        sessionFlag,
        "open",
        expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/)
      ]);
      expect(commandLog[1]).toEqual([sessionFlag, "resize", "1440", "1080"]);
      expect(commandLog[2]).toEqual([
        sessionFlag,
        "screenshot",
        "--filename",
        path.join(absoluteStepPath, "index.png")
      ]);
      expect(commandLog[3]).toEqual([sessionFlag, "close"]);
    } finally {
      process.env.PATH = previousPath;
      if (previousLogPath == null) {
        delete process.env.PLAYWRIGHT_CLI_LOG_PATH;
      } else {
        process.env.PLAYWRIGHT_CLI_LOG_PATH = previousLogPath;
      }
    }
  });

  it("builds a mixed OpenRouter evidence message", () => {
    const imageBytes = Buffer.from("image");
    const message = (new OpenRouterVoteJudge(new Logger(false)) as any).buildEvidenceMessage(
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

  it("logs the OpenRouter scoring input when DEBUG_SCORE=1", () => {
    const logger = new Logger(false);
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const previousDebugScore = process.env.DEBUG_SCORE;
    process.env.DEBUG_SCORE = "1";

    try {
      (new OpenRouterVoteJudge(logger) as any).logDebugInput(
        {
          modelId: "test-model",
          rubricPrompt: "Judge the candidates.",
          incumbentEvidence: [
            {
              outputType: "text",
              label: "markup",
              content: "<main>A</main>"
            }
          ],
          candidateEvidence: [
            {
              outputType: "image",
              label: "shot",
              path: "/tmp/b.png",
              mimeType: "image/png",
              bytes: Buffer.from("b")
            }
          ]
        },
        [
          {
            role: "user",
            content: "Candidate A evidence:\n\nEvidence 1 (markup):\n<main>A</main>"
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Candidate B evidence."
              },
              {
                type: "image",
                image: Buffer.from("b")
              }
            ]
          }
        ]
      );

      expect(infoSpy).toHaveBeenCalledTimes(1);
      const [message] = infoSpy.mock.calls[0];
      expect(message).toContain("OpenRouter scoring input");
      expect(message).toContain('"provider": "openrouter"');
      expect(message).toContain('"byteLength": 1');
    } finally {
      if (previousDebugScore === undefined) {
        delete process.env.DEBUG_SCORE;
      } else {
        process.env.DEBUG_SCORE = previousDebugScore;
      }
      infoSpy.mockRestore();
    }
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

  it("logs the Codex scoring input when DEBUG_SCORE=1", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-"));
    const logger = new Logger(false);
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const previousDebugScore = process.env.DEBUG_SCORE;
    process.env.DEBUG_SCORE = "1";

    try {
      (new CodexVoteJudge(workspaceRoot, logger, false) as any).logDebugInput(
        {
          modelId: "gpt-5",
          rubricPrompt: "Judge the candidates.",
          incumbentEvidence: [
            {
              outputType: "text",
              label: "markup",
              content: "<main>A</main>"
            }
          ],
          candidateEvidence: [
            {
              outputType: "image",
              label: "shot",
              path: path.join(workspaceRoot, "b.png"),
              mimeType: "image/png",
              bytes: Buffer.from("b")
            }
          ]
        },
        "Prompt text",
        [path.join(workspaceRoot, "b.png")],
        ["exec", "--image", path.join(workspaceRoot, "b.png"), "Prompt text"]
      );

      expect(infoSpy).toHaveBeenCalledTimes(1);
      const [message] = infoSpy.mock.calls[0];
      expect(message).toContain("Codex scoring input");
      expect(message).toContain('"provider": "codex"');
      expect(message).toContain('"prompt": "Prompt text"');
    } finally {
      if (previousDebugScore === undefined) {
        delete process.env.DEBUG_SCORE;
      } else {
        process.env.DEBUG_SCORE = previousDebugScore;
      }
      infoSpy.mockRestore();
    }
  });
});
