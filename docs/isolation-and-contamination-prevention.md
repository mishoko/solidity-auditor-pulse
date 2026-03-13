# Isolation & Contamination Prevention

How the benchmark runner prevents cross-condition contamination, ensures result integrity, and detects failures.

---

## Contamination Risks

Benchmarking Claude Code skills means spawning multiple `claude` CLI processes that must each run in a controlled environment. Without isolation, several contamination vectors exist:

| Risk | How it happens | Severity |
|------|---------------|----------|
| **Skill leak into bare run** | User-level `~/.claude/commands/` contains the skill; bare Claude picks it up | Critical |
| **Wrong skill version** | Symlinked workspace resolves to real path; parent walk-up finds project or user skill | Critical |
| **Parent CLAUDE.md walk-up** | Spawned Claude walks up from workspace cwd, finds project's CLAUDE.md with benchmark internals | High |
| **Shared workspace interference** | Two concurrent Claude processes in same directory clobber files | High |
| **Env var inheritance** | `CLAUDE_CODE_SSE_PORT` inherited from IDE causes child process to hang | High |
| **Shared /tmp files** | Skill writes to hardcoded `/tmp/audit-*`; parallel runs overwrite each other's temp files | Medium |
| **User settings leak** | User's `~/.claude/settings.json` changes tool permissions or model | Medium |
| **Scope drift** | Claude reads out-of-scope contracts, inflating findings with noise | Low |

---

## Defense Layers

### 1. Workspace Isolation — Real Copies per Condition

**Source:** `src/workspace.ts` — `prepareWorkspace()`

Each `(codebase, conditionId)` pair gets its own workspace directory:

```
workspaces/<codebase>__<conditionId>/
├── .claude/commands/solidity-auditor/   ← skill copy (skill runs only)
├── CLAUDE.md                             ← scope + walk-up blocker
├── Contract1.sol                         ← real file copy
└── Contract2.sol                         ← real file copy
```

**Why real copies, not symlinks:** Claude resolves symlinked cwds to the real path before walking up to find `.claude/commands/`. With symlinks, it finds the user-level or project-level skill instead of the workspace's. This was discovered the hard way — symlinked workspaces silently used the wrong skill version with no error.

**Why per-condition, not per-codebase:** V1 default and V1 deep use the same skill version but must not share a workspace. Two concurrent Claude processes in the same cwd interfere with each other — one hangs while the other runs.

Workspaces are prepared upfront before any runs start, then cleaned up atomically after the suite completes (`rm -rf workspaces/`).

---

### 2. Skill Installation & VERSION Verification

**Source:** `src/workspace.ts` — `prepareWorkspace()`, `src/skill.ts`

For skill conditions, the skill source is copied from `skills_versions/<version>/solidity-auditor/` into the workspace's `.claude/commands/solidity-auditor/`. For bare conditions, no skill directory is created.

After copying, the installed `VERSION` file is verified against the expected version. If there's a mismatch, the run aborts immediately. This catches:
- Stale workspace caches
- Incorrect skill source paths in config
- Copy failures that leave partial installs

Each skill version also has a `source.json` with the git commit hash, recorded in run metadata for full traceability.

---

### 3. CLAUDE.md Walk-up Blocker

**Source:** `src/workspace.ts` — `writeCLAUDEmd()`

Every workspace gets a `CLAUDE.md` file at its root, regardless of condition type. This serves two purposes:

1. **Blocks parent directory walk-up.** Claude walks up from cwd looking for `CLAUDE.md` files. Without one in the workspace, it would find the project's `CLAUDE.md` — which contains benchmark internals, architecture notes, and instructions that would contaminate the audit.

2. **Delivers scope info consistently.** If the dataset has `scope.txt` or `out_of_scope.txt`, their content is embedded in the workspace `CLAUDE.md`. Every condition (skill or bare) sees the same scope constraints.

---

### 4. /tmp Path Rewriting for Parallel Safety

**Source:** `src/workspace.ts` — SKILL.md patching

The V1 and V2 skills use hardcoded `/tmp/audit-*` paths for intermediate files (agent bundles, temp reports). When running in parallel — across both conditions AND codebases — these paths collide.

The workspace preparation rewrites all `/tmp/audit-` references in the skill's SKILL.md to `/tmp/audit-<codebaseId>-<conditionId>-`, giving each (codebase, condition) pair a unique temp namespace. This prevents:
- One condition's agent overwriting another's bundle file
- Two codebases running the same condition clobbering each other's temp files
- Race conditions on shared temp paths
- Corrupted output from interleaved writes

---

### 5. Environment Variable Stripping

**Source:** `src/util/shell.ts` — `spawnClaude()`

Before spawning `claude`, all environment variables matching `CLAUDE_CODE*` or `CLAUDECODE` are removed from the child process environment.

The critical case: `CLAUDE_CODE_SSE_PORT`. When the benchmark runner is launched from an IDE (VS Code, Cursor), this variable is set. If inherited, the spawned Claude process tries to connect to the IDE's SSE endpoint and hangs indefinitely. Stripping it ensures the child runs independently.

---

### 6. Bare Run Hardening

**Source:** `src/util/shell.ts` — `spawnClaude()`

Bare audit runs receive two additional CLI flags beyond what skill runs get:

- `--disable-slash-commands` — prevents Claude from discovering or invoking any slash command, including skills that might exist in the workspace or user directories.
- `--disallowedTools Skill` — blocks the `Skill` tool at the API level, so even if Claude tries to invoke a skill programmatically, it's rejected.

This double-lock ensures bare runs cannot accidentally use the skill being benchmarked. The post-run verification also checks for this (see layer 9).

---

### 7. Setting Sources Restriction

**Source:** `src/util/shell.ts` — `spawnClaude()`

All runs use `--setting-sources project,local`. This restricts which `settings.json` files Claude reads to:
- Project-level (workspace `.claude/settings.json`)
- Local (workspace `.claude/settings.local.json`)

User-level `~/.claude/settings.json` is excluded. This prevents user preferences (model overrides, tool permissions, custom instructions) from leaking into benchmarks.

**Limitation:** `--setting-sources` only affects `settings.json`, NOT command/skill discovery. That's why workspace isolation (layer 1) and bare hardening (layer 6) are still necessary.

---

### 8. Canary String Injection

**Source:** `src/workspace.ts` — SKILL.md patching

During workspace preparation, a control string is injected into the skill's SKILL.md:

```
<!-- BENCHMARK_CONTROL: BENCHMARK_CANARY_{conditionId}_{timestamp} -->
```

If this string appears in a **bare run's** output, it proves the bare run somehow accessed the skill prompt — a contamination event. This is a passive detection mechanism: it doesn't prevent contamination, but makes it visible in post-run analysis.

---

### 9. Post-Run Verification

**Source:** `src/verify.ts` — `verifyRun()`

After each run completes, 12 automated checks validate the result:

**Process integrity:**
- Exit code is 0 or 143 (grace-killed after result received)
- Not a real timeout (timed out without completing work)
- Event stream is non-empty and contains a result event
- Stop reason is `end_turn`

**Skill-specific checks (skill runs only):**
- Expected number of agents spawned (≥4 for V1, ≥5 for V2)
- All spawned agents returned results
- No agent errors
- Agent results are substantial (≥10 lines each)
- Bundle files not empty after final attempt (tracks retries)

**Bare-specific checks (bare runs only):**
- No `solidity-auditor` in the `slash_commands` list from the init event — if present, the skill leaked into the bare run

**Scope compliance (all runs):**
- Out-of-scope contract names don't appear in findings
- At least some in-scope files were read
- Out-of-scope file reads flagged as warnings

**Diagnostics:**
- Tool errors collected and reported (grouped by tool name)
- Session restarts detected (multiple `system/init` events)

---

### 10. Timeout & Grace-Kill Protocol

**Source:** `src/util/shell.ts`

Each run has a 10-minute hard timeout. However, the skill may finish its work (emit a `result` event) but the CLI continues doing cleanup. The grace-kill protocol handles this:

1. Stream-JSON events are monitored in real-time
2. When a `result` event arrives, a 15-second grace timer starts
3. After grace period: `SIGTERM`
4. If still alive after 5 more seconds: `SIGKILL`
5. Exit code 143 (SIGTERM) is treated as success when work completed

This prevents hung processes from blocking the benchmark suite while preserving completed results.

---

### 11. Output Capture & Observability

**Source:** `src/util/shell.ts`

Every run produces four output files:

| File | Purpose |
|------|---------|
| `<runId>.stdout.txt` | Human-readable audit output (extracted from stream-JSON) |
| `<runId>.events.jsonl` | Raw stream-JSON events (tool calls, agent spawns, errors) |
| `<runId>.stderr.txt` | stderr capture (diagnostics, warnings) |
| `<runId>.meta.json` | Run metadata (timing, exit code, versions, git commits) |

The events file enables deep post-hoc analysis: which tools were called, which files were read, how long each agent took, whether errors occurred. The meta file provides structured data for the summary generator.

---

## Current Effectiveness Assessment

| Risk | Mitigation | Status | Confidence |
|------|-----------|--------|------------|
| Skill leak into bare run | Double-lock (`--disable-slash-commands` + `--disallowedTools Skill`) + post-run slash_commands check | Covered | High |
| Wrong skill version | Real copies + VERSION file verification | Covered | High |
| Parent CLAUDE.md walk-up | Workspace-level CLAUDE.md blocker | Covered | High |
| Shared workspace interference | Per-condition workspace isolation | Covered | High |
| Env var inheritance | Full `CLAUDE_CODE*` stripping | Covered | High |
| Shared /tmp files | Per-codebase-per-condition path rewriting | Covered | High |
| User settings leak | `--setting-sources project,local` | Covered | Medium |
| Scope drift | CLAUDE.md scope injection + post-run scope compliance checks | Covered | Medium |

**Medium confidence items:**

- **/tmp rewriting** depends on the skill using the exact `/tmp/audit-` prefix. If a skill version uses a different temp path pattern, it won't be caught. Now scoped by both codebase and condition (`/tmp/audit-<codebaseId>-<conditionId>-`).
- **Setting sources** only blocks `settings.json`, not all user-level config. If Claude Code adds new user-level config mechanisms, this may not cover them.
- **Scope compliance** uses heuristic name matching (contract names in findings text). Generic names like "Errors", "Utils", "Base" are filtered to avoid false positives, but edge cases may slip through.

---

## Parallelism Testing Status

**Cross-condition parallelism (1 codebase × N conditions):** Tested and proven. merkl ran V2 + V1 + Bare CC concurrently with correct results and no contamination (2026-03-12).

**Cross-codebase parallelism (N codebases × 1 condition):** Tested with bare CC on canary + nft-dealers (2026-03-13). Both ran concurrently, all verification checks passed, no cross-contamination. Workspaces fully independent.

**Full matrix parallelism (N codebases × M conditions):** Not yet tested. Running 2 codebases × 3 conditions = 6 processes, each skill condition spawning 4-6 agents = ~30 concurrent API calls. Rate limit impact on Claude Max subscription is unknown. The isolation infrastructure is in place (per-codebase-per-condition `/tmp` scoping, unique workspaces, unique result files), but a live test with skill conditions has not been performed due to rate limit concerns.

---

## Known Gaps

1. **User-level `~/.claude/commands/` is not actively blocked.** We rely on the user not having the skill installed globally. If they do, bare runs are protected by `--disable-slash-commands`, but skill runs could pick up the wrong version. The VERSION check catches version mismatches, but if the user has the exact same version installed globally, it's invisible.

2. **No network isolation.** Claude can still access the internet during runs. If the skill or Claude fetches external resources, those aren't controlled.

3. **Model version pinning is config-level only.** The `--model` flag is passed per the config, but the model is now recorded from the actual events stream (`claudeModel` in meta.json). No verification that it matches what was requested, but post-hoc detection is possible.

4. **Rate limits under heavy parallelism.** Running N codebases × M conditions in parallel creates N×M concurrent Claude processes, each potentially spawning 4-6 agents. With 6 processes and ~30 agents, Anthropic rate limits may cause agent failures or retries that skew timing results. No mitigation beyond Anthropic's built-in backoff.
