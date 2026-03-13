# Benchmark Plan: Parallel V1 + V2 + Bare CC

**Status: Remaining codebases ready to run**

## Phase Tracker

| Phase | Status | Notes |
|---|---|---|
| 0A. Flag verification | Done | All 5 flags confirmed working |
| 0B. --disallowedTools Skill | Done | Removes Skill tool from tools list entirely |
| 0C. 10-min timeout | Done | shell.ts: SIGTERM → SIGKILL after 10m, grace-kill at 15s post-result |
| 0D. Canary control strings | Done | Injected per-condition during workspace prep |
| 1. Stream-JSON monitoring | Done | .events.jsonl + text extraction to .stdout.txt |
| 2. /tmp/ collision fix | Done | Condition-scoped paths in SKILL.md copies |
| 3A. Add contest repos | Done | merkl (651 nSLOC), brix (1612), ekubo (6283), megapot (1709) |
| 3B. Sequential canary runs | Done | Each condition ran solo, all passed |
| 3C. Parallel canary (2 cond) | Done | v1 + bare verified |
| 3D. Parallel canary (3 cond) | Done | v1 + v2 + bare — all 3 conditions 4/4 recall, 0 FPs |
| 4. Real codebase (merkl) | Done | 3-condition parallel, V2 5m37s, V1 9m24s (grace-killed), bare 3m17s |
| 5. Verification & report | Done | verify.ts (12 checks) + summary.ts (ASCII bar charts, findings matrix) |
| 6. Ground truth / findings | Done | 6 codebases, 85 findings total, all verified against source code |
| 7. Parser robustness | Done | 4 bare output format patterns supported |
| 8. Isolation documentation | Done | docs/isolation-and-contamination-prevention.md |

---

## Scope

- **3 conditions**: `skill_v1_default`, `skill_v2`, `bare_audit` (v1_deep configured but excluded from default runs)
- **Time limit**: 10 minutes per run
- **Final output**: `summary.md` — 90 lines, ASCII bar charts, findings matrix

## Success Criteria Status

| Criterion | Status | Evidence |
|---|---|---|
| Parallel v1 + v2 + bare on real codebase | Done | merkl 3-condition parallel run completed |
| Skills not runnable by bare Claude | Done | `--disable-slash-commands` + `--disallowedTools Skill` + post-run verification |
| Sub-run & sub-agent 100% completion verification | Done | verify.ts: 12 automated checks per run (agents, bundles, scope, errors) |
| 100% verify all runs executed correctly | Done | Automated verification integrated into runner, runs after every benchmark |
| 1 Markdown ≤150 lines with graphical comparison | Done | summary.md at 90 lines with recall/FP/duration bar charts |

## Code Changes (Final)

| File | Change |
|---|---|
| `src/util/shell.ts` | Stream-JSON output, 10-min timeout, grace-kill, `--disallowedTools Skill`, env var stripping |
| `src/workspace.ts` | Real copies, per-condition isolation, `/tmp/` path rewriting, canary injection, CLAUDE.md walk-up blocker, VERSION verification |
| `src/types.ts` | Added `timedOut` field to RunMeta |
| `src/runner.ts` | Parallel execution, timeout logging, post-run verification, codebase path passing |
| `src/verify.ts` | 12-check verification: exit code, agents, bundles, scope compliance, contamination detection, tool errors |
| `src/parser.ts` | 4 bare output formats: `[SEVERITY]`, `H-1:`, `[H-1]`, `N. Title — **SEVERITY**` |
| `src/summary.ts` | Latest-run dedup, exitCode 143 support, fuzzy GT matching (location + keywords), ASCII bar charts |
| `config/bench.json` | All codebases + conditions configured |
| `ground_truth/*.json` | 6 files: canary (4), merkl (8), brix (9), ekubo (11), megapot (19), panoptic (34) |
| `ground_truth/reports/*.md` | Official C4 audit reports for all 5 real codebases |
| `docs/isolation-and-contamination-prevention.md` | 11 defense layers documented with risk matrix |
| `docs/benchmark-run-prompt.md` | Reusable prompt template for running benchmarks |

## Verified Flags

| Flag | Works | How verified |
|---|---|---|
| `--disable-slash-commands` | YES | `slash_commands: []` in stream-json init |
| `--setting-sources project,local` | YES | Blocks `~/.claude/commands/` from leaking |
| `--output-format stream-json --verbose` | YES | Full tool call + agent spawn visibility |
| `--dangerously-skip-permissions` | YES | `permissionMode: bypassPermissions` |
| `--disallowedTools Skill` | YES | `Skill` removed from tools list entirely |

## Benchmark Results (current)

### Canary (synthetic, 4 planted vulns)

| Condition | Recall | FPs | Duration | Cost |
|---|---|---|---|---|
| V2 | 4/4 (100%) | 0 | 3m38s | $0.99 |
| V1 | 4/4 (100%) | 0 | 2m14s | $0.71 |
| Bare CC | 4/4 (100%) | 0 | 23s | $0.10 |

### Merkl (real codebase, 651 nSLOC, 8 GT findings)

| Condition | Recall | FPs | Duration | Cost |
|---|---|---|---|---|
| V2 | 2/8 (25%) | 1 | 5m37s | $2.26 |
| V1 | 3/8 (38%) | 3 | 9m24s | $2.68 |
| Bare CC | 1/8 (13%) | 10 | 3m17s | $0.49 |

Key observation: V1 and V2 found **different** findings (no overlap). Skills significantly reduce FP noise vs bare.

## Datasets

| ID | Source | nSLOC | GT Findings | Run Status |
|---|---|---|---|---|
| canary | Inline synthetic | ~50 | 4 (0H, 0M, 0L) | Run complete |
| merkl | code-423n4/2025-11-merkl | 651 | 8 (0H, 3M, 5L) | Run complete |
| brix | code-423n4/2025-11-brix-money | 1,324 | 9 (0H, 3M, 6L) | Ready to run |
| ekubo | code-423n4/2025-11-ekubo | 6,283 | 11 (0H, 4M, 7L) | Ready (may exceed 10min) |
| megapot | code-423n4/2025-11-megapot | 1,709 | 19 (3H, 8M, 8L) | Ready to run |
| panoptic | Existing | Large | 34 (3H, 19M, 12L) | Ready (likely exceeds 10min) |

## Remaining Work (Optional)

1. **Run remaining codebases**: brix, megapot are within 10-min budget. ekubo and panoptic may need longer timeouts.
2. **V1 Deep runs**: Configured but excluded from default runs. Can add back to compare 4 conditions.
3. **Multiple iterations**: Current results are single-run. Running 3+ iterations per condition would show consistency.
4. **Codebase-level parallelism**: Currently only conditions run in parallel. Running multiple codebases concurrently would speed up full-matrix runs.


