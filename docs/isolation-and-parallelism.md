# Isolation & Parallelism Strategy

## Parallel Execution Model

`--parallel` runs all conditions for a given (codebase, iteration) concurrently via `Promise.all`. Iterations remain sequential — iteration 2 starts only after iteration 1 completes for all conditions.

```
Iteration 1:  [bare_audit]──────────┐
              [skill_v1_default]─────┤  ← all start together
              [skill_v1_deep]────────┤
              [skill_v2]─────────────┘  ← wait for slowest
Iteration 2:  [bare_audit]──────────┐
              [skill_v1_default]─────┤
              ...
```

No `--max-parallel` throttle is implemented. With 4 conditions this isn't needed. If we add more conditions or codebases in parallel, revisit.

## Why Parallel Is Safe

Each condition is fully isolated at every level:

| Concern | How it's isolated |
|---|---|
| **Filesystem** | Each skill version gets its own workspace: `workspaces/<codebase>_v1/`, `workspaces/<codebase>_v2/`. Bare runs use `datasets/<codebase>/` directly. All are read-only — Claude audits code but doesn't modify it (`--dangerously-skip-permissions` is for reading, not writing). |
| **Output files** | Each run gets a unique timestamp-based `runId` (e.g. `2026-03-11T06-21-55-259Z_canary_bare_audit_run1`), so `.stdout.txt` and `.meta.json` never collide even when parallel. |
| **Env vars** | All `CLAUDE_CODE*` and `CLAUDECODE` env vars are stripped per spawned process. Without this, `CLAUDE_CODE_SSE_PORT` makes child processes hang waiting for an IDE SSE connection that doesn't exist. |
| **Process** | Each `claude -p` is a fresh `child_process.spawn` with its own stdio pipes (`['ignore', 'pipe', 'pipe']`). No shared state, no IPC between processes. |
| **Settings** | Bare runs use `--disable-slash-commands --setting-sources project,local` to block user config and skills. Skill runs use workspace-local `.claude/commands/` — each skill version is a separate copy. |
| **Ground truth** | Lives at project root (`ground_truth/`), outside both `datasets/` and `workspaces/`. Claude never sees these files during audits. |

## Why Not Docker

Docker would add:
- Image builds and maintenance
- Volume mount configuration for each workspace
- Network setup for API access
- Per-container resource allocation

For zero meaningful isolation gain. Our processes:
- Don't write to the codebase (audit-only)
- Don't share state (separate workspaces, unique output files)
- Don't interfere with each other (separate child processes)

Docker would only matter if we needed CPU/memory isolation (we don't — API calls are the bottleneck, not local compute) or sandboxing untrusted code execution (we don't — we're running trusted Claude CLI).

## Rate Limit Considerations

Each condition spawns internal sub-agents:

| Condition | Internal agents | Concurrent API sessions |
|---|---|---|
| `bare_audit` | 0 (single prompt) | 1 |
| `skill_v1_default` | 4 vector-scan (Sonnet) | ~5 |
| `skill_v1_deep` | 4 vector-scan (Sonnet) + 1 adversarial (Opus) | ~6 |
| `skill_v2` | 5 scan agents + 1 fp-gate | ~7 |

Running all 4 in parallel: up to **~19 concurrent API sessions**.

- **Small codebases (canary):** Each agent finishes fast, peak concurrency is brief. Safe.
- **Large codebases (panoptic):** Agents run for minutes, sustained high concurrency. May hit rate limits. Drop to sequential or reduce conditions if throttled.

## Workspace Lifecycle

1. **Preparation (before any runs):** All skill workspaces created upfront. One workspace per (codebase, skillVersion) pair — shared across iterations and conditions using the same version.
2. **During runs:** Workspaces are read-only. Multiple parallel processes can safely read the same symlinked codebase.
3. **Cleanup (after all runs):** `workspaces/` directory is deleted entirely. Results persist in `results/`.

## Decision Log

| Decision | Rationale |
|---|---|
| No Docker | Overhead without isolation benefit (see above) |
| No max-parallel | Only 4 conditions; not needed until we scale |
| Sequential iterations | Prevents rate-limit stacking; gives cleaner timing data |
| Parallel within iteration | 4x speedup for the common case (all conditions, 1 codebase) |
| Workspaces prepared upfront | Avoids race conditions during parallel workspace creation |
