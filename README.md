# skill-autoresearch

Iteratively improve skill files through an automated generate-score-promote loop. The tool mutates a skill, generates artifacts using it, scores the output against an incumbent, and keeps the winner — repeating until the skill converges or a step limit is reached.

Runs are **resumable**: if the process is interrupted, re-run with `--resume` to pick up where you left off.

## How it works

```
                  ┌─────────────┐
                  │  Baseline   │  Generate artifacts with the current skill
                  └──────┬──────┘
                         │
              ┌──────────▼──────────┐
              │   Snapshot skills   │  Save current skill as "previous"
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │    Mutate skill     │  LLM edits the skill per INSTRUCTIONS.md
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │ Generate candidates │  Create N artifacts with the mutated skill
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │       Score         │  Compare each candidate vs incumbent
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │  Promote / Revert   │  Keep winner or roll back to previous skill
              └──────────┬──────────┘
                         │
                    Loop until done
```

## Getting started

### 1. Install

```bash
# Run directly with npx (no install needed):
npx skill-autoresearch run

# Or install globally:
npm install -g skill-autoresearch
skill-autoresearch run
```

### 2. Set up a workspace

A workspace is a directory containing everything the tool needs. You can scaffold one with sample files:

```bash
skill-autoresearch bootstrap
```

This creates starter versions of every required file without overwriting anything that already exists. Or create the workspace manually with this structure:

```
my-workspace/
├── .env                 # API keys (see below)
├── INSTRUCTIONS.md      # How to improve the skill each iteration
├── GENERATION.md        # Prompt + harness for generating artifacts
├── RUBRIC.md            # Scoring criteria + model config
└── skills/
    └── my-skill/
        └── SKILL.md     # The skill file to improve
```

Each file is described in detail below.

### 3. Configure environment variables

Create a `.env` file at your workspace root. The variables you need depend on which harness and scoring provider you're using.

#### For scoring (required in rubric mode)

| Variable | When needed | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | Rubric scoring with `provider: openrouter` | Your [OpenRouter](https://openrouter.ai) API key |

#### For generation (forwarded to containers)

The generation harness runs inside an isolated container. These variables are forwarded from your environment automatically — you can set them in `.env` or export them in your shell.

| Variable | Harness | Description |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude` | Auth token for Claude Code |
| `OPENAI_API_KEY` | `codex` | OpenAI API key for Codex |
| `OPENAI_BASE_URL` | `codex` | Custom OpenAI base URL (optional) |
| `OPENAI_ORG_ID` | `codex` | OpenAI organization ID (optional) |
| `OPENAI_PROJECT_ID` | `codex` | OpenAI project ID (optional) |

#### Debug flags (optional)

| Variable | Effect |
|---|---|
| `DEBUG_GENERATION=1` | Stream verbose output from Claude during generation |
| `DEBUG_SCORE=1` | Log scoring inputs to JSONL |

**Example `.env`:**

```env
OPENROUTER_API_KEY=sk-or-v1-abc123...
CLAUDE_CODE_OAUTH_TOKEN=your-token-here
```

### 4. Run it

```bash
# From within the workspace directory:
npx skill-autoresearch run

# Or point to a workspace:
npx skill-autoresearch run ./my-workspace

# Dry run — validate inputs without executing anything:
npx skill-autoresearch run --dry-run
```

## Workspace files

### `INSTRUCTIONS.md`

Tells the LLM how to improve the skill on each iteration. This is the prompt used during the **mutate** phase. It should describe what kind of edits are acceptable, what to avoid, and any constraints (e.g. max file length, no specific font names).

### `GENERATION.md`

Defines what artifact to generate and which harness to use. Uses YAML frontmatter:

```markdown
---
harness: claude    # or "codex"
---

Build a landing page for a fictional company called "Acme Corp". Include a hero, features section, and footer.
```

The `harness` field controls which coding agent runs inside the container (`claude` or `codex`). The markdown body is the prompt.

### `RUBRIC.md`

Defines how generated artifacts are scored. Uses YAML frontmatter for configuration and markdown body for evaluation criteria:

```markdown
---
provider: openrouter
model: google/gemini-3-flash-preview
commands:
  - outputType: text
    resultPath: "$STEP_PATH/index.html"
  - outputType: image
    command: playwright-cli screenshot "$STEP_PATH/index.html" "$STEP_PATH/index.png"
    resultPath: "$STEP_PATH/index.png"
---

You are a design critic evaluating two HTML pages. Score them on visual identity, typography, layout, and code quality. Declare a winner.
```

**Frontmatter fields:**

| Field | Description |
|---|---|
| `provider` | `openrouter` or `codex` |
| `model` | Model ID for scoring (e.g. `google/gemini-3-flash-preview`) |
| `commands` | Array of evidence-collection steps |
| `commands[].outputType` | `text` or `image` |
| `commands[].command` | Shell command to produce evidence (optional — omit to read the file directly) |
| `commands[].resultPath` | Path to the evidence file. `$STEP_PATH` is replaced at runtime. |

### `skills/<name>/SKILL.md`

The skill file that gets iteratively improved. You can have multiple skill folders — each must contain a `SKILL.md`. This is the file the mutate phase edits.

## CLI reference

### `skill-autoresearch bootstrap [workspace]`

Scaffold a new workspace with sample `INSTRUCTIONS.md`, `GENERATION.md`, `RUBRIC.md`, and `skills/` directory. Skips any file that already exists.

### `skill-autoresearch run [workspace] [options]`

| Option | Default | Description |
|---|---|---|
| `--candidates <n>` | `3` | Number of candidate artifacts per step |
| `--votes <n>` | `3` (rubric), `1` (human) | Scoring votes per comparison |
| `--min-steps <n>` | `0` | Minimum iterations before stasis applies |
| `--max-steps <n>` | `20` | Maximum iterations. Pass without a value to disable the limit. |
| `--stasis-steps <n>` | — | Stop after this many consecutive rejections |
| `--resume` | `false` | Resume from saved state |
| `--model <id>` | — | Override the rubric model |
| `--scoring-mode <mode>` | `rubric` | `rubric` (LLM judge) or `human` (local review UI) |
| `--dry-run` | `false` | Validate inputs, print plan, don't execute |
| `--verbose` | `false` | Show container command output |

## Runtime directories

These are created automatically inside the workspace during a run:

```
my-workspace/
├── steps/                        # Generated artifacts
│   ├── 0/                        # Baseline
│   │   └── baseline/
│   └── 1/
│       └── candidates/
│           ├── 0/
│           ├── 1/
│           └── 2/
├── skills-original/              # Snapshot of skills before any mutations
├── skills-previous/              # Snapshot before the most recent mutation
├── archive/                      # Archived steps from previous runs
└── .skill-autoresearch/
    ├── state.json                # Resumable run state
    └── logs/
        └── <run-id>.jsonl        # Structured logs
```

## Scoring modes

### Rubric mode (default)

An LLM reads the generated artifacts and the rubric, then votes on which candidate is better. Multiple votes are aggregated to pick a winner.

```bash
skill-autoresearch run --scoring-mode rubric --votes 5
```

### Human mode

Opens a local HTTP server with a side-by-side review UI. You compare the incumbent and candidate artifacts in your browser and vote manually.

```bash
skill-autoresearch run --scoring-mode human
```

## Resuming a run

If a run is interrupted, its state is saved to `.skill-autoresearch/state.json`. Resume from exactly where it stopped:

```bash
skill-autoresearch run --resume
```

The tool validates that the workspace and CLI options match the saved state before resuming.

## Development

```bash
npm run build        # Compile TypeScript to dist/
npm run typecheck    # Type-check without emitting
npm test             # Run tests with vitest
```
