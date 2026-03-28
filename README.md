# Solidity Auditor Pulse

A benchmark harness that measures how well [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skills perform at smart-contract security auditing. Feed in audit skills and Solidity codebases, get a structured comparison report with recall scoring against known vulnerabilities.

## What It Does

```
Skills (v1, v2, ...)  +  Codebases (Solidity repos)
            │                        │
            └────────┬───────────────┘
                     ▼
              Benchmark Runner
         (isolated workspaces, parallel runs,
          stream capture, auto-retries)
                     │
                     ▼
            Analysis Pipeline
         (LLM classification, clustering,
          Opus validation, ground truth scoring)
                     │
              ┌──────┴───────┐
              ▼              ▼
        summary.md     dashboard.html
      (full report)   (management view)
```

**Input**: Any Claude Code audit skill + any Solidity codebase.
**Output**: Recall/precision metrics, findings matrix, missed-bug analysis, confirmed novel discoveries.

## Why This Exists

Running an LLM auditor once tells you nothing. You need:

- **Multiple runs** to measure consistency (does it find the same bugs every time?)
- **Multiple skills** side-by-side to know which approach actually works
- **Ground truth** scoring to separate real recall from noise
- **Isolation** so results aren't contaminated by environment leaks

This tool automates all of that.

## Key Features

| Feature | What It Means |
|---------|---------------|
| **Workspace isolation** | Each (codebase, condition) gets its own real-copy workspace. No symlinks, no shared state, no parent directory walk-up. [Details](docs/isolation-and-contamination-prevention.md) |
| **Contamination prevention** | 11 defense layers: env var stripping, setting source lockdown, CLAUDE.md blockers, bare-run hardening, canary strings, version verification |
| **Stream capture** | Every run captures stdout, stderr, event stream (JSON-L), and metadata. Full provenance chain. |
| **Auto-retries** | Transient LLM failures handled automatically across the analysis pipeline |
| **Ground truth scoring** | When known bugs exist (from C4/CodeHawks reports), calculates recall, precision, and missed-by-all counts |
| **Skill provenance** | Skills are pinned snapshots with `source.json` tracking repo, commit, and snapshot date |
| **Parallel execution** | Run all conditions concurrently per iteration with `--parallel` |
| **Multi-stage analysis** | Classify findings against GT, cluster novel discoveries, validate with Opus against scoped source code |
| **Deterministic reporting** | Tables and metrics are code-generated. Only the narrative summary uses an LLM call. |
| **Archival** | Results archived with `MANIFEST.json` provenance for reproducibility |

## Built for Claude Code

This is a Claude Code project. The entire benchmark orchestration uses `claude -p` (the Claude CLI) via `child_process.spawn` — no Anthropic SDK, no API keys in config. The isolation strategy is specifically designed around Claude Code's workspace mechanics: CLAUDE.md walk-up prevention, `--setting-sources` lockdown, `--disable-slash-commands` for bare runs, and env var stripping to prevent `CLAUDE_CODE_SSE_PORT` hangs.

## Quick Start

```bash
# Prerequisites: Node 20+, claude CLI installed

# Clone with submodules (datasets are git submodules)
git clone --recurse-submodules <repo-url>
cd solidity-auditor-pulse

# Install dependencies
npm install

# First-time setup (creates sync protection markers)
npm run setup

# Run a benchmark (canary = small test codebase)
npm run bench -- --codebases canary --runs 1

# Run full analysis pipeline (classify + cluster + validate + report)
npm run analyze

# View results
cat summary.md

# Management dashboard (HTML, no LLM calls)
npm run dashboard
open dashboard.html
```

## Benchmark Conditions

The runner supports multiple conditions, each representing a different audit approach:

| Condition | Description |
|-----------|-------------|
| `bare_audit` | Raw Claude with a security audit prompt. No skill, no user config. The baseline. |
| `pashov` | Pashov's solidity-auditor skill — multi-agent with vector-scan + adversarial |
| `darknavy` | DarkNavy's contract-auditor skill — 4 hunt agents + adversarial validation |

Conditions are config-driven. Add/remove skills with `npm run add-skill` / `npm run remove-skill`.

## Commands

```bash
# Benchmark
npm run bench -- --codebases merkl-stripped --runs 3 --parallel
npm run bench:dry                                    # Preview without running

# Analysis
npm run analyze                                      # Full pipeline
npm run analyze -- --no-validate                     # Skip Opus validation (cheaper)
npm run analyze -- --force                           # Ignore cache, re-run everything
npm run analyze -- --latest                          # Only latest run per condition

# Reports
npm run report                                       # Standalone report generation
npm run dashboard                                    # HTML management dashboard

# Skill management
npm run add-skill -- --name my-skill --repo <github-url> --path <skill-dir>
npm run remove-skill -- --name my-skill

# Archive
npm run archive                                      # Move results to archive with manifest
npm run archive:dry                                  # Preview

# Dev
npm run build                                        # Build TypeScript
npm run test                                         # Run test suite (271 tests)
```

## Project Structure

```
src/
  shared/           Types, parser, utilities
  runner/           Benchmark execution (spawns claude, captures output)
  classifier/       Analysis pipeline (classify, cluster, validate)
  reports/          Markdown report generation
  dashboard/        HTML dashboard generation
  archive/          Result archival with provenance

config/             Benchmark configuration (bench.json)
datasets/           Solidity codebases (git submodules + inline canary)
skills_versions/    Pinned skill snapshots with provenance tracking
ground_truth/       Known-bug answer keys per codebase (from C4/CodeHawks reports)
docs/               Technical documentation (isolation strategy, pipeline flows)
tests/              Test suite (Vitest, 266 tests)
```

## Analysis Pipeline

After benchmark runs complete, `npm run analyze` processes results in 3 stages:

1. **Classify** — Each finding is classified against ground truth using Sonnet with configurable N-vote majority (1 vote for fast iteration, 3 for production). Categories: `matched`, `novel`, `fp`, `uncertain`.

2. **Cluster** — Novel and uncertain findings are grouped by root cause. Incremental clustering keeps existing clusters stable as new runs are added.

3. **Validate** — Opus examines scoped source code for each cluster. Verdicts: `confirmed`, `plausible`, `rejected`. Risk categorization separates real vulnerabilities from centralization risks and informational findings.

The report combines deterministic tables (recall, precision, findings matrix, consistency) with a single LLM-generated narrative summary.

## Adding a Skill

```bash
npm run add-skill -- --name pashov --repo https://github.com/pashov/skills --path solidity-auditor
npm run add-skill -- --name darknavy --repo https://github.com/DarkNavySecurity/web3-skills --path contract-auditor --commit abc123
```

This clones the skill, creates `skills_versions/<name>/` with provenance tracking (`source.json`), and adds a condition to `config/bench.json`. Use `npm run remove-skill -- --name <name>` to reverse.

## Adding a Codebase

1. `git submodule add <repo-url> datasets/<id>`
2. Add entry to `config/bench.json`
3. (Optional) Add `datasets/<id>/scope.txt` and `ground_truth/<id>.json`

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLASSIFIER_MODEL` | `claude-sonnet-4-20250514` | Finding classifier model |
| `CLUSTER_MODEL` | `claude-sonnet-4-20250514` | Novel finding clusterer |
| `VALIDATOR_MODEL` | `claude-opus-4-6` | Finding validator (examines source) |
| `CLASSIFY_VOTES` | `1` | Votes per finding (1=fast, 3=production) |
| `BENCH_TIMEOUT_MS` | `600000` | Runner process timeout (10 min) |

See [CLAUDE.md](CLAUDE.md) for the full environment variable reference and deep technical documentation.

## Documentation

| Document | Description |
|----------|-------------|
| [CLAUDE.md](CLAUDE.md) | Complete technical reference (architecture, troubleshooting, verification checks) |
| [Isolation Strategy](docs/isolation-and-contamination-prevention.md) | 11 contamination risks and defense layers |
| [Pipeline Flows](docs/pipeline-flows.md) | Visual flowcharts and per-step documentation of the analysis pipeline |
| [Architecture](docs/classifier-rewrite-plan.md) | Design decisions and module structure |
| [Platform Limitations](docs/persisted-output-trap.md) | Known Claude Code platform interactions affecting large codebases |

## License

[MIT](LICENSE)
