# Incremental Clustering — Implementation Plan

## Problem

Current clustering sends ALL findings (up to 47+) in a single Sonnet call. This fails reliably above ~25 findings. Adding one run re-clusters everything. Clusters are non-deterministic across re-runs.

## Root Cause Analysis

### Context quality gap

| Mode | What Sonnet receives per finding | Quality |
|------|--------------------------------|---------|
| GT mode | Title + classifier reasoning (2-3 sentences) | Good |
| No-GT mode | Title + `"Location: X.y. Type: z."` | **Insufficient** — can't distinguish two bugs in the same contract |
| Raw stdout (unused) | Full description + code snippets + exploit path | Rich but discarded |

The parser (`parser.ts`) extracts `title`, `location`, `vulnType` but NOT the description body. For no-GT codebases, this means clustering operates on ~15 words per finding. This is not enough for reliable cluster assignment, whether full or incremental.

### Fix required before incremental clustering

Enrich `ClusterInput` with a `description` field:
- **GT mode:** Already has good context via classifier reasoning — no change needed.
- **No-GT mode:** Extract the description body from the raw stdout (the ~5-10 lines following each finding header). Add this to `collectAllFindings()`.

This is a prerequisite — incremental clustering on thin context will produce garbage assignments.

## Design

### Normal mode (no --force): Incremental

When new findings arrive, match them against existing clusters:

```
1. Load existing clusters from clusters-{codebase}.json
2. Identify NEW findings (not already in any cluster's foundIn)
3. For each batch of 3-5 new findings:
   a. Send to Sonnet: "Match these findings against existing clusters, or create new ones"
   b. Existing clusters described by: title + reasoning (compact, ~2 lines each)
   c. New findings described by: title + reasoning/description (full context)
   d. Response: array of { findingIndex, clusterId: "existing-X" | "new", newTitle?, newReasoning? }
4. Merge results: update foundIn/conditionsCaught on matched clusters, create new clusters
5. Write updated clusters file with new inputHash
```

### Force mode (--force): Full re-cluster with chunking

When `--force` is used, re-cluster from scratch but in manageable chunks:

```
1. Collect ALL findings
2. Split into chunks of ~15 findings
3. Cluster each chunk independently (parallel)
4. Merge clusters across chunks:
   a. Send chunk cluster summaries to Sonnet: "Are any of these the same bug?"
   b. Merge identified duplicates
5. Write final clusters file
```

### Batch size for incremental assignment

**3-5 findings per call** — reasoning:
- A typical run produces 5-15 novel findings → 1-3 calls
- Small enough for reliable JSON output
- Large enough to avoid excessive API calls
- Sonnet can easily compare 5 findings against 20 cluster summaries

### Cluster context in the prompt

For the incremental assignment prompt, include per cluster:
- `clusterId` (for reference in the response)
- `title` (1 line)
- `reasoning` (1-2 sentences)
- `severity`
- `memberCount` (how many findings are in this cluster — helps Sonnet gauge importance)

Do NOT include: `foundIn` arrays, `conditionsCaught`, `relevantFiles`. These are metadata, not semantic content.

At 20 clusters × ~3 lines each = ~60 lines of cluster context. Well within limits even at 50 clusters.

### Identifying "new" findings

A finding is "new" if it's not already in any cluster's `foundIn` array (matched by `runId + findingIndex`). This handles:
- Adding a new run: all its findings are new
- Re-classifying an existing run with --force: findings may shift between matched/novel, but IDs are stable

### Edge cases

1. **First run for a codebase (no existing clusters):** Falls back to full clustering of all findings (same as current behavior, but capped at ~15 per chunk).
2. **All findings are new (e.g., first 3 runs added at once):** Falls back to chunked full clustering.
3. **Zero new findings:** Cache hit, skip entirely (inputHash matches).
4. **Single new finding:** Still sends it — matching 1 finding against clusters is the simplest case.

## Implementation Steps

### Step 1: Enrich no-GT context

Add `description` field to `ClusterInput`:
```typescript
interface ClusterInput {
  runId: string;
  conditionId: string;
  findingIndex: number;
  findingTitle: string;
  reasoning: string;      // classifier reasoning (GT mode) or location+type (no-GT mode)
  description?: string;   // NEW: finding body text for richer context (no-GT mode)
}
```

Update `collectAllFindings()` to extract ~5 lines of description from the raw stdout following each finding header. Use the existing `extractFindingContext()` pattern from classify.ts but truncate to ~200 chars.

Update `collectNovelFindings()`: no change needed — classifier reasoning is already good context.

**Tests (Step 1):**
- [x] Skill format extracts description body text (not title, not location line)
- [x] Bare format extracts description body text
- [x] Description stops at next finding header — does not bleed across findings
- [x] Code blocks stripped from description
- [x] Long descriptions truncated at ~300 chars
- [x] Every finding has non-empty description across all 7 format variants
- [x] `collectAllFindings` produces reasoning with description body (not just "Location: X. Type: Y.")
- [x] Reasoning contains actual vulnerability description, not thin placeholder
- [x] Location and Type preserved at end of reasoning string
- [x] Snapshots updated for all format variants

### Step 2: Build incremental assignment prompt

New function `buildIncrementalPrompt(newFindings, existingClusters)`:
- Compact cluster summaries (title + reasoning + severity + member count)
- Full finding context (title + reasoning + description)
- Output schema: `[{ findingIndex, assignTo: "existing-clusterId" | "new", newTitle?, newReasoning?, newSeverity? }]`

**Tests (Step 2) — write BEFORE implementation:**
- [ ] Prompt includes all existing cluster summaries (title + reasoning + severity + count)
- [ ] Prompt includes full finding context (title + reasoning)
- [ ] Prompt does NOT include cluster foundIn arrays or metadata (keep it lean)
- [ ] Prompt handles 0 existing clusters (first-run case → becomes full clustering)
- [ ] Prompt handles 1 new finding (simplest incremental case)
- [ ] Prompt handles batch of 5 new findings
- [ ] Zod schema validates the expected response shape

### Step 3: Refactor clusterFindings()

Split into:
- `clusterFindingsIncremental()` — normal path, matches new findings against existing clusters
- `clusterFindingsFull()` — force path, chunks of ~15, merge across chunks
- `clusterFindings()` — orchestrator, picks the right path

**Tests (Step 3) — write BEFORE implementation:**
- [ ] Incremental: 1 new finding assigned to existing cluster → foundIn updated, conditionsCaught updated
- [ ] Incremental: 1 new finding creates new cluster → new cluster appended with correct shape
- [ ] Incremental: batch of 3 new findings, mix of matches and new → both paths work in same call
- [ ] Incremental: new finding for cluster that already has the same condition → no duplicate in conditionsCaught
- [ ] Full (--force): 20 findings split into 2 chunks of ~10 → all findings assigned, no orphans
- [ ] Full: chunks merged correctly — duplicate clusters across chunks detected and merged
- [ ] Edge: first run (no existing clusters) → full clustering path used automatically
- [ ] Edge: all new findings match existing clusters → no new clusters created, existing updated
- [ ] Edge: empty findings input → returns null (existing behavior preserved)
- [ ] Orchestrator: without --force + existing clusters → incremental path chosen
- [ ] Orchestrator: with --force → full path chosen regardless of existing clusters
- [ ] Result shape: ClusterResult has correct totalFindings, uniqueBugs, inputHash

### Step 4: Update cache logic

Cache key changes for incremental mode:
- inputHash = hash of (existing cluster titles + new finding titles + model)
- Cache hit when: no new findings (all already in clusters) AND model unchanged
- Cache miss when: new findings exist OR model changed OR --force

**Tests (Step 4):**
- [ ] Cache hit: no new findings, same model → skip (return existing)
- [ ] Cache miss: new findings exist → incremental assignment runs
- [ ] Cache miss: model changed → full re-cluster
- [ ] --force: always re-cluster regardless of cache state
- [ ] inputHash written to output file and checked on next run
- [ ] Old cluster files without inputHash (migration) → treated as cache miss

### Step 5: E2E validation

Run the full pipeline on real data to verify incremental clustering works end-to-end.

**Tests (Step 5):**
- [ ] `npm run analyze` on merkl-stripped with existing clusters → incremental path used, no 47-finding mega-prompt
- [ ] New run's findings correctly assigned to existing clusters or create new ones
- [ ] Validation step works correctly with incrementally-updated clusters
- [ ] Report metrics stable (no drift from cluster ID changes)
- [ ] Dashboard renders correctly

## Order of execution

Each step is tested before moving to the next. Tests written first where possible.

1. **Step 1** ✅ — enriching context (10 tests: description extraction, edge cases, cluster context quality)
2. **Step 2** ✅ — incremental prompt + Zod schema (13 tests: schema validation, prompt construction, LLM integration)
3. **Step 3** ✅ — refactor clusterFindings (12 tests: full path, incremental assign/new, force flag, cache hit, no new findings, empty, single, foundIn dedup, conditionsCaught dedup, stale pruning, empty cluster removal)
4. **Step 4** ✅ — cache logic (covered by Step 3 tests: cache hit, cache miss, inputHash written)
5. **Step 5** ✅ — E2E on real data: incremental path used for merkl-stripped (1 new → 21 clusters, 26s), cache hit on second run (0s), nft-dealers cached. Bugs found during review: stale foundIn pruning, single-finding fast path overwriting existing clusters — both fixed and tested.

### Additional fixes found during clustering review

- Stale foundIn entries pruned when findings are reclassified (novel→matched)
- Empty clusters dropped after pruning
- Single-finding fast path no longer overwrites existing clusters
- Duplicate foundIn guard in incremental assignment
- LLM parse errors now include raw response preview (up to 200 chars)
- Module header comment updated to reflect incremental/full architecture

## Not in scope

- Cluster merging UI (manual override)
- Cluster deletion/archival
- Cross-codebase clustering
- Changing the validation step (validate.ts is unaffected — it reads clusters the same way)
