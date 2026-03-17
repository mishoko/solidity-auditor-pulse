# Testing Strategy

## Framework

**Vitest** — native ESM + TypeScript support, no transform hacks needed for our `"type": "module"` / `NodeNext` setup. Same API as Jest (`describe`, `it`, `expect`, `vi.mock`).

## Principles

- Every test must justify its existence — no testing for testing's sake
- Pure logic first (highest ROI, zero mocking complexity)
- Fixture-driven: real JSON snapshots from actual runs, not hand-crafted fakes
- Mock at boundaries only (LLMProvider interface, `fs` where needed), never deep internals
- Pipeline contract tests catch phase-sequencing regressions early
- Hybrid assertion strategy: snapshots for shape/structure, explicit assertions for critical metrics
- Tests that discover bugs in production code → fix the root cause, not the test

## Test Tiers

### Tier 1: Pure Logic (no mocking)

Deterministic input → output. Highest value, easiest to write.

| # | Test file | Module under test | What it covers | Priority |
|---|-----------|-------------------|----------------|----------|
| 1.1 | `shared/report-data.test.ts` | `report-data.ts` | Metric computation from fixture JSONs — recall, FP rate, filtered counts, cross-codebase aggregates, metricBests, ledger sorting, run numbering | **P0** |
| 1.2 | `shared/parser.test.ts` | `parser.ts` | Finding extraction for every format: skill (`[confidence] **N. Title**`), bare H-1, bare `### [SEVERITY]`, bare numbered. Edge cases: empty input, malformed blocks, LLM recovery trigger detection | **P0** |
| 1.3 | `runner/verify.test.ts` | `verify.ts` | All 12 verification checks with fixture meta/stdout objects — exit codes, agent counts, skill contamination, scope violations | **P1** |
| 1.4 | `runner/config.test.ts` | `config.ts` | Config loading, condition filtering, codebase filtering, missing fields | **P2** |
| 1.5 | `classifier/classify.test.ts` | `classify.ts` | `computeMajority()` — all vote scenarios: unanimous, majority, split, all-failed, single vote, mixed categories. `hashContent()` determinism. | **P0** |
| 1.6 | `classifier/llm.test.ts` | `llm.ts` | `parallelMap()` — order preservation, concurrency limits, error propagation, empty input | **P1** |
| 1.7 | `shared/report-data.test.ts` | `report-data.ts` | `jaccardSimilarity()` — empty sets, identical sets, disjoint sets, partial overlap, single set | **P1** |

### Tier 2: Integration with Mocked I/O

Mock filesystem or LLM boundary — test orchestration logic.

| # | Test file | Module under test | What to mock | What to assert |
|---|-----------|-------------------|--------------|----------------|
| 2.1 | `runner/workspace.test.ts` | `workspace.ts` | `fs` (use temp dirs) | Directory structure correct, CLAUDE.md written with blocker content, skill installed for skill conditions, absent for bare, env vars stripped |
| 2.2 | `reports/report.test.ts` | `report.ts` | LLMProvider (fake analyst) | Snapshot: markdown output matches expected for known `ReportData` input |
| 2.3 | `dashboard/render.test.ts` | `render.ts` | Nothing (pure renderer) | Data contract: all fields the dashboard reads exist in report-data.json |

### Tier 3: Pipeline Contract Tests

Verify phases connect correctly — the critical refactor safety net.

| # | Test file | Module under test | What to mock | What to assert |
|---|-----------|-------------------|--------------|----------------|
| 3.1 | `classifier/pipeline.test.ts` | `pipeline.ts` | LLMProvider → canned JSON | classify output feeds cluster input, FakeLLMProvider integration, Zod validation |
| 3.2 | `classifier/cache.test.ts` | `classify.ts` | Temp dirs with fixture files | Cache hit/miss behavior: unchanged inputs → cached, changed GT → re-classify, changed prompt → re-classify, changed stdout → re-classify, `--force` → always re-classify |

### Tier 4: Isolation Verification

Unique to this project — contamination prevention invariants.

| # | Test file | What to assert |
|---|-----------|----------------|
| 4.1 | `runner/workspace.test.ts` | Workspace CLAUDE.md blocks parent walk-up, bare workspaces have no `.claude/commands/`, skill workspaces have correct version, canary injection, /tmp scoping, version mismatch detection |

### Tier 5: Provenance & Reproducibility

Verify that every run and analysis step captures enough metadata to reconstruct what happened.

| # | Test file | What to assert |
|---|-----------|----------------|
| 5.1 | `runner/provenance.test.ts` | `RunMeta` shape: all required fields present (runId, codebaseId, conditionId, iteration, timestampUtc, mode, exitCode, durationMs), skill runs have skillVersion + skillGitCommit, all runs have claudeModel + claudeCliVersion, codebaseGitCommit non-empty |
| 5.2 | `classifier/cache.test.ts` | Classification files record: classifierModel, gtHash, stdoutHash, promptHash, votesPerFinding, classifiedAt. Cache keys are deterministic (same input → same hash). Hash changes when any of GT, stdout, or prompt template changes. |

## Mocking Strategy

### LLM calls — LLMProvider interface

```typescript
export interface LLMProvider {
  call(prompt: string, model: string, timeout: number): Promise<string>;
}
```

- Production: `CLIProvider` — spawns `claude` CLI (current behavior)
- Tests: `FakeLLMProvider` — returns canned Zod-valid JSON, no process spawning
- Swap via `setLLMProvider()` / `resetLLMProvider()` (module-level, no parameter threading needed)
- Why from the start: avoids `vi.mock` path-coupling, makes test intent explicit, trivial to add new providers later (API-based, cached, etc.)

### Filesystem
- **Prefer real temp dirs** with fixture files over `vi.mock('node:fs')` — more realistic, fewer surprises
- **Use `vi.mock('node:fs')` only** when testing code that writes to many paths (workspace creation)

### Child process (`runner/runner.ts`)
- Do NOT mock `child_process.spawn` — that's the runner's core job
- Runner tests are manual/E2E (too expensive for CI, requires `claude` CLI)

## Assertion Strategy: Hybrid Snapshots + Explicit

Snapshots are powerful for this project (heavy JSON, large text output) but have a known failure mode: **update fatigue** — someone runs `--update`, glances at the diff, and approves without noticing that `avgRecall` shifted from 0.375 to 0.25.

**Rule: snapshots for shape, explicit assertions for numbers that drive decisions.**

| Module | Snapshot | Explicit assertions |
|--------|----------|-------------------|
| `parser.ts` | Full finding arrays per format variant | — |
| `report-data.ts` | Full `ReportData` shape (structural drift) | Critical metrics: recall, FP rate, filtered counts, consistency, cross-codebase aggregates |
| `report.ts` | Full markdown output | — |
| `render.ts` | Full HTML output | — |
| `pipeline.ts` | Intermediate JSON between phases | Output shape matches expected types |
| `verify.ts` | — | Boolean pass/fail per check (snapshots add nothing) |
| `classify.ts` | — | Explicit: category, matchedGtId, agreement string, _agreement count per vote scenario |

Snapshot update policy: `vitest --update` requires manual review of every changed snapshot before commit. CI fails on uncommitted snapshot changes.

## Fixtures

```
tests/
  fixtures/
    report-data-input/           # Full set for computeReportData integration
      run-*.meta.json
      run-*.stdout.txt
      run-*.classifications.json
      clusters-test-codebase.json
      validations-test-codebase.json
    ground_truth/
      test-codebase.json
    parser-samples/
      skill-format.txt
      bare-severity-brackets.txt
      bare-numbered-prefix.txt
      bare-bracketed-numbered.txt
      bare-trailing-severity.txt
      bare-paren-severity.txt
      bare-section-numbered.txt
      empty.txt
    verify-input/
      good-bare.events.jsonl
      good-bare.stdout.txt
      good-skill.events.jsonl
      good-skill.stdout.txt
      contaminated-bare.events.jsonl
      contaminated-bare.stdout.txt
```

## Bugs Found During Testing

Track bugs discovered while writing tests — fix root cause, not the test.

| Bug | Location | Severity | Status |
|-----|----------|----------|--------|
| `computeMajority()` hardcodes agreement to `'3/3' \| '2/3'` — wrong for CLASSIFY_VOTES != 3 | `classify.ts:300` | **HIGH** — agreement labels lie about actual vote count | Fixed |
| Stale duplicate JSDoc on `computeMajority()` | `classify.ts:211-217` | LOW — cosmetic | Fixed |
| Classification cache missing `votesPerFinding` — can't tell if result used 1-vote or 3-vote mode | `classify.ts` RunClassification shape | **MEDIUM** — reproducibility gap | Fixed |

## Design Issues Found During Testing

| Issue | Impact | Status |
|-------|--------|--------|
| Cache inconsistency: classify uses content hashing (robust), cluster/validate use mtime (fragile). Changing `VALIDATOR_MODEL` and re-running won't re-validate because mtime check passes. | Silent stale results when changing model/parameters without `--force` | **Fixed** — all three phases now use content hashing. Cluster checks `inputHash` + `clusterModel`. Validate checks `clusterHash` + `validatorModel`. mtime removed entirely. |

## What We Do NOT Test

- CLI argument parsing (`cli.ts`, `pipeline-cli.ts`) — thin wrappers, manual verification
- Logger formatting — cosmetic, no logic
- `CLIProvider.call()` internals — spawns real process, E2E concern
- CSS/styling in dashboard — visual, not logic
- LLM prompt wording — changes constantly, not deterministic
- Individual Zod schemas — tested implicitly via pipeline tests
- `runBenchmark()` / `runSingle()` — spawns `claude` CLI, E2E concern requiring auth

## Implementation Order

### Phase 1 — Foundation (complete)

- [x] **Step 0:** Install Vitest, configure for ESM/TypeScript, add `npm test` script
- [x] **Step 1:** Extract LLMProvider interface from `llm.ts` (set/reset provider, CLIProvider default)
- [x] **Step 2:** Create fixture files (parser samples, report-data input set, verify event logs)
- [x] **Step 3:** `parser.test.ts` (1.2) — 56 tests, 7 format variants + classifyVuln + unmatchedBlocks + estimate
- [x] **Step 4:** `report-data.test.ts` (1.1) — 39 tests, explicit metrics + full shape snapshot
- [x] **Step 5:** `verify.test.ts` (1.3) — 16 tests, exit codes, agents, contamination, grace-kill
- [x] **Step 6:** `pipeline.test.ts` (3.1) — 12 tests: FakeLLMProvider integration, callLLM/callLLMRaw with provider, Zod validation, collectNovelFindings contract
- [x] **Step 7:** `report.test.ts` + `render.test.ts` (2.2, 2.3) — report snapshot + dashboard data contract (10 tests)
- [x] **Step 8:** `workspace.test.ts` (2.1, 4.1) — 10 tests: bare/skill workspace creation, CLAUDE.md isolation, canary injection, /tmp scoping, version mismatch
- [x] **Step 9:** `config.test.ts` (1.4) — 7 tests: valid/invalid configs, Zod schema validation, optional fields

### Phase 2 — Critical gaps + bug fixes

- [x] **Step 10:** Fix `computeMajority()` agreement bug (hardcoded '3/3'|'2/3' → dynamic `N/M`), remove stale JSDoc, add `votesPerFinding` to RunClassification type + classify output, export `computeMajority`/`hashContent`/`jaccardSimilarity` for testing
- [x] **Step 11:** `classify.test.ts` (1.5) — 27 tests: computeMajority (single vote, 3-vote unanimous/majority/split, 5-vote dynamic labels, failed votes, edge cases) + hashContent (determinism, cache correctness)
- [x] **Step 12:** `llm.test.ts` (1.6) — 6 tests: parallelMap order preservation, concurrency limit, empty array, error propagation, index passthrough
- [x] **Step 13:** Extend `report-data.test.ts` (1.7) — 7 tests: jaccardSimilarity empty/identical/disjoint/partial/three-set/empty-sets
- [x] **Step 14:** Fix cluster/validate mtime caching → content hashing (align with classify). `cache.test.ts` (3.2, 5.2) — 16 tests: all 3 phases cache contract (hash determinism, invalidation on content/model change, cross-phase consistency, corrupt file handling)
- [x] **Step 15:** `provenance.test.ts` (5.1) — 10 tests: meta.json shape (identity, timing, model, skill provenance, git commit, runId encoding, stdout existence), classification file cache keys

210 tests across 12 test files. 3 production bugs fixed + 1 design issue fixed (cache consistency).

## CI Considerations (future)

- All Tier 1-4 tests run on every PR (no LLM calls, fast)
- Tier 5 provenance tests run on every PR (fixture-based, fast)
- Runner E2E tests (actual `claude` spawns) are manual or nightly — expensive and require CLI auth
- Snapshot updates require explicit `--update` flag to prevent silent drift
