# skill-autoresearch Implementation Plan

## Problem

Build a TypeScript CLI named `skill-autoresearch` that iteratively improves a skill folder by:

- generating artifacts from the current skill into `./steps`
- editing the live skill with instruction-driven agent runs
- regenerating artifacts
- scoring previous vs current outputs with an LLM rubric
- keeping the better skill version and repeating
- persisting enough state to resume safely after interruption

## Recommended approach

Implement this as a single Commander-based CLI with a `run` command and a small set of internal services:

- `workspace` for filesystem layout, symlinks, archiving, and snapshots
- `containerRunner` for `@botanicastudios/code-container` executions
- `scorer` for rubric parsing, command-driven evidence collection, and Vercel AI SDK scoring
- `stateStore` for resumable run state
- `orchestrator` for the recursive improvement loop

This keeps external integrations isolated and makes the core loop testable without invoking Claude, Docker, or OpenRouter in every test.

## Proposed CLI surface

Primary command:

```bash
skill-autoresearch run [workspace]
```

Initial flags:

- `--candidates <n>`: number of generation candidates per step, default `3`
- `--votes <n>`: number of scoring passes per comparison, default `3`
- `--min-steps <n>`: minimum number of mutation iterations before termination is allowed, default `0`
- `--max-steps <n>`: hard cap on mutation iterations
- `--stasis-steps <n>`: terminate after this many consecutive rejected mutation iterations (disabled by default)
- `--resume`: resume existing run state instead of starting fresh
- `--model <id>`: optional override for rubric frontmatter model
- `--dry-run`: validate inputs and print planned actions without running agents
- `--verbose`: include child command details in logs

Defer extra subcommands until the core loop works. If needed later, add `status` and `reset` as separate commands rather than overloading `run`.

## Workspace contract

Expected root contents:

- `INSTRUCTIONS.md`
- `GENERATION.md`
- `RUBRIC.md`
- `skills/`
- `steps/`
- `archive/`

Managed runtime artifacts:

- `skills-original/`
- `skills-previous/`
- `.skill-autoresearch/state.json`
- `.skill-autoresearch/logs/`

Assumptions:

- the user manually places one or more skill folders inside `skills/`
- each skill folder must contain `SKILL.md`
- the CLI operates relative to the workspace root

Fail fast if required files or folders are missing or malformed. Do not silently create missing source inputs other than runtime state directories.

## Filesystem behavior

### 1. Skill symlinks

Ensure these symlinks point to `./skills`:

- `.claude/skills`
- `.agents/skills`

Rules:

- create parent directories if absent
- if the path already exists as the correct symlink, leave it
- if the path exists but is not the expected symlink, exit with a clear error instead of replacing it

This preserves the "no fallback" requirement and avoids mutating user-owned paths unexpectedly.

### 2. Fresh-run archive

On a non-resume run:

- if `steps/` contains any entries, move all current contents into `archive/<timestamp>/`
- use a filesystem-safe UTC timestamp such as `2026-03-20T19-57-00Z`
- leave `steps/` itself in place

### 3. Skill snapshots

Snapshot rules:

- before the first mutation, copy `skills/` to `skills-original/`
- before each instruction-driven mutation pass, copy current `skills/` to `skills-previous/`
- if the scorer prefers the previous version, replace `skills/` with `skills-previous/`

Implementation note:

- use copy-then-atomic-rename where practical
- never mutate `skills-original/`

## State model

Persist resumable state in:

```text
.skill-autoresearch/state.json
```

Recommended shape:

```json
{
  "version": 1,
  "runId": "2026-03-20T19-57-00Z",
  "workspaceRoot": "/abs/path",
  "status": "idle|running|awaiting-score|failed|completed",
  "stepIndex": 0,
  "candidateCount": 3,
  "voteCount": 3,
  "minSteps": 0,
  "maxSteps": 20,
  "consecutiveRejections": 0,
  "archivePath": "archive/2026-03-20T19-57-00Z",
  "skillsOriginalPath": "skills-original",
  "skillsPreviousPath": "skills-previous",
  "currentPhase": "generate-baseline|snapshot|mutate-skills|generate-candidates|score|promote",
  "activeCandidates": [
    {
      "index": 0,
      "path": "steps/1/candidates/0",
      "status": "pending|generated|scored|accepted|rejected",
      "votes": []
    }
  ],
  "history": []
}
```

Requirements:

- write after every durable phase transition
- record enough information to resume without rerunning already-completed phases
- detect workspace mismatch and refuse resume if `workspaceRoot` changed

## Directory layout for iterations

Recommended step layout:

```text
steps/
  0/
    baseline/
  1/
    candidates/
      0/
      1/
  2/
    candidates/
      0/
```

Baseline convention:

- `steps/0/baseline/` is produced before any skill mutation

Iteration convention:

- after mutating `skills/`, generate candidate outputs into `steps/<n>/candidates/<i>/`
- compare each candidate against the current best output from the previous accepted step
- promote one winning candidate per iteration

This is cleaner than writing directly into `steps/<n>` because it scales to multiple candidates without special cases.

## Execution loop

### Phase A. Start or resume

1. Resolve workspace root.
2. Validate required files and skill folder structure.
3. Ensure symlinks.
4. If `--resume`, load and validate state.
5. If fresh run, archive existing `steps/` contents, initialize state, set `stepIndex = 0`.

### Phase B. Generate baseline

1. Run `container exec ./steps/0/baseline -- claude -p "<GENERATION.md contents>"`.
2. Mark baseline as the current best artifact set.
3. Copy `skills/` to `skills-original/`.
4. Increment `stepIndex` to `1`.

### Phase C. Mutation pass

1. Copy current `skills/` to `skills-previous/`.
2. Run `container exec ./skills -- claude -p "<INSTRUCTIONS.md contents>"`.
3. Record that the skill mutation completed.

### Phase D. Candidate generation

For each candidate `i` in `[0, candidates)`:

1. Create `steps/<stepIndex>/candidates/<i>/`.
2. Run `container exec ./steps/<stepIndex>/candidates/<i> -- claude -p "<GENERATION.md contents>"`.
3. Mark candidate as generated.

### Phase E. Scoring

1. Parse `RUBRIC.md` frontmatter and body.
2. Strip frontmatter from the rubric body and use the remainder as the scoring system prompt.
3. For the incumbent output and each candidate output:
   - execute the frontmatter-defined evidence command with `$STEP_PATH` interpolated
   - collect either text or image evidence based on `outputType`
4. For each candidate, run `generateObject` `voteCount` times with:
   - system: rubric body
   - user message A: incumbent evidence labeled candidate A
   - user message B: candidate evidence labeled candidate B
5. Mark a candidate as a comparison winner only if candidate B receives more than 50% of votes for that candidate.
6. Mark the mutated skill as a step winner only if more than 50% of generated candidates are comparison winners.
7. If the mutated skill wins, promote the strongest winning candidate artifact set as the new incumbent for the next step. Recommended tie-break order:
   - highest vote count for B
   - highest average confidence when available
   - lowest candidate index for deterministic behavior

Recommended structured output schema:

```ts
z.object({
  winner: z.enum(["A", "B"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string()
})
```

### Phase F. Promote or revert

1. If more than 50% of candidates beat the incumbent, keep current `skills/`, promote the strongest winning candidate output as the new incumbent artifact set, reset the rejection streak, increment `stepIndex`, and loop back to Phase C.
2. If 50% or fewer candidates beat the incumbent, replace `skills/` with `skills-previous/`, increment the rejection streak, increment `stepIndex`, and loop back to Phase C.

Stopping conditions:

- `--max-steps` reached
- `--stasis-steps` reached after at least `--min-steps`
- fatal child process failure
- invalid rubric command output
- manual interruption

## Rubric format

Recommended `RUBRIC.md` structure:

```md
---
model: openai/gpt-4.1
outputType: text
command: cat "$STEP_PATH/index.html"
---

Judge which candidate better satisfies the rubric...
```

If images are needed:

```md
---
model: anthropic/claude-3.7-sonnet
outputType: image
command: playwright-cli screenshot "$STEP_PATH/index.html" "$STEP_PATH/__score.png"
resultPath: "$STEP_PATH/__score.png"
---
```

Implementation recommendation:

- support either a single command object or an array of command objects in frontmatter
- support `resultPath` for commands that write files rather than stdout
- normalize both forms to an internal `commands[]` representation before execution
- require frontmatter keys explicitly and fail if missing

Recommended normalized frontmatter:

```md
---
model: openai/gpt-4.1
outputType: text
commands:
  - command: cat "$STEP_PATH/index.html"
---
```

Array example:

```md
---
model: anthropic/claude-3.7-sonnet
outputType: image
commands:
  - command: playwright-cli serve-and-screenshot "$STEP_PATH/index.html" "$STEP_PATH/hero.png"
    resultPath: "$STEP_PATH/hero.png"
  - command: playwright-cli serve-and-screenshot "$STEP_PATH/about.html" "$STEP_PATH/about.png"
    resultPath: "$STEP_PATH/about.png"
---
```

Keep v1 strict even with array support:

- all commands in one rubric must use the same `outputType`
- each command must resolve to exactly one evidence item
- execution order is preserved

## Package and runtime choices

Recommended stack:

- TypeScript
- Commander.js
- `@botanicastudios/code-container`
- `ai`
- `@openrouter/ai-sdk-provider`
- `zod`
- `gray-matter`
- `dotenv`
- `execa`
- `fs-extra`

Notes from source verification:

- `@botanicastudios/code-container` ships a `container` CLI and documents `container exec /path/to/project -- <command>`
- `@openrouter/ai-sdk-provider` supports Vercel AI SDK usage with `openrouter(modelId)`

Recommended module layout:

```text
src/
  cli.ts
  commands/run.ts
  core/orchestrator.ts
  core/state-store.ts
  core/workspace.ts
  core/container-runner.ts
  core/scorer.ts
  core/rubric.ts
  core/logger.ts
  types/state.ts
  types/rubric.ts
```

## Logging

Console logs should be phase-oriented and explicit:

- workspace validation
- archive action
- baseline generation start/end
- skill mutation start/end
- candidate generation start/end
- scoring vote summaries
- promotion or revert decision
- saved state path

Also write machine-readable JSONL logs into `.skill-autoresearch/logs/` for debugging resume failures.

## Error handling

Fail loudly on:

- missing `SKILL.md` in any skill folder
- existing incorrect symlink targets
- missing `.env` or missing `OPENROUTER_API_KEY`
- unsupported rubric frontmatter
- scoring command exit failure
- non-image output when `outputType=image`
- empty evidence output

Resume behavior:

- if state says a phase completed, do not rerun it automatically
- if a phase was in progress at interruption time, rerun only that phase after warning in logs

## Testing plan

### Unit tests

- rubric frontmatter parsing
- single-command and multi-command rubric normalization
- `$STEP_PATH` interpolation
- state transition validation
- vote aggregation
- winner selection
- symlink validation logic

### Integration tests

- fresh run with archived prior steps
- resume after interruption during candidate generation
- resume after interruption during scoring
- revert flow when incumbent wins
- promotion flow when candidate wins
- stasis termination after rejection streak
- min-step gating before stasis termination
- multi-candidate majority acceptance

Mock external processes in integration tests. Do not require Docker, Claude, or OpenRouter for the default test suite.

### Manual acceptance test

Use a tiny fixture workspace with:

- one skill containing a `SKILL.md`
- deterministic fake `container` command
- deterministic fake scorer

This should prove the loop and state persistence before wiring real agent calls.

## Delivery phases

### Phase 1

- scaffold TypeScript CLI
- implement workspace validation, symlinks, archive logic, and state store
- implement baseline and mutation orchestration with stubbed scoring

### Phase 2

- implement candidate generation layout
- implement rubric parsing and evidence command execution
- implement OpenRouter scoring with `generateObject`
- implement candidate-majority and vote-majority decision rules

### Phase 3

- implement resume robustness
- add tests and fixture workspaces
- refine logs and error messages

## Acceptance criteria

- running `skill-autoresearch run` on a valid workspace initializes symlinks and state
- existing `steps/` contents are archived on fresh runs
- baseline output is generated before the first skill mutation
- each iteration snapshots `skills/` before mutation
- multiple candidates per step are supported
- multiple scoring votes per candidate are supported
- a candidate only counts as a winner if it receives more than 50% of scoring votes
- a mutated skill version only counts as a winner if more than 50% of candidates are winners
- the promoted incumbent artifact is selected deterministically from winning candidates
- `skills/` is reverted to `skills-previous/` when the incumbent wins
- the run respects `--min-steps`, `--max-steps`, and `--stasis-steps`
- an interrupted run can resume from persisted state without redoing completed phases

## Next step

Implement the CLI scaffold and state machine first. The external integrations are straightforward once the phase model and on-disk contract are fixed.
