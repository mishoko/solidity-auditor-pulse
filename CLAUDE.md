# CLAUDE.md — Benchmark Runner

## What This Is

CLI tool that benchmarks the `solidity-auditor` Claude Code skill (from [pashov/skills](https://github.com/pashov/skills)) against a bare Claude baseline. Runs multiple iterations of each condition against real Solidity codebases, captures raw output, verifies execution integrity, and generates comparison reports with recall/FP scoring against ground truth.

## Project Structure

```
src/                TypeScript source (cli, config, runner, workspace, skill, parser, summary, verify, util/)
config/             JSON benchmark configs (bench.json)
datasets/           Solidity codebases to audit (submodules + canary inline)
skills_versions/    Pinned skill snapshots (v1/, v2/, each with source.json provenance)
workspaces/         Ephemeral real-copy workspaces (gitignored, auto-cleaned)
results/            Run outputs: .stdout.txt, .meta.json, .events.jsonl, .stderr.txt per run (gitignored)
ground_truth/       Known-bug answer keys per codebase (JSON, enables Recall/FP scoring)
ground_truth/reports/  Official C4 audit reports (markdown)
docs/               Isolation strategy, benchmark prompt template
```

## How It Works

`npm run bench` runs the full matrix (all codebases x all conditions x N runs). **This is expensive** — prefer filtered runs during development.

1. Reads `config/bench.json`
2. Prepares workspaces (one per codebase × condition):
   - Each condition gets its own workspace: `workspaces/<codebase>__<conditionId>/`
   - Codebase files are **real copies** (not symlinks) from `datasets/`
   - A `CLAUDE.md` is written per workspace to block parent walk-up and deliver scope info
   - **Skill runs**: `.claude/commands/solidity-auditor/` installed with correct version + VERSION verified
   - **Bare runs**: no skill installed, just the codebase copy
3. For each `(codebase, condition, iteration)`:
   - Spawns `claude -p "<prompt>" --output-format stream-json --verbose` in the workspace cwd
   - All runs: `--dangerously-skip-permissions --setting-sources project,local`
   - Bare runs add `--disable-slash-commands --disallowedTools Skill`
   - 10-minute timeout with grace-kill (15s after `result` event → SIGTERM → SIGKILL)
   - Captures 4 files per run:
     - `results/<runId>.stdout.txt` — human-readable audit output
     - `results/<runId>.meta.json` — run metadata (timing, exit code, versions)
     - `results/<runId>.events.jsonl` — raw stream-JSON events (tool calls, agent spawns)
     - `results/<runId>.stderr.txt` — stderr diagnostics
4. Post-run verification (verify.ts): 12 automated checks per run
5. Cleans up all workspaces after suite completes

## Commands

```bash
# IMPORTANT: Running without filters runs the FULL matrix (all codebases x all conditions).
# Always use filters during development/testing.

# Quick single test
npm run bench -- --codebases canary --conditions skill_v2 --runs 1

# Compare all conditions on one codebase
npm run bench -- --codebases canary --runs 1

# Parallel run (conditions concurrently, iterations sequential)
npm run bench -- --codebases merkl --runs 1 --parallel

# Single condition across all codebases
npm run bench -- --conditions bare_audit --runs 1

# Multiple iterations for consistency testing
npm run bench -- --codebases canary --runs 3

# Full matrix (expensive — all codebases x all conditions x 1 run)
npm run bench

# Dry run (shows what would run, no claude spawned)
npm run bench:dry

# Generate summary report (latest run per condition)
npm run summary:last-run

# Generate summary report (all runs — shows consistency across iterations)
npm run summary:all-runs

# Build TypeScript
npm run build
```

### Available filters

- `--codebases <id>` — filter to specific codebase(s): `canary`, `merkl`, `brix`, `ekubo`, `megapot`, `panoptic`
- `--conditions <id>` — filter to specific condition(s): `bare_audit`, `skill_v1_default`, `skill_v1_deep`, `skill_v2`
- `--runs <N>` — override number of iterations per condition (default: 1)
- `--model <model>` — override Claude model
- `--dry-run` — preview without spawning claude
- `--parallel` — run all conditions concurrently per iteration

### Conditions explained

| Condition | What it does |
|---|---|
| `bare_audit` | Raw Claude with a security audit prompt, no skills, no user config |
| `skill_v1_default` | V1 skill, 4 vector-scan agents (Sonnet) |
| `skill_v1_deep` | V1 skill, 4 vector-scan agents (Sonnet) + 1 adversarial agent (Opus) |
| `skill_v2` | V2 skill, 5 agents + fp-gate validation agent (no deep mode — always full) |

## Verification

Every run is verified automatically by `src/verify.ts` with 12 checks:

- **Process**: exit code (0 or 143), timeout detection, event stream non-empty, result event present
- **Skill runs**: agent spawn count (V1 ≥4, V2 ≥5), all agents returned, no agent errors, result quality (≥10 lines), bundle quality
- **Bare runs**: no skill contamination (skill not in init event's slash_commands)
- **Scope**: out-of-scope contracts not in findings, in-scope files were read
- **Diagnostics**: tool errors collected, session restarts detected

## Parser

`src/parser.ts` extracts findings from audit output in multiple formats:

- **Skill format**: `[confidence] **N. Title**` with `` `Contract.function` · Confidence: N ``
- **Bare formats**: `### [SEVERITY] Title`, `### H-1: Title`, `### [H-1] Title`, `### N. Title — **SEVERITY**`

Each finding gets a location (`Contract.function`), vulnerability classification, and root-cause key for cross-run comparison.

## Summary Report

`npm run summary:last-run` / `npm run summary:all-runs` generates `summary.md` with:

- Overview table (all runs with findings count, duration, cost)
- Per-codebase sections with ASCII bar charts for recall, false positives, and duration
- Findings matrix showing which ground truth findings each condition caught
- Only uses the latest run per (codebase, condition) — older runs ignored
- Fuzzy matching against ground truth using location (contract + function) and title keyword overlap

## Adding a Skill Version

1. Copy `solidity-auditor/` dir from the skills repo at the target commit into `skills_versions/<version>/solidity-auditor/`
2. Create `skills_versions/<version>/source.json` with `{ repo, commit, tag, snapshotDate }`
3. Add a condition in `config/bench.json` referencing the version

## Adding a Codebase

1. Add as git submodule: `git submodule add <repo-url> datasets/<id>`
2. Add entry to `config/bench.json` codebases array
3. (Optional) Add `datasets/<id>/scope.txt` and `datasets/<id>/out_of_scope.txt`
4. (Optional) Add ground truth: `ground_truth/<id>.json`

## Ground Truth

Files in `ground_truth/<codebaseId>.json` define known bugs from official C4 audit reports. When present, the summary adds:

- **Recall**: how many real bugs each condition found (with ASCII bar chart)
- **False Positives**: findings that don't match any ground truth entry
- **Findings Matrix**: per-GT-finding table showing which conditions caught it
- **Missed by all**: GT findings no condition found

Ground truth files are at the project root — invisible to Claude during runs. Official reports are in `ground_truth/reports/`.

## Isolation & Contamination Prevention

Multi-layered isolation prevents cross-condition contamination:

- **Workspace**: real file copies per (codebase, conditionId) — not symlinks
- **CLAUDE.md blocker**: workspace-level file prevents parent directory walk-up
- **Env vars**: `CLAUDE_CODE*` and `CLAUDECODE` stripped from child process
- **Setting sources**: `--setting-sources project,local` excludes user-level settings
- **Bare hardening**: `--disable-slash-commands` + `--disallowedTools Skill` (double lock)
- **/tmp isolation**: skill temp paths rewritten per condition to prevent parallel collisions
- **Canary strings**: injected into skill SKILL.md for contamination detection
- **VERSION verification**: installed skill version checked before each run

See [docs/isolation-and-contamination-prevention.md](docs/isolation-and-contamination-prevention.md) for full documentation of all 11 defense layers, risk matrix, and known gaps.

## Critical: Env Var Isolation

When spawning `claude` from Node, the runner strips all `CLAUDE_CODE*` and `CLAUDECODE` env vars. Without this, `CLAUDE_CODE_SSE_PORT` makes the spawned process hang waiting for an IDE SSE connection.
