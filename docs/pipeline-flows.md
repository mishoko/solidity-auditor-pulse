# Analysis Pipeline — Flow Reference

> All claims in this document are verified against source code as of 2026-03-16.
> Code references: `src/classifier/classify.ts`, `cluster.ts`, `validate.ts`, `pipeline.ts`

---

## Pipeline Overview

```
                    WITH GROUND TRUTH                    WITHOUT GROUND TRUTH
                    ════════════════                      ════════════════════

                    ┌─────────────┐
  .stdout.txt ──────┤  STEP 1     │
  GT JSON     ──────┤  CLASSIFY   │                      ⛔ SKIPPED
                    │  (Sonnet)   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
          matched        novel      uncertain         .stdout.txt ────┐
          + FP        + uncertain      │                              │
           │             │             │                              │
           │             └─────┬───────┘                              │
           │                   │                                      │
           │         ┌─────────▼─────────┐                ┌──────────▼──────────┐
           │         │  STEP 2           │                │  STEP 2              │
           │         │  CLUSTER          │                │  CLUSTER             │
           │         │  (Sonnet)         │                │  (Sonnet)            │
           │         │                   │                │                      │
           │         │  novel+uncertain  │                │  ALL findings        │
           │         │  findings only    │                │  from all runs       │
           │         └─────────┬─────────┘                └──────────┬──────────┘
           │                   │                                     │
           │         ┌─────────▼─────────┐                ┌──────────▼──────────┐
           │         │  STEP 3           │                │  STEP 3              │
           │         │  VALIDATE         │                │  VALIDATE            │
           │         │  (Opus)           │                │  (Opus)              │
           │         └─────────┬─────────┘                └──────────┬──────────┘
           │                   │                                     │
           └───────────┬───────┘                                     │
                       │                                             │
              ┌────────▼────────┐                           ┌────────▼────────┐
              │     REPORT      │                           │     REPORT      │
              │  recall, FP,    │                           │  unique bugs,   │
              │  novel verdicts │                           │  verdicts, cost │
              │  cost, matrix   │                           │  (no recall)    │
              └─────────────────┘                           └─────────────────┘
```

---

## Step 1: Classification

### When it runs

**Only when a `ground_truth/<codebaseId>.json` file exists.**

Code proof (`classify.ts:528-531`):
```typescript
const gt = loadGroundTruth(codebaseId);
if (!gt) {
  log.info(`No ground truth for ${codebaseId} — skipping classification`);
  continue;
}
```

Without GT, classification is fully skipped. Findings go directly to clustering.

### Inputs

| Input | Source | What it contains |
|-------|--------|------------------|
| `<runId>.stdout.txt` | Benchmark runner | Raw audit output from Claude |
| `ground_truth/<id>.json` | Hand-written from C4 reports | 8 entries with: id, severity, title, rootCause, location, description |

The stdout is parsed by `parser.ts` (regex + LLM recovery fallback) into structured findings. Each finding gets ~40 lines of surrounding context extracted (`classify.ts:78-83`).

### What happens

For **each finding** in each run:

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  SONNET receives:                                                   │
│  ┌───────────────────────────────────────┐                          │
│  │ All 8 GT entries (id, title, rootCause│                          │
│  │ location, description)               │                          │
│  │                                       │                          │
│  │ + ONE finding (title, location,       │                          │
│  │   severity, ~40 lines of context)     │                          │
│  └───────────────────────────────────────┘                          │
│                                                                     │
│  SONNET answers:                                                    │
│  ┌───────────────────────────────────────┐                          │
│  │ { category, matchedGtId, confidence,  │                          │
│  │   reasoning }                         │                          │
│  └───────────────────────────────────────┘                          │
│                                                                     │
│  This is repeated CLASSIFY_VOTES times (default 1, production 3)    │
│  Majority vote determines final label.                              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### LLM calls

| Metric | Formula | Example (merkl-stripped, 3 runs) |
|--------|---------|------|
| Model | Sonnet | `claude-sonnet-4-20250514` |
| Calls per finding | `CLASSIFY_VOTES` (default 1) | 1 |
| Calls per run | findings_count x votes | 14 x 1 = 14 |
| Total calls | sum across all runs | 66 (across 8 valid runs) |
| With 3-vote | findings_count x 3 x runs | 66 x 3 = 198 |
| Timeout | 120s (hardcoded) | — |

### Output

`<runId>.classifications.json` — one per run, containing:

```
Each finding gets exactly ONE label:
  matched   — same root cause as a GT entry (+ gtId)
  novel     — real bug not in GT
  fp        — false positive
  uncertain — no majority consensus (only with CLASSIFY_VOTES >= 3)
```

Cached by `sha256(gtContent + stdoutContent + promptTemplate)`.

### Value

- **Recall measurement**: "did the tool find known bugs?" — impossible without this step
- **FP filtering**: separates noise from signal before clustering
- **Reduces clustering load**: only novel+uncertain go to clustering (matched/FP already resolved)

### Without this step (no-GT path)

- No recall/precision metrics — can't measure accuracy
- ALL findings go to clustering — more load, more noise, higher error risk
- No FP filtering — clustering must handle false positives mixed with real bugs

---

## Step 2: Clustering

### When it runs

**Always** — for every codebase with results, regardless of GT availability.

### Inputs

| Mode | What gets clustered | Source | Code reference |
|------|-------------------|--------|----------------|
| **With GT** | Only `novel` + `uncertain` findings | From classification output | `cluster.ts:496` → `collectNovelFindings()` |
| **Without GT** | **ALL** findings from all runs | Parsed from stdout | `cluster.ts:499` → `collectAllFindings()` |

**Critical difference in input quality:**

```
WITH GT — each finding has:                WITHOUT GT — each finding has:
  • findingTitle                              • findingTitle
  • reasoning (from Sonnet classification     • reasoning = "Location: X. Type: Y."
    — rich, 2-3 sentence explanation)           (sparse, from parser only)
  • Already filtered (no matched/FP)          • NO filtering (FP mixed in)
```

Code proof of the sparse reasoning (`cluster.ts:415`):
```typescript
reasoning: `Location: ${finding.location ?? 'unknown'}. Type: ${finding.vulnType}.`,
```

### What happens

**Two clustering paths:**

- **Incremental (default):** new findings matched against existing clusters in batches of 5. Existing clusters stay stable. Stale foundIn entries pruned when findings are reclassified.
- **Full (--force or first run):** all findings clustered from scratch in chunks of ≤15 for reliable LLM responses.

Full path detail (single Sonnet call per chunk):

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  SONNET receives:                                                   │
│  ┌───────────────────────────────────────┐                          │
│  │ ALL N findings as a numbered list:    │                          │
│  │                                       │                          │
│  │ [1] (run: ..., condition: bare_audit) │                          │
│  │   Title: recoverFees Drains Balances  │                          │
│  │   Reasoning: <from classify or parse> │                          │
│  │                                       │                          │
│  │ [2] (run: ..., condition: pashov)     │                          │
│  │   Title: Fee Drain via recoverFees    │                          │
│  │   Reasoning: ...                      │                          │
│  │                                       │                          │
│  │ ... all N findings ...                │                          │
│  │                                       │                          │
│  │ + Source file list (if --validate)     │                          │
│  │   - contracts/Distributor.sol          │                          │
│  │   - contracts/DistributionCreator.sol  │                          │
│  └───────────────────────────────────────┘                          │
│                                                                     │
│  SONNET answers:                                                    │
│  ┌───────────────────────────────────────┐                          │
│  │ Array of clusters, each with:         │                          │
│  │ • clusterId, title, severity          │                          │
│  │ • reasoning (root cause explanation)  │                          │
│  │ • memberIndices [1, 2, ...]           │                          │
│  │ • relevantFiles (if scoping enabled)  │                          │
│  └───────────────────────────────────────┘                          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

After the LLM call:
- Content-based cluster IDs generated: `sha256(title + reasoning)` truncated to 8 chars
- Unassigned findings → orphan clusters (1 finding each)
- `foundIn` array tracks which runs/conditions found each bug

### LLM calls

| Metric | Value |
|--------|-------|
| Model | Sonnet (`claude-sonnet-4-20250514`) |
| Calls per codebase | **Incremental:** 1 per batch of 5 new findings. **Full:** 1 per chunk of ≤15 findings. |
| Total calls | Incremental: typically 1-3. Full: ceil(N/15). Cached: 0. |
| Retries | Up to 3 on failure |
| Timeout | 180s (configurable via `CLUSTER_TIMEOUT_MS`) |

### Output

`clusters-<codebase>.json` — containing:

```
{
  inputHash: "6ed09a10821218a2", // content-based cache key (inputs + model + scoping)
  clusterModel: "claude-sonnet-4-20250514",
  totalFindings: 47,           // input count
  uniqueBugs: 21,              // output count (deduplicated)
  clusters: [
    {
      clusterId: "novel-a1b2c3d4",
      title: "recoverFees Drains User Predeposited Balances",
      severity: "high",
      reasoning: "...",
      relevantFiles: ["contracts/DistributionCreator.sol"],
      foundIn: [
        { runId: "...", conditionId: "bare_audit", ... },
        { runId: "...", conditionId: "pashov", ... }
      ],
      conditionsCaught: ["bare_audit", "pashov"]
    },
    ...
  ]
}
```

### Value

- **Deduplication**: "47 findings across 8 runs" → "21 unique bugs"
- **Cross-run consistency**: see which bugs are found by multiple conditions
- **File scoping**: maps each cluster to relevant source files (for Opus validation)

### Risk: no-GT path quality

**This is a real concern.** Without classification:

| Factor | With GT | Without GT |
|--------|---------|------------|
| Findings clustered | Only novel + uncertain | ALL (including FP) |
| Finding count | Lower (FP removed) | Higher (FP mixed in) |
| Reasoning quality | Rich (2-3 sentences from Sonnet) | Sparse (`"Location: X. Type: Y."`) |
| FP contamination | None (filtered out) | FP findings may form their own clusters or merge with real bugs |

With many runs x many conditions, the no-GT input can be large (e.g., 4 conditions x 3 runs x 15 findings = 180 findings in one prompt). This increases the risk of:
- Sonnet conflating similar-sounding but different bugs
- FP findings forming clusters that look like real bugs
- Token limit pressure on the single clustering call

**Mitigating factors:**
- Validation (Step 3) catches many clustering errors — Opus rejects FP clusters
- The clustering prompt explicitly says "group by ROOT CAUSE" which helps
- For the real data: nft-dealers (no-GT, 1 run per condition) had 22 findings → 17 clusters — manageable

---

## Step 3: Validation

### When it runs

**Optional** — enabled by default in `npm run analyze`, skipped with `--no-validate`.

Code: `pipeline.ts:137-142` — controlled by `options.validate`.

### Inputs

| Input | Source |
|-------|--------|
| `clusters-<codebase>.json` | From Step 2 |
| Actual `.sol` source code | From `datasets/<codebase>/` |

Source code scoping strategy (`validate.ts:85-155`):
1. Use `cluster.relevantFiles` (assigned by Sonnet in Step 2) — typically 1-3 files
2. Fall back to `scope.txt` (all in-scope files)
3. Fall back to all non-test `.sol` files (warns if >200KB)

### What happens

**One Opus call per cluster**, run in parallel (max 3 concurrent):

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  OPUS receives (per cluster):                                       │
│  ┌───────────────────────────────────────┐                          │
│  │ Cluster title + severity + reasoning  │                          │
│  │                                       │                          │
│  │ + ACTUAL SOLIDITY SOURCE CODE         │                          │
│  │   (scoped to 1-3 relevant files)     │                          │
│  └───────────────────────────────────────┘                          │
│                                                                     │
│  OPUS answers:                                                      │
│  ┌───────────────────────────────────────┐                          │
│  │ {                                     │                          │
│  │   verdict: confirmed/plausible/       │                          │
│  │            rejected                   │                          │
│  │   severity: (reassessed)              │                          │
│  │   reasoning: 3-5 sentences            │                          │
│  │   codeEvidence: "function X line Y"   │                          │
│  │ }                                     │                          │
│  └───────────────────────────────────────┘                          │
│                                                                     │
│  Opus is told to be RIGOROUS:                                       │
│  • Find the specific function and lines                             │
│  • Trace the exploit path                                           │
│  • Consider access controls and guards                              │
│  • Check if behavior is intentional                                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

On failure: defaults to `plausible` (not rejected — conservative for security context).

Opus also assigns a `riskCategory` for confirmed/plausible findings:

| Category | Meaning | Dashboard default |
|----------|---------|-------------------|
| `centralization-risk` | Depends on trusted admin/governor acting maliciously. Not exploitable by external attacker. | Hidden |
| `informational` | Code quality, gas optimization, best practice violation, no realistic exploit path. | Hidden |
| *(absent)* | Real vulnerability exploitable without privileged access. | Shown |

This enables post-validation filtering without losing data — the finding stays in the validation output, renderers decide what to show.

### LLM calls

| Metric | Value |
|--------|-------|
| Model | **Opus** (`claude-opus-4-6`) |
| Calls | **1 per cluster** |
| Concurrency | 3 parallel (configurable via `VALIDATE_CONCURRENCY`) |
| Total calls | = number of clusters (e.g., 21 for merkl-stripped, 17 for nft-dealers = 38 total) |
| Timeout | 180s per call (configurable via `VALIDATOR_TIMEOUT_MS`) |
| Retries | 2 (default from llm.ts) |

### Output

`validations-<codebase>.json` — containing:

```
{
  clusterHash: "5a602c11eb11dabc",  // content-based cache key (cluster file + model)
  validatorModel: "claude-opus-4-6",
  confirmed: 7,    // real bugs with verified exploit path
  plausible: 3,    // reasonable but conditional
  rejected: 11,    // not real or prevented by guards
  validations: [
    {
      clusterId: "novel-a1b2c3d4",
      title: "recoverFees Drains User Predeposited Balances",
      verdict: "confirmed",
      severity: "high",
      reasoning: "recoverFees: tokens[i].safeTransfer(to, ...) sends
                  full balance including user deposits...",
      codeEvidence: "DistributionCreator.recoverFees L612",
      riskCategory: "centralization-risk"  // or "informational" or absent
    },
    ...
  ]
}
```

### Value

- **Ground truth for novel findings** — the only step that reads actual source code
- **FP cleanup for no-GT path** — catches clustering errors where FP findings formed clusters
- **Severity reassessment** — Opus may upgrade/downgrade severity based on actual code analysis
- **Evidence trail** — `codeEvidence` field provides specific function/line references

### Without this step

- Novel findings have no verification — just "Sonnet thinks it's a bug"
- No-GT path has no quality gate at all (no classification + no validation = pure LLM opinion)
- Report shows findings without confirmed/plausible/rejected labels

---

## Call Summary

### With GT — Example: merkl-stripped (8 runs, 66 findings, 21 clusters)

| Step | Model | Calls | What | Cost driver |
|------|-------|-------|------|-------------|
| Classify | Sonnet | 66 | 1 per finding x 1 vote | Volume of findings |
| Classify (3-vote) | Sonnet | 198 | 1 per finding x 3 votes | 3x above |
| Cluster | Sonnet | 1 | 1 per codebase | Batched — fixed cost |
| Validate | **Opus** | 21 | 1 per cluster | Cluster count + source code size |
| Report narrative | Sonnet | 1 | 1 per report | Fixed cost |
| **Total (1-vote)** | | **89** | | |
| **Total (3-vote)** | | **221** | | |

### Without GT — Example: nft-dealers (4 runs, 22 findings, 17 clusters)

| Step | Model | Calls | What | Cost driver |
|------|-------|-------|------|-------------|
| Classify | — | **0** | Skipped entirely | — |
| Cluster | Sonnet | 1 | All 22 findings in one call | Finding volume (no filtering) |
| Validate | **Opus** | 17 | 1 per cluster | Cluster count + source code size |
| Report narrative | Sonnet | 1 | 1 per report | Fixed cost |
| **Total** | | **19** | | |

### Model usage summary

| Model | Used in | Purpose |
|-------|---------|---------|
| **Sonnet** | Classification, Clustering, Report narrative | High-volume, lower-cost tasks |
| **Opus** | Validation **only** | Low-volume, high-stakes decisions requiring source code analysis |

Opus is never used for classification or clustering.

---

## Error Risk Map

```
                    ERROR RISK BY STEP AND PATH

  STEP              WITH GT                    WITHOUT GT
  ════              ═══════                    ══════════

  CLASSIFY          Low risk                   ⛔ SKIPPED
                    • 1 finding at a time      → No FP filtering
                    • Rich GT descriptions     → No recall measurement
                    • Majority vote catches     → All noise passes through
                      LLM inconsistency

  CLUSTER           Low-Medium risk             Medium-High risk
                    • Fewer findings (FP        • ALL findings (FP mixed in)
                      already filtered)         • Sparse reasoning per finding
                    • Rich reasoning from       • Larger batch = more token
                      classification              pressure in single call
                    • 1 Sonnet call (can        • FP may cluster with real bugs
                      conflate similar bugs)      or form fake clusters

  VALIDATE          Low risk                    Low risk (but more work)
                    • 1 cluster at a time       • Same quality per call
                    • Reads actual source code  • More clusters to validate
                    • Opus is rigorous            (no FP pre-filtering)
                    • Catches clustering        • Catches clustering + FP
                      errors                      errors (safety net)

  OVERALL           Strong                      Validation is the safety net
                    Classification + Validation  Without it, quality depends
                    provide two independent      entirely on Sonnet clustering
                    quality gates                a single LLM call
```

### Key insight

For no-GT codebases, **validation is not optional** — it's the only quality gate. Without classification to filter FP and without validation to verify against source code, the entire output is unverified Sonnet opinion.

---

## Recommendations High-Level

1. **Always run validation** (`npm run analyze`, not `analyze -- --no-validate`) for any results you plan to present. The `--no-validate` flag exists for fast iteration during development only.

2. **Use 3-vote classification for production** (`CLASSIFY_VOTES=3`). The 6% instability at 1-vote means ~4 findings per run may flip category between reruns.

3. **GT codebases produce significantly more reliable results** than no-GT codebases. For codebases without GT, treat all findings as preliminary until Opus validation confirms them.

4. **Cost structure**: Opus validation is the expensive step (~$0.05-0.15  per cluster depending on source code size). Classification and clustering use Sonnet (~$0.01-0.02 per call). For a typical benchmark (3 runs x 4 conditions x 1 codebase), expect:
   - Classification: ~$1-3 (Sonnet, scales with findings x votes)
   - Clustering: ~$0.05 (Sonnet, 1 call)
   - Validation: ~$1-3 (Opus, scales with cluster count)
   - Total analysis: ~$2-6 per codebase
