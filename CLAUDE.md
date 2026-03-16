# CLAUDE.md — Benchmark Runner

## What This Is

CLI tool that benchmarks the `solidity-auditor` Claude Code skill (from [pashov/skills](https://github.com/pashov/skills)) against a bare Claude baseline. Runs multiple iterations of each condition against real Solidity codebases, captures raw output, verifies execution integrity, and generates comparison reports with recall/FP scoring against ground truth.

## Setup Requirements

- Node 20+
- `claude` CLI installed (all LLM calls use the CLI binary via `child_process.spawn` — no Anthropic SDK)
- **Exclude `results/` and `workspaces/` from cloud sync** (Dropbox, iCloud, OneDrive). File sync during benchmark writes causes data corruption — see [C2 root cause in rewrite plan](docs/classifier-rewrite-plan.md). Run `npm run setup` to create `.nosync` markers.

## Quickstart

```bash
# 0. First-time setup (creates .nosync markers for sync protection)
npm run setup

# 1. Run benchmark
npm run bench -- --codebases merkl-stripped --runs 3 --parallel

# 2. Analyze results (classify → cluster → validate → report)
npm run analyze

# 3. Read the results
cat summary.md

# 4. Management dashboard (optional, no LLM calls)
npm run dashboard
open dashboard.html
```

## Project Structure

```
src/
  shared/           Types, parser, utilities — shared across all modules
    types.ts        Central type definitions
    report-data.ts  Shared data feed (ReportData) — single source of truth for all renderers
    parser.ts       Finding extraction from raw audit output
    util/           Logger, shell helpers
  runner/           Benchmark execution — spawns claude, captures output
    cli.ts          CLI entrypoint (npm run bench)
    config.ts       Config loader (bench.json)
    runner.ts       Main benchmark loop
    workspace.ts    Workspace creation (real copies per condition)
    skill.ts        Skill version management
    verify.ts       Post-run verification (12 checks)
  classifier/       Analysis pipeline — independent from runner
    llm.ts          Shared LLM call utility (spawn, JSON parse, Zod validate)
    classify.ts     GT classification with configurable Nx majority vote
    cluster.ts      Novel finding clustering (single LLM call per codebase)
    validate.ts     Novel validation against scoped source code
    pipeline.ts     Orchestrator: classify → cluster → validate
    pipeline-cli.ts CLI entrypoint (npm run analyze)
  reports/          Report generation — consumes shared data feed
    report.ts       Markdown renderer (deterministic tables + LLM narrative)
    report-cli.ts   CLI entrypoint (npm run report)
  dashboard/        Management HTML dashboard — consumes same shared data feed
    render.ts       HTML renderer (npm run dashboard)
config/             JSON benchmark configs (bench.json)
datasets/           Solidity codebases to audit (submodules + canary inline)
skills_versions/    Pinned skill snapshots (v1/, v2/, each with source.json provenance)
workspaces/         Ephemeral real-copy workspaces (gitignored, auto-cleaned)
results/            Run outputs + report-data.json shared feed (gitignored)
ground_truth/       Known-bug answer keys per codebase (JSON, enables Recall/FP scoring)
ground_truth/reports/  Official C4 audit reports (markdown)
docs/               Isolation strategy, benchmark prompt template, rewrite plan
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
   - Captures 4 files per run
4. Post-run verification: 12 automated checks per run
5. Cleans up all workspaces after suite completes

**Invalid run detection**: Skill runs that exit 0 but produce 0 findings or <500 chars stdout are marked `INVALID` and excluded from report averages. This catches corrupt runs (e.g., cloud sync inode detachment).

## Commands

```bash
# Quick single test
npm run bench -- --codebases canary --conditions skill_v2 --runs 1

# Parallel run
npm run bench -- --codebases merkl-stripped --runs 3 --parallel

# Dry run
npm run bench:dry

# Full analysis pipeline (classify → cluster → validate → report)
npm run analyze

# Skip Opus validation (faster/cheaper)
npm run analyze -- --no-validate

# Skip report generation
npm run analyze -- --no-report

# Force re-run everything (ignore cache)
npm run analyze -- --force

# Only latest run per condition in report
npm run analyze -- --latest

# Standalone report generation
npm run report
npm run report:latest

# Management dashboard (HTML, no LLM calls)
npm run dashboard
npm run dashboard -- --codebases merkl-stripped
npm run dashboard -- --codebases merkl-stripped,nft-dealers

# Build TypeScript
npm run build

# First-time setup (sync protection markers)
npm run setup
```

### Bench filters

- `--codebases <id>` — filter to specific codebase(s): `canary`, `merkl`, `merkl-stripped`, `brix`, `ekubo`, `megapot`, `panoptic`, `nft-dealers`
- `--conditions <id>` — filter to specific condition(s): `bare_audit`, `skill_v1_default`, `skill_v1_deep`, `skill_v2`
- `--runs <N>` — override number of iterations per condition (default: 1)
- `--model <model>` — override Claude model
- `--dry-run` — preview without spawning claude
- `--parallel` — run all codebase × condition pairs concurrently per iteration

### Conditions explained

| Condition | What it does |
|---|---|
| `bare_audit` | Raw Claude with a security audit prompt, no skills, no user config |
| `skill_v1_default` | V1 skill, 4 vector-scan agents (Sonnet) |
| `skill_v1_deep` | V1 skill, 4 vector-scan agents (Sonnet) + 1 adversarial agent (Opus) |
| `skill_v2` | V2 skill, 5 agents + fp-gate validation agent (no deep mode — always full) |

## Classification Pipeline

The analysis pipeline (`npm run analyze`) runs 3 steps:

### Step 1: Classify (with GT only)
- For each finding, calls Sonnet with the same classification prompt — configurable Nx vote via `CLASSIFY_VOTES` (default 1 for fast iteration, use 3 for production reliability)
- Takes majority vote: 3/3 = high confidence, 2/3 = medium, no majority = uncertain
- `uncertain` findings are preserved (not defaulted to FP) and flow into clustering
- Categories: `matched`, `novel`, `fp`, `uncertain`
- Deduplicates GT matches (highest agreement wins)
- Cached by `sha256(gtContent + stdoutContent + promptTemplate)` — prompt changes auto-invalidate cache

### Step 2: Cluster
- Groups novel + uncertain findings (GT mode) or ALL findings (no-GT mode) by root cause
- Single Sonnet call per codebase
- Content-based cluster IDs for stability
- Maps clusters to relevant source files for scoped validation

### Step 3: Validate
- Per cluster: Opus examines **scoped** source code (only files referenced by finding locations)
- Falls back to scope.txt, then all .sol files
- Three verdicts: confirmed, plausible, rejected
- Risk categorization: each confirmed/plausible finding tagged with `riskCategory` (`centralization-risk`, `informational`, or absent for real vulnerabilities)
- Dashboard and report can filter by risk category — data is preserved, display is filtered

### Report
- Management comparison table (one column per condition)
- Missed GT findings section (bugs missed by ALL conditions — prominent, not buried)
- Findings ledger (GT matches, confirmed novels, plausible, FP, rejected)
- 1 LLM narrative with deterministic number verification
- Data appendix (recall charts, classification breakdown, findings matrix, consistency)

## Reading the Report

The generated `summary.md` uses specific notation:

| Notation | Meaning |
|----------|---------|
| `✓` | Finding detected in all runs of that condition |
| `✓#N` | Finding detected only in run N (not consistent) |
| `✓#1#2` | Finding detected in runs 1 and 2 but not others |
| `~~rejected~~` | Opus validation rejected the finding as not a real bug |
| `INVALID` | Run excluded from averages (0 findings from skill, likely corrupt) |

**Agreement labels** in classification data: `1/1` = single vote, `2/3` = majority of 3 votes, `3/3` = unanimous, `no-majority` = uncertain (no consensus across 3 votes).

## Verification

Every run is verified automatically by `src/runner/verify.ts` with 12 checks:

- **Process**: exit code (0 or 143), timeout detection, event stream non-empty, result event present
- **Skill runs**: agent spawn count (V1 ≥4, V2 ≥5), all agents returned, no agent errors, result quality (≥10 lines), bundle quality
- **Bare runs**: no skill contamination (skill not in init event's slash_commands)
- **Scope**: out-of-scope contracts not in findings, in-scope files were read
- **Diagnostics**: tool errors collected, session restarts detected

## Parser

`src/shared/parser.ts` extracts findings from audit output in multiple formats:

- **Skill format**: `[confidence] **N. Title**` with `` `Contract.function` · Confidence: N ``
- **Bare formats**: `### [SEVERITY] Title`, `### H-1: Title`, `### [H-1] Title`, `### N. Title — **SEVERITY**`

Each finding gets a location (`Contract.function`), vulnerability classification, and root-cause key for cross-run comparison.

When the regex parser misses findings (detected via `extractUnmatchedBlocks`), an LLM fallback call recovers them during classification.

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

Files in `ground_truth/<codebaseId>.json` define known bugs from official C4 audit reports. When present, the analysis adds recall, precision, findings matrix, and missed-by-all counts. Official reports are in `ground_truth/reports/`.

## Environment Variables

| Variable | Default | Used by |
|---|---|---|
| `CLASSIFIER_MODEL` | `claude-sonnet-4-20250514` | Finding classifier |
| `CLUSTER_MODEL` | `claude-sonnet-4-20250514` | Novel finding clusterer |
| `VALIDATOR_MODEL` | `claude-opus-4-6` | Novel finding validator |
| `ANALYST_MODEL` | `claude-sonnet-4-20250514` | Report narrative generator |
| `CLASSIFY_VOTES` | `1` | Votes per finding (1=fast, 3=reliable production) |
| `BENCH_TIMEOUT_MS` | `600000` | Runner process timeout |
| `CLASSIFY_CONCURRENCY` | `10` | Parallel classifier workers |
| `VALIDATE_CONCURRENCY` | `3` | Parallel validator workers |
| `CLUSTER_TIMEOUT_MS` | `180000` | Clustering timeout |
| `VALIDATOR_TIMEOUT_MS` | `180000` | Validation timeout |
| `ANALYST_TIMEOUT_MS` | `300000` | Analyst timeout |
| `LLM_RETRY_DELAY_MS` | `5000` | Delay between retries on transient failure |

## Isolation & Contamination Prevention

Multi-layered isolation prevents cross-condition contamination:

- **Workspace**: real file copies per (codebase, conditionId) — not symlinks
- **CLAUDE.md blocker**: workspace-level file prevents parent directory walk-up
- **Env vars**: `CLAUDE_CODE*` and `CLAUDECODE` stripped from child process (without this, `CLAUDE_CODE_SSE_PORT` makes spawned processes hang waiting for an IDE SSE connection)
- **Setting sources**: `--setting-sources project,local` excludes user-level settings
- **Bare hardening**: `--disable-slash-commands` + `--disallowedTools Skill` (double lock)
- **Canary strings**: injected into skill SKILL.md for contamination detection
- **VERSION verification**: installed skill version checked before each run

See [docs/isolation-and-contamination-prevention.md](docs/isolation-and-contamination-prevention.md) for full documentation.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Truncated/corrupt results files | Cloud sync (Dropbox, iCloud) renames files mid-write | Exclude `results/` and `workspaces/` from sync; run `npm run setup` |
| V2 timeouts on large codebases | Too many .sol files (e.g., panoptic has 92) | Reduce scope with `scope.txt` or increase `BENCH_TIMEOUT_MS` |
| Spawned `claude` process hangs | `CLAUDE_CODE_SSE_PORT` env var leaking to child | Env var stripping in runner handles this automatically |
| Empty LLM responses in pipeline | Transient CLI failures (~40% on some prompts) | Retry logic with `LLM_RETRY_DELAY_MS` handles this; update `claude` CLI |
| Stale classification cache | Changed classification prompt | Cache auto-invalidates (prompt hash in cache key since Phase 7) |
| `INVALID` runs in report | Skill run exited 0 but produced 0 findings | Likely corrupt run; excluded from averages automatically |
