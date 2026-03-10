# CLAUDE.md — Benchmark Runner

## What This Is

CLI tool that benchmarks the `solidity-auditor` Claude Code skill (from [pashov/skills](https://github.com/pashov/skills)) against a bare Claude baseline. Runs multiple iterations of each condition against real Solidity codebases and captures raw output for comparison.

## Project Structure

```
src/                TypeScript source (cli, config, runner, workspace, skill, util/)
config/             JSON benchmark configs (bench.json)
datasets/           Solidity codebases to audit (git submodules)
skills_versions/    Pinned skill snapshots (v1/, v2/, each with source.json provenance)
workspaces/         Ephemeral per-run workspaces (gitignored)
results/            Run outputs: .stdout.txt + .meta.json per run (gitignored)
ground_truth/       Optional future reference findings
```

## How It Works

`npm run bench` runs the full matrix:

1. Loads config from `config/bench.json`
2. For each `(codebase, condition, iteration)`:
   - Copies codebase into `workspaces/<runId>/code/`
   - For skill conditions: installs skill into `workspaces/<runId>/.claude/commands/`
   - Spawns `claude -p "<prompt>"` in the workspace (fresh process each time)
   - Captures stdout to `results/<runId>.stdout.txt`
   - Writes metadata to `results/<runId>.meta.json`

## Commands

```bash
npm run bench                                          # Full matrix
npm run bench -- --runs 1                              # Single iteration
npm run bench -- --conditions bare_audit --runs 1      # Single condition
npm run bench -- --codebases abc --runs 1         # Single codebase
npm run bench:dry                                      # Dry run (no claude spawned)
npm run build                                          # Compile TypeScript
```

## Adding a Skill Version

1. Copy `solidity-auditor/` dir from the skills repo at the target commit into `skills_versions/<version>/solidity-auditor/`
2. Create `skills_versions/<version>/source.json` with `{ repo, commit, tag, snapshotDate }`
3. Add a condition in `config/bench.json` referencing the version

## Adding a Codebase

1. Add as git submodule: `git submodule add <repo-url> datasets/<id>`
2. Add entry to `config/bench.json` codebases array

## Critical: Env Var Isolation

When spawning `claude` from Node, the runner strips all `CLAUDE_CODE*` and `CLAUDECODE` env vars. Without this, `CLAUDE_CODE_SSE_PORT` makes the spawned process hang waiting for an IDE SSE connection.
