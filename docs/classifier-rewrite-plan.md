# Classifier & Reports Rewrite Plan

## Problem Statement

The current classification pipeline (in stash) has 11 processing stages, 8 LLM call sites, 4 duplicated utility functions, and multiple stages that add noise without proven value (adversarial verification, retry-to-FP, fuzzy reconciliation, LLM fact-checking, LLM miss analysis). The complexity creates too many opportunities for silent misclassification.

**Goal**: A simpler, more robust pipeline that produces deterministic, reproducible results from the same input findings, minimizes misclassification risk, and supports both GT-calibrated and no-GT workflows.

## Design Principles

1. **Fewer LLM calls = fewer failure points.** Every LLM call is a coin flip on correctness.
2. **Majority vote > adversarial verification.** Configurable 1-3x classify with consensus.
3. **Conservative defaults.** Ambiguous findings marked `uncertain`, not silently demoted to FP.
4. **Deterministic when possible.** Metrics, tables, number validation — never use an LLM when code can do it.
5. **GT and no-GT are first-class paths.** The no-GT path is the future primary use case.
6. **Module independence.** `classifier/` shares nothing with `runner/` except types.

## Architecture

```
src/
  shared/              ← Types, parser, utilities (shared across all modules)
    types.ts           ← Simplified classification types (agreement as string, no overrides)
    parser.ts          ← Regex parser + LLM recovery for unmatched blocks
    util/logger.ts
    util/shell.ts

  runner/              ← Benchmark execution (fully independent from classifier)
    cli.ts, config.ts, runner.ts, workspace.ts, skill.ts, verify.ts

  classifier/          ← Analysis pipeline (6 files)
    llm.ts             ← Shared LLM utility: spawn, JSON parse, Zod validate, retry with delay
    classify.ts        ← GT classification with configurable vote count (default 1)
    cluster.ts         ← Finding clustering by root cause (single LLM call per codebase)
    validate.ts        ← Cluster validation with scoped source code (Opus)
    pipeline.ts        ← Orchestrator: classify → cluster → validate
    pipeline-cli.ts    ← CLI entrypoint (npm run analyze)

  reports/             ← Report generation (2 files)
    report.ts          ← Management report: deterministic tables + LLM narrative + integrity check
    report-cli.ts      ← CLI entrypoint (npm run report)
```

## Data Flow

### Flow 1: With Ground Truth (calibration codebases)

```
  results/<runId>.stdout.txt + .meta.json
  ground_truth/<codebase>.json
                    │
        ┌───────────▼───────────┐
        │  PARSE                │  existing regex parser (no changes)
        │  → ParsedFinding[]    │  0-1 LLM calls (recovery fallback)
        └───────────┬───────────┘
                    │
        ┌───────────▼───────────┐
        │  CLASSIFY (Nx vote)   │  For each finding: Sonnet × CLASSIFY_VOTES (default 1)
        │                       │  1/1 = single vote | 2/3+ = majority | else = uncertain
        │  → classifications    │  Then: dedup GT matches (highest agreement wins)
        │    .json per run      │  Failed votes return null (excluded, not counted as FP)
        │                       │  Retry with 5s delay on empty CLI response
        └───────────┬───────────┘
                    │
        ┌───────────▼───────────┐
        │  CLUSTER novels       │  Group novel + uncertain findings by root cause
        │  → clusters.json      │  1 Sonnet call per codebase (retry x3)
        └───────────┬───────────┘
                    │
        ┌───────────▼───────────┐
        │  VALIDATE clusters    │  Per cluster: Opus examines SCOPED source code
        │  → validations.json   │  (only files referenced by finding locations)
        │                       │  M Opus calls (M = cluster count)
        └───────────┬───────────┘
                    │
        ┌───────────▼───────────┐
        │  REPORT               │  Deterministic tables + 1 Sonnet narrative
        │  → summary.md         │  + deterministic number verification
        │                       │  + pipeline integrity check (findings count invariant)
        └───────────────────────┘
```

### Flow 2: Without Ground Truth (real-world codebases)

```
  results/<runId>.stdout.txt + .meta.json
  (no ground_truth file)
                    │
        ┌───────────▼───────────┐
        │  PARSE                │  same as GT flow
        └───────────┬───────────┘
                    │
        ┌───────────▼───────────┐
        │  CLUSTER all findings │  no classification — cluster everything
        │  → clusters.json      │  1 Sonnet call per codebase
        └───────────┬───────────┘
                    │
        ┌───────────▼───────────┐
        │  VALIDATE clusters    │  same as GT flow (optional)
        └───────────┬───────────┘
                    │
        ┌───────────▼───────────┐
        │  REPORT               │  no recall/precision — total findings,
        │  → summary.md         │  unique findings, cost, duration
        │                       │  disclaimer: "based on 1 Sonnet confirmation"
        └───────────────────────┘
```

## What Was Removed (and Why)

| Removed | Why |
|---------|-----|
| Opus verification pass | No data proving it improves accuracy. Adversarial design can flip correct matches to FP. |
| Retry-to-FP | Silently demotes ambiguous findings. Wrong default — security context should preserve, not discard. |
| Cross-condition reconciliation | 60% title word overlap is too loose. Causes false consensus. |
| LLM fact-checker | LLM checking another LLM against same data is theater. Replaced with deterministic number verification. |
| LLM miss analysis | Speculation without source code. Replaced with deterministic count. |
| Override CLI | Coupled to runId+findingIndex, orphaned on re-run. Fix the prompt instead. |
| Bounty report | Derivative of validation results. Folded into main report. |
| Compare CLI | Useful concept. Folded into report's consistency section. |

## Implementation Status

### Phase 1: Foundation — DONE
1. [x] Move existing files to `shared/` and `runner/` directories
2. [x] Update `src/shared/types.ts` — simplified classification types (agreement as string)
3. [x] Write `src/classifier/llm.ts` — shared LLM utility with Zod validation + retry + 5s delay
4. [x] Write `src/classifier/classify.ts` — configurable vote count (CLASSIFY_VOTES env, default 1)

### Phase 2: Clustering & Validation — DONE
5. [x] Write `src/classifier/cluster.ts` — novel clustering (tested: 47→24 bugs, 22→17 findings)
6. [x] Write `src/classifier/validate.ts` — scoped source validation (code written, not yet run with Opus)

### Phase 3: Pipeline & Report — DONE
7. [x] Write `src/classifier/pipeline.ts` + `pipeline-cli.ts`
8. [x] Write `src/reports/report.ts` + `report-cli.ts` — includes integrity check + no-GT support

### Phase 4: Cleanup — DONE
9. [x] Update `package.json` scripts (analyze, analyze:cheap, report, report:latest)
10. [x] Update `CLAUDE.md` — reflects new architecture
11. [x] Delete old source files (summary.ts, etc.)
12. [x] Enrich GT descriptions from official C4 reports (merkl-stripped)

### Phase 5: Bug Fixes from Testing — DONE
13. [x] Fix: failed LLM votes counted as FP → now return null, excluded from majority
14. [x] Fix: CLASSIFY_VOTES configurable (env var, default 1 for fast iteration)
15. [x] Add: Pipeline integrity check (findings count invariant in report)
16. [x] Archive old classifications for comparison (results/archive-3vote/)
17. [x] Fix: agreement label shows actual vote count (1/1, 2/3, 3/3) not misleading 3/3
18. [x] Fix: empty CLI response detection + retry with 5s backoff delay in llm.ts
19. [x] Fix: report displays "unique findings" (not "bugs") for no-GT codebases

### Phase 6: Dry-Run Validation — DONE
20. [x] Generate report WITHOUT validation — report structure, tables, narrative verified
21. [x] Verify no-GT flow with nft-dealers (parse → cluster → report, no classification)
22. [x] Review report output: comparison tables correct, integrity passes, numbers verified
23. [x] Spot-check classifications (3 cases: correct match, missed match bug found, correct FP)
24. [x] Provable 1-vote vs 3-vote comparison: 94% stable, 6% genuine instability

### Phase 7: Critical Quality Fixes — DONE
25. [x] C1: Add prompt hash to classification cache key
26. [x] C2: Invalid run detection (0-finding skill runs marked invalid, excluded from averages)
27. [x] C3: Pre-flight validation in pipeline.ts (fail fast on corrupt/missing files before LLM calls)
28. [x] I1: Add "Missed GT Findings" section to report (prominent, between comparison table and ledger)
29. [x] I3: Skipped — low value after C2 (invalid run detection) already protects report. Root cause fix is excluding results/ from sync.
30. [x] Findings Ledger redesign: per-condition columns with ✓#N notation, no severity, no "(missed)" labels
31. [x] Appendix sorting: grouped by condition, sequential run numbers (not meta.iteration)
32. [x] File scoping: Sonnet maps clusters to relevant source files during clustering, Opus gets scoped source

### Phase 8: Validation Testing — DONE
33. [x] Full pipeline run with --force: 66 classifications + 2 clusters + 38 Opus validations + report
34. [x] Scoping verified: 38/38 clusters had Sonnet-assigned relevantFiles, 0 fallbacks
35. [x] merkl-stripped: 7 confirmed, 3 plausible, 11 rejected (21 clusters)
36. [x] nft-dealers: 11 confirmed, 1 plausible, 5 rejected (17 clusters)
37. [x] Report renders validation verdicts correctly (confirmed/plausible/~~rejected~~/FP)

### Phase 9: Documentation Sync & Results Protection — DONE

> **Goal**: CLAUDE.md matches reality, results files are protected from external corruption, team can onboard from repo alone.

38. [x] Fix CLAUDE.md ↔ code discrepancies:
    - Classification section: "3 times" → "configurable Nx vote (default 1, use 3 for production)"
    - Cache key: updated to show all 3 components (gt + stdout + promptTemplate)
    - Added env vars: `CLASSIFY_VOTES`, `LLM_RETRY_DELAY_MS`
    - Added: invalid run detection explanation
    - Merged "Critical: Env Var Isolation" into Isolation section
    - Moved "No Anthropic SDK" into Setup Requirements
39. [x] Add "Reading the Report" section to CLAUDE.md:
    - Notation table: `✓`, `✓#N`, `✓#1#2`, `~~rejected~~`, `INVALID`
    - Agreement labels: `1/1`, `2/3`, `3/3`, `no-majority`
40. [x] Add "Setup Requirements" section to CLAUDE.md:
    - Cloud sync exclusion warning with link to C2 root cause
    - Prerequisites: Node 20+, `claude` CLI, no SDK needed
41. [x] Add "Troubleshooting" section to CLAUDE.md:
    - 6 common issues with cause and fix
42. [x] Results file protection — OS-level:
    - `results/.nosync` and `workspaces/.nosync` created
    - `npm run setup` script added to package.json
    - `.gitignore` updated to track .nosync files
    - Documented in Setup Requirements and Troubleshooting

### Phase 10: Commit & Ship — NOT STARTED

> **Goal**: Clean commit of all Phase 1-9 work. Stable baseline before further enhancements.

43. [ ] Final build verification (`tsc` clean)
44. [ ] Git commit with all changes
45. [ ] Tag release: `v1.0.0` — first stable version of the rewritten pipeline

### Phase 11: Statistical Rigor — NOT STARTED

> **Goal**: Report doesn't overstate conclusions from small sample sizes. Numbers are honest.

46. [ ] Add confidence context to comparison table:
    - Show run count per condition (e.g., "Recall: 2/8 (25%) [n=3]")
    - When n < 5, add footnote: "Sample size too small for statistical significance"
    - Don't present point estimates as conclusive when n=2-3
47. [ ] Add variance/range to metrics where n > 1:
    - Recall: show range (e.g., "13-25%") alongside average
    - Cost: show min-max alongside average
    - Findings count: show range
    - Keep it compact — inline in existing table, not a new section
48. [ ] Invalid run auto-retry in runner:
    - When a skill run produces 0 findings and exit code 0, retry once automatically
    - Log: "Run <id> produced 0 findings, retrying (attempt 2/2)"
    - Keeps data complete without manual intervention
    - Cap at 1 retry to control cost

### Phase 12: Hardening & Cost Control — NOT STARTED

> **Goal**: Pipeline doesn't crash on bad data, cost of analysis is tracked and visible.

49. [ ] Defensive file reads — wrap all readFileSync/JSON.parse in classify.ts, cluster.ts, validate.ts, report.ts:
    - try/catch around every file read
    - On corrupt file: log warning with filename, skip that run/cluster, continue pipeline
    - Never crash the entire pipeline for one bad file
50. [ ] Pipeline cost tracking:
    - llm.ts: parse token counts from `claude` CLI stderr (if available) or estimate from prompt/response length
    - Pipeline summary at end: "Analysis cost: ~$X.XX (N classify calls + M cluster calls + K validate calls)"
    - Add to report footer: "Benchmark cost: $X.XX | Analysis cost: $Y.YY"
51. [ ] Narrative caching:
    - Cache generated narrative alongside validation files
    - Key: hash of all input data (classifications + clusters + validations + metrics)
    - Only regenerate with `--force` or when inputs change
    - Saves 1 Sonnet call per `npm run report` (matters when iterating on report format)
52. [ ] Classify timeout configurable:
    - Add `CLASSIFY_TIMEOUT_MS` env var (currently hardcoded at 120s in classify.ts)
    - Document in env var table

### Phase 13: Regression Safety — NOT STARTED

> **Goal**: Prompt changes don't silently degrade classification quality.

53. [ ] Golden file test suite:
    - Save 5-10 classification results as fixtures in `test/fixtures/golden/`
    - Each fixture: `{ input: { stdout, gt }, expected: { category, gtId? } }`
    - Pick cases covering: clear match, clear FP, novel, edge case, recovered finding
    - `npm run test:classify` re-classifies fixtures and diffs against expected
    - Acceptable drift threshold: 1/10 may differ (LLM non-determinism)
54. [ ] Parser regression tests:
    - Save 3-5 raw stdout samples covering each format (skill, bare-severity, bare-numbered, bare-bracketed)
    - `npm run test:parse` extracts findings and compares count + titles against expected
    - These are fully deterministic — 0 tolerance for drift
55. [ ] Add `npm run test` that runs both parse + classify tests

### Future Phases (backlog, not blocking v1.0)

These are tracked but not scheduled. Each delivers value independently.

**F1. Expand GT coverage** (high value, no code change)
- Add 2-3 more codebases with GT from C4 audit reports
- Priority: codebases where V1/V2 might perform differently than merkl-stripped
- More GT codebases = more credible comparative claims

**F2. `--with-report` validation** (medium value)
- Feed official C4 audit reports to Opus during novel validation
- Helps distinguish "real novel bug" from "known bug described differently"
- Already designed, needs implementation

**F3. Report module refactor** (medium value, improves maintainability)
- Split report.ts (1235 lines) into: metrics.ts, ledger.ts, narrative.ts, appendix.ts
- No functional change — pure refactor for testability
- Do this when report.ts needs its next feature addition

**F4. Claude CLI version pinning** (low value today, high value at scale)
- Record `claude --version` in run metadata
- Warn when runs in same comparison used different CLI versions
- Model version already tracked via events.jsonl

**F5. Intra-run deduplication** (low value)
- Detect when same bug is reported twice within a single run
- Currently inflates finding counts for verbose conditions (Bare CC)
- Low priority: clustering already handles cross-run dedup

## QA Assessment (2026-03-15)

### What's Solid

| Area | Status | Evidence |
|------|--------|----------|
| Findings integrity | Strong | Category sums = parsed counts in every run tested (66 findings, 13 runs) |
| Cache correctness | Strong | gtHash + stdoutHash invalidation works; --force overrides |
| Null-vote safety | Strong | Failed votes excluded from majority, not silently counted as FP |
| No-GT flow | Working | nft-dealers: parse → cluster → report generates correctly |
| GT flow | Working | merkl-stripped: classify → cluster → report with recall/precision |
| Report determinism | Working | Rerunning `npm run report` on same data produces same tables (narrative varies) |
| Retry resilience | Working | Empty CLI responses caught, retried with 5s delay, 3 retries for clustering |

### Known Risks (Honest)

| Risk | Severity | Mitigation | Status |
|------|----------|------------|--------|
| 1-vote instability | Medium | 6% of findings may classify differently across reruns. Use CLASSIFY_VOTES=3 for production. | Documented, configurable |
| CLI empty response | Medium | 40% failure rate on some prompts. Retry with delay handles it, but root cause is in CLI. | Mitigated with retry |
| L-01 match lost in 1-vote | Low | V1 matched L-01 with 3 votes but missed with 1. Single-vote limitation. | Accepted trade-off |
| Parser misses findings | Low | LLM recovery handles unmatched blocks, but recovery itself can fail | Existing from old pipeline |
| Clustering non-determinism | Low | Same findings may cluster differently across runs (LLM decides grouping) | Inherent to LLM clustering |

### Quality Gaps — Prioritized Recommendations

#### CRITICAL

| ID | Issue | Status | Phase |
|----|-------|--------|-------|
| C1 | Prompt hash not in cache key | **FIXED** (Phase 7) | — |
| C2 | Invalid/corrupt run detection | **FIXED** (Phase 7) — invalid runs excluded from averages | — |
| C2b | Results file corruption from cloud sync | **Root cause documented**, prevention in Phase 9 | 9 |
| C3 | Unhandled file read errors (20+ crash sites) | Open | 12 |

#### IMPORTANT

| ID | Issue | Status | Phase |
|----|-------|--------|-------|
| I1 | GT-miss summary not prominent | **FIXED** (Phase 7) | — |
| I2 | Validation code untested | **FIXED** (Phase 8) — 38 Opus validations completed | — |
| I3 | Conflicted events files not handled | Open — folded into results protection | 9 |
| I4 | CLAUDE.md stale (6 discrepancies found) | Open | 9 |
| I5 | No statistical context for small samples | Open | 11 |
| I6 | Classify timeout hardcoded (120s) | Open | 12 |

#### NICE TO HAVE

| ID | Issue | Status | Phase |
|----|-------|--------|-------|
| N1 | Regression test suite | Open | 13 |
| N2 | Pipeline cost tracking | Open | 12 |
| N3 | Report narrative caching | Open | 12 |
| N4 | `--with-report` flag for validation | Open | Future F2 |

#### C2 Root Cause Reference (kept for onboarding)

V1 Deep on nft-dealers: exit code 0, 0 findings, 756 chars stdout — corrupt run caused by cloud sync.

The primary events.jsonl was an exact 25-line prefix of the complete 74-line file. A file sync process renamed the actively-written events file mid-run (inode detachment). The runner's WriteStream continued writing to the renamed file while subsequent reads hit the truncated replacement.

**This is NOT a parallel execution bug** — each run has unique runId, separate workspace. It's an external process modifying files in `results/` during long-running writes. Prevention addressed in Phase 9 (OS-level markers + in-code detection).

## Persistent Data Files

All intermediate data persists in `results/` for reuse:

| File | Created by | Used by | Persists |
|------|-----------|---------|----------|
| `<runId>.stdout.txt` | bench | classify, report | Yes |
| `<runId>.meta.json` | bench | classify, cluster, report | Yes |
| `<runId>.events.jsonl` | bench | report (cost extraction) | Yes |
| `<runId>.classifications.json` | classify | cluster, report | Yes (cached by hash) |
| `clusters-<codebase>.json` | cluster | validate, report | Yes (stale-checked) |
| `validations-<codebase>.json` | validate | report | Yes (stale-checked) |
| `summary.md` | report | management | Overwritten on regenerate |

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLASSIFIER_MODEL` | `claude-sonnet-4-20250514` | Classification model |
| `CLUSTER_MODEL` | `claude-sonnet-4-20250514` | Clustering model |
| `VALIDATOR_MODEL` | `claude-opus-4-6` | Validation model |
| `ANALYST_MODEL` | `claude-sonnet-4-20250514` | Report narrative model |
| `CLASSIFY_VOTES` | `1` | Votes per finding (1=fast, 3=reliable) |
| `CLASSIFY_CONCURRENCY` | `10` | Parallel classification workers |
| `VALIDATE_CONCURRENCY` | `3` | Parallel validation workers |
| `CLUSTER_TIMEOUT_MS` | `180000` | Clustering call timeout |
| `VALIDATOR_TIMEOUT_MS` | `180000` | Validation call timeout |
| `ANALYST_TIMEOUT_MS` | `300000` | Report narrative timeout |
| `LLM_RETRY_DELAY_MS` | `5000` | Delay between retries on transient failure |

## CLI Commands

```bash
# Full pipeline: classify → cluster → (validate) → report
npm run analyze                    # default: no validation
npm run analyze -- --no-validate   # explicit: skip Opus validation
npm run analyze -- --no-report     # skip report generation
npm run analyze -- --force         # ignore all caches
npm run analyze -- --latest        # only latest run per condition in report

# Standalone report (uses cached classification + cluster data)
npm run report                     # all runs
npm run report:latest              # latest run per condition

# Production run (3 votes for reliability)
CLASSIFY_VOTES=3 npm run analyze
```

## Success Criteria

1. **Reproducibility**: Same input → same output — **ACHIEVED** (deterministic from cached votes)
2. **Recall parity**: majority-vote recall >= old pipeline — **ACHIEVED** (M-02 recovered from FP bug)
3. **<10% uncertain**: >90% definitive — **ACHIEVED** (3/66 = 4.5% uncertain)
4. **Integrity**: findings count invariant — **ACHIEVED** (all runs pass)
5. **No-GT works**: nft-dealers pipeline end-to-end — **ACHIEVED** (22→17 unique findings)
6. **Cost reduction**: fewer expensive calls — **PARTIALLY** (Opus validation not yet run to measure)
7. **Simplicity**: classifier/ has 6 files, ~800 lines — **ACHIEVED** (6 files, 870 lines)

## Future Enhancements

Tracked in Future Phases section (F1-F5) above. Not blocking v1.0.
