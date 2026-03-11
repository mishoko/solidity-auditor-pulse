# CLAUDE.md — Benchmark Runner

## What This Is

CLI tool that benchmarks the `solidity-auditor` Claude Code skill (from [pashov/skills](https://github.com/pashov/skills)) against a bare Claude baseline. Runs multiple iterations of each condition against real Solidity codebases and captures raw output for comparison.

## Project Structure

```
src/                TypeScript source (cli, config, runner, workspace, skill, util/)
config/             JSON benchmark configs (bench.json)
datasets/           Solidity codebases to audit (submodules + canary inline)
skills_versions/    Pinned skill snapshots (v1/, v2/, each with source.json provenance)
workspaces/         Ephemeral symlinked workspaces (gitignored, auto-cleaned)
results/            Run outputs: .stdout.txt + .meta.json per run (gitignored)
ground_truth/       Known-bug answer keys per codebase (JSON, enables Recall/FP scoring)
```

## How It Works

`npm run bench` runs the full matrix (all codebases x all conditions x N runs). **This is expensive** — prefer filtered runs during development.

1. ц `config/bench.json`
2. Prepares workspaces (one per codebase × condition):
   - Each condition gets its own workspace: `workspaces/<codebase>__<conditionId>/`
   - Codebase files are **real copies** (not symlinks) from `datasets/`
   - **Skill runs**: `.claude/commands/solidity-auditor/` installed with correct version
   - **Bare runs**: no skill installed, just the codebase copy
3. For each `(codebase, condition, iteration)`:
   - Spawns `claude -p "<prompt>"` in the resolved cwd (fresh process each time)
   - Bare runs add `--disable-slash-commands --setting-sources project,local`
   - Captures stdout to `results/<runId>.stdout.txt`
   - Writes metadata to `results/<runId>.meta.json`
4. Cleans up all workspaces after suite completes

## Commands

```bash
# IMPORTANT: Running without filters runs the FULL matrix (all codebases x all conditions).
# Always use filters during development/testing.

# Quick single test
npm run bench -- --codebases canary --conditions skill_v2 --runs 1

# Compare all conditions on one codebase
npm run bench -- --codebases canary --runs 1

# Single condition across all codebases
npm run bench -- --conditions bare_audit --runs 1

# Multiple iterations for consistency testing
npm run bench -- --codebases canary --runs 3

# Full matrix (expensive — all codebases x all conditions x 1 run)
npm run bench

# Dry run (shows what would run, no claude spawned)
npm run bench:dry

# Generate summary table from existing results
npm run summary:results

# Build TypeScript
npm run build
```

### Available filters

- `--codebases <id>` — filter to specific codebase(s): `canary`, `panoptic`, `ekubo`, `megapot`
- `--conditions <id>` — filter to specific condition(s): `bare_audit`, `skill_v1_default`, `skill_v1_deep`, `skill_v2`
- `--runs <N>` — override number of iterations per condition (default: 1)
- `--model <model>` — override Claude model
- `--dry-run` — preview without spawning claude
- `--parallel` — run all conditions concurrently per iteration (see Parallel Execution below)

### Conditions explained

| Condition | What it does |
|---|---|
| `bare_audit` | Raw Claude with a security audit prompt, no skills, no user config |
| `skill_v1_default` | V1 skill, 4 vector-scan agents (Sonnet) |
| `skill_v1_deep` | V1 skill, 4 vector-scan agents (Sonnet) + 1 adversarial agent (Opus) |
| `skill_v2` | V2 skill, 5 agents + fp-gate validation agent (no deep mode — always full) |

## Adding a Skill Version

1. Copy `solidity-auditor/` dir from the skills repo at the target commit into `skills_versions/<version>/solidity-auditor/`
2. Create `skills_versions/<version>/source.json` with `{ repo, commit, tag, snapshotDate }`
3. Add a condition in `config/bench.json` referencing the version

## Adding a Codebase

1. Add as git submodule: `git submodule add <repo-url> datasets/<id>`
2. Add entry to `config/bench.json` codebases array
3. (Optional) Add ground truth: `ground_truth/<id>.json`

## Ground Truth

Files in `ground_truth/<codebaseId>.json` define known bugs. When present, the summary table adds **Recall** (how many real bugs found) and **FPs** (false positives) rows, and marks FP findings with `(FP)`. Ground truth files are at the project root — invisible to Claude during runs.

## Parallel Execution

`--parallel` runs all conditions concurrently per iteration (~4x speedup). Iterations stay sequential. Rate limits may bite on large codebases — drop to sequential if throttled. See [docs/isolation-and-parallelism.md](docs/isolation-and-parallelism.md) for full isolation strategy, rate limit analysis, and design decisions.

```bash
npm run bench -- --codebases canary --runs 1 --parallel
```

## Critical: Env Var Isolation

When spawning `claude` from Node, the runner strips all `CLAUDE_CODE*` and `CLAUDECODE` env vars. Without this, `CLAUDE_CODE_SSE_PORT` makes the spawned process hang waiting for an IDE SSE connection.
