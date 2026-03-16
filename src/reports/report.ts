/**
 * Management report generator.
 *
 * Architecture:
 *   1. Load all results, classifications, clusters, validations
 *   2. Compute deterministic metrics (recall, precision, consistency, cost)
 *   3. Build management comparison table (one column per condition)
 *   4. Build findings ledger per codebase
 *   5. Generate 1 LLM narrative (Sonnet)
 *   6. Deterministic number verification (regex-extract numbers, check against metrics)
 *   7. Write deterministic data appendix
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  RunMeta,
  GroundTruth,
  RunClassification,
  ClusterResult,
  ValidationResult,
  RunMetrics,
} from '../shared/types.js';
import { parseOutput, type ParseResult } from '../shared/parser.js';
import { callLLMRaw, LLMError } from '../classifier/llm.js';
import * as log from '../shared/util/logger.js';

// ─── Config ───

const ANALYST_MODEL = process.env.ANALYST_MODEL || 'claude-sonnet-4-20250514';
const ANALYST_TIMEOUT = parseInt(process.env.ANALYST_TIMEOUT_MS || '') || 300_000;

// ─── Report options ───

export interface ReportOptions {
  latest: boolean;
}

// ─── Internal types ───

interface RunData {
  meta: RunMeta;
  parse: ParseResult;
  classification: RunClassification | null;
  /** Run failed validity checks — excluded from metric averages. */
  invalid?: string;
}

// ─── Display constants ───

const CONDITION_ORDER: [string, string][] = [
  ['skill_v2', 'V2'],
  ['skill_v1_default', 'V1'],
  ['skill_v1_deep', 'V1 Deep'],
  ['bare_audit', 'Bare CC'],
];

function conditionLabel(id: string): string {
  return CONDITION_ORDER.find(([k]) => k === id)?.[1] ?? id;
}

function conditionSortIndex(id: string): number {
  const idx = CONDITION_ORDER.findIndex(([k]) => k === id);
  return idx >= 0 ? idx : 999;
}

function formatDuration(ms: number): string {
  if (ms === 0) return '-';
  const sec = Math.round(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m${s}s` : `${sec}s`;
}

function bar(value: number, max: number, width: number = 20): string {
  if (max === 0) return '░'.repeat(width);
  const filled = Math.round((value / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ─── Data loading ───

function loadGroundTruth(codebaseId: string): GroundTruth | null {
  const gtPath = path.resolve(process.cwd(), 'ground_truth', `${codebaseId}.json`);
  if (!fs.existsSync(gtPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(gtPath, 'utf8'));
  } catch {
    return null;
  }
}

function loadClusters(resultsDir: string, codebaseId: string): ClusterResult | null {
  const p = path.join(resultsDir, `clusters-${codebaseId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function loadValidations(resultsDir: string, codebaseId: string): ValidationResult | null {
  const p = path.join(resultsDir, `validations-${codebaseId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function extractCostFromEvents(resultsDir: string, runId: string): number | null {
  const eventsPath = path.join(resultsDir, `${runId}.events.jsonl`);
  if (!fs.existsSync(eventsPath)) return null;
  const text = fs.readFileSync(eventsPath, 'utf8');
  const match = text.match(/"total_cost_usd":\s*([\d.]+)/);
  return match?.[1] ? parseFloat(match[1]) : null;
}

/** Minimum stdout chars for a valid skill run (skills always produce substantial output). */
const MIN_SKILL_STDOUT_CHARS = 500;
/** Minimum findings for a valid skill run on a non-trivial codebase. */
const MIN_SKILL_FINDINGS = 1;

/**
 * Check if a run is invalid (corrupt, truncated, or otherwise unusable).
 * Returns a reason string if invalid, undefined if OK.
 */
function detectInvalidRun(meta: RunMeta, text: string, findingsCount: number): string | undefined {
  // Skill run with exit 0 but no findings — skills always produce findings on real codebases.
  // This catches the V1 Deep inode-detachment case (exit 0, 756 chars, 0 findings).
  if (meta.mode === 'skill' && findingsCount < MIN_SKILL_FINDINGS) {
    return `skill run produced ${findingsCount} findings (expected ≥${MIN_SKILL_FINDINGS})`;
  }

  // Any run with exit 0 but suspiciously short stdout — likely truncated or corrupt.
  if (meta.mode === 'skill' && text.length < MIN_SKILL_STDOUT_CHARS) {
    return `stdout only ${text.length} chars (expected ≥${MIN_SKILL_STDOUT_CHARS} for skill run)`;
  }

  return undefined;
}

function loadValidRuns(resultsDir: string): RunData[] {
  const runs: RunData[] = [];
  const metaFiles = fs.readdirSync(resultsDir).filter((f) => f.endsWith('.meta.json'));

  for (const file of metaFiles) {
    let meta: RunMeta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8'));
    } catch {
      continue;
    }
    if (meta.exitCode !== 0 && meta.exitCode !== 143) continue;

    const stdoutFile = path.join(resultsDir, `${meta.runId}.stdout.txt`);
    if (!fs.existsSync(stdoutFile)) continue;

    const text = fs.readFileSync(stdoutFile, 'utf8');
    const parse = parseOutput(text);

    const classFile = path.join(resultsDir, `${meta.runId}.classifications.json`);
    let classification: RunClassification | null = null;
    if (fs.existsSync(classFile)) {
      try {
        classification = JSON.parse(fs.readFileSync(classFile, 'utf8'));
      } catch {
        // Skip malformed
      }
    }

    const invalid = detectInvalidRun(meta, text, parse.findings.length);
    if (invalid) {
      log.warn(`Invalid run ${meta.conditionId} iter ${meta.iteration}: ${invalid}`);
    }

    runs.push({ meta, parse, classification, invalid });
  }

  runs.sort((a, b) => a.meta.timestampUtc.localeCompare(b.meta.timestampUtc));
  return runs;
}

function filterLatestRuns(runs: RunData[]): RunData[] {
  const latest = new Map<string, RunData>();
  for (const run of runs) {
    const key = `${run.meta.codebaseId}::${run.meta.conditionId}`;
    const existing = latest.get(key);
    if (!existing || run.meta.timestampUtc > existing.meta.timestampUtc) {
      latest.set(key, run);
    }
  }
  return [...latest.values()];
}

// ─── Metrics ───

function computeRunMetrics(run: RunData, gt: GroundTruth | null, resultsDir: string): RunMetrics {
  const costUsd = extractCostFromEvents(resultsDir, run.meta.runId);

  let matched: number | null = null;
  let novel: number | null = null;
  let fp: number | null = null;
  let uncertain: number | null = null;
  let recall: number | null = null;
  let precision: number | null = null;
  let f1: number | null = null;
  let recallBySeverity: Record<string, { matched: number; total: number; rate: number }> | null = null;

  if (run.classification && gt) {
    const cls = run.classification.classifications;
    matched = cls.filter((c) => c.category === 'matched').length;
    novel = cls.filter((c) => c.category === 'novel').length;
    fp = cls.filter((c) => c.category === 'fp').length;
    uncertain = cls.filter((c) => c.category === 'uncertain').length;

    const gtCount = gt.findings.length;
    recall = gtCount > 0 ? matched / gtCount : null;

    const totalPositive = matched + fp;
    precision = totalPositive > 0 ? matched / totalPositive : null;

    if (recall !== null && precision !== null && recall + precision > 0) {
      f1 = (2 * recall * precision) / (recall + precision);
    }

    // Per-severity recall
    const matchedGtIds = new Set(cls.filter((c) => c.matchedGtId).map((c) => c.matchedGtId!));
    const severityGroups = new Map<string, { matched: number; total: number }>();
    for (const g of gt.findings) {
      const sev = (g.severity ?? 'unknown').toUpperCase();
      const group = severityGroups.get(sev) ?? { matched: 0, total: 0 };
      group.total++;
      if (matchedGtIds.has(g.id)) group.matched++;
      severityGroups.set(sev, group);
    }
    recallBySeverity = {};
    for (const [sev, group] of severityGroups) {
      recallBySeverity[sev] = {
        matched: group.matched,
        total: group.total,
        rate: group.total > 0 ? group.matched / group.total : 0,
      };
    }
  }

  return {
    runId: run.meta.runId,
    codebaseId: run.meta.codebaseId,
    conditionId: run.meta.conditionId,
    iteration: run.meta.iteration,
    findingsCount: run.parse.findings.length,
    durationMs: run.meta.durationMs,
    costUsd,
    matched,
    novel,
    fp,
    uncertain,
    recall,
    precision,
    f1,
    recallBySeverity,
    parserCoverage:
      run.parse.rawFindingEstimate > 0
        ? run.parse.findings.length / run.parse.rawFindingEstimate
        : null,
  };
}

function jaccardSimilarity(sets: Set<string>[]): number | null {
  if (sets.length < 2) return null;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i]!;
      const b = sets[j]!;
      const intersection = new Set([...a].filter((x) => b.has(x)));
      const union = new Set([...a, ...b]);
      total += union.size === 0 ? 1 : intersection.size / union.size;
      pairs++;
    }
  }
  return pairs > 0 ? total / pairs : null;
}

function getMatchedGtIds(c: RunClassification): Set<string> {
  const ids = new Set<string>();
  for (const cl of c.classifications) {
    if (cl.matchedGtId) ids.add(cl.matchedGtId);
  }
  return ids;
}

// ─── Comparison table ───

function generateComparisonTable(
  runs: RunData[],
  resultsDir: string,
): string[] {
  const lines: string[] = [];

  // Group by codebase → condition
  const byCodebase = new Map<string, Map<string, RunData[]>>();
  for (const run of runs) {
    if (!byCodebase.has(run.meta.codebaseId)) byCodebase.set(run.meta.codebaseId, new Map());
    const byCond = byCodebase.get(run.meta.codebaseId)!;
    const arr = byCond.get(run.meta.conditionId) ?? [];
    arr.push(run);
    byCond.set(run.meta.conditionId, arr);
  }

  for (const [codebaseId, byCondition] of byCodebase) {
    const gt = loadGroundTruth(codebaseId);
    const clusters = loadClusters(resultsDir, codebaseId);
    const validations = loadValidations(resultsDir, codebaseId);

    // Get sorted conditions
    const conditions = [...byCondition.keys()].sort(
      (a, b) => conditionSortIndex(a) - conditionSortIndex(b),
    );
    const condLabels = conditions.map(conditionLabel);

    lines.push(`## Comparison — ${codebaseId}`);
    lines.push('');
    lines.push(`| Metric | ${condLabels.join(' | ')} |`);
    lines.push(`|--------|${condLabels.map(() => '---').join('|')}|`);

    // Compute per-condition metrics (exclude invalid runs from averages)
    const condMetrics = conditions.map((condId) => {
      const condRuns = byCondition.get(condId)!;
      const validRuns = condRuns.filter((r) => !r.invalid);
      const metrics = validRuns.map((r) => computeRunMetrics(r, gt, resultsDir));
      const invalidCount = condRuns.length - validRuns.length;
      return { condId, condRuns, validRuns, metrics, invalidCount };
    });

    // Recall
    if (gt) {
      const cells = condMetrics.map(({ metrics }) => {
        const recalls = metrics.map((m) => m.recall).filter((v): v is number => v !== null);
        if (recalls.length === 0) return '-';
        const matchedCounts = metrics.map((m) => m.matched).filter((v): v is number => v !== null);
        const avgMatched = matchedCounts.reduce((a, b) => a + b, 0) / matchedCounts.length;
        const avgRecallPct = Math.round((avgMatched / gt.findings.length) * 100);
        const matchedDisplay = Number.isInteger(avgMatched) ? String(avgMatched) : avgMatched.toFixed(1);
        return `${matchedDisplay}/${gt.findings.length} (${avgRecallPct}%)`;
      });
      lines.push(`| Recall (GT) | ${cells.join(' | ')} |`);
    }

    // Consistency
    if (gt) {
      const cells = condMetrics.map(({ validRuns }) => {
        const matchedSets = validRuns
          .filter((r) => r.classification)
          .map((r) => getMatchedGtIds(r.classification!));
        const j = jaccardSimilarity(matchedSets);
        return j !== null ? j.toFixed(2) : '-';
      });
      lines.push(`| Consistency | ${cells.join(' | ')} |`);
    }

    // Novel confirmed / plausible
    if (clusters && validations) {
      const confirmedCells = conditions.map((condId) => {
        let count = 0;
        for (const cluster of clusters.clusters) {
          if (!cluster.conditionsCaught.includes(condId)) continue;
          const val = validations.validations.find((v) => v.clusterId === cluster.clusterId);
          if (val?.verdict === 'confirmed') count++;
        }
        return String(count);
      });
      lines.push(`| Novel confirmed | ${confirmedCells.join(' | ')} |`);

      const plausibleCells = conditions.map((condId) => {
        let count = 0;
        for (const cluster of clusters.clusters) {
          if (!cluster.conditionsCaught.includes(condId)) continue;
          const val = validations.validations.find((v) => v.clusterId === cluster.clusterId);
          if (val?.verdict === 'plausible') count++;
        }
        return String(count);
      });
      lines.push(`| Novel plausible | ${plausibleCells.join(' | ')} |`);
    }

    // Total findings (always shown)
    const totalCells = condMetrics.map(({ metrics }) => {
      if (metrics.length === 0) return '-';
      const totals = metrics.map((m) => m.findingsCount);
      const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
      return Number.isInteger(avg) ? String(avg) : avg.toFixed(1);
    });
    lines.push(`| Total findings | ${totalCells.join(' | ')} |`);

    // Unique findings per condition (from clusters — deduplicated by root cause across runs)
    if (clusters) {
      const label = gt ? 'Unique bugs found' : 'Unique findings';
      const bugCells = conditions.map((condId) => {
        let count = 0;
        for (const cluster of clusters.clusters) {
          if (cluster.conditionsCaught.includes(condId)) count++;
        }
        return String(count);
      });
      lines.push(`| ${label} | ${bugCells.join(' | ')} |`);
    }

    // FP / Uncertain
    if (gt) {
      const fpCells = condMetrics.map(({ metrics }) => {
        const fps = metrics.map((m) => m.fp).filter((v): v is number => v !== null);
        if (fps.length === 0) return '-';
        return String(Math.round(fps.reduce((a, b) => a + b, 0) / fps.length));
      });
      lines.push(`| False positives | ${fpCells.join(' | ')} |`);

      const uncCells = condMetrics.map(({ metrics }) => {
        const uncs = metrics.map((m) => m.uncertain).filter((v): v is number => v !== null);
        if (uncs.length === 0) return '-';
        return String(Math.round(uncs.reduce((a, b) => a + b, 0) / uncs.length));
      });
      lines.push(`| Uncertain | ${uncCells.join(' | ')} |`);
    }

    // Cost
    const costCells = condMetrics.map(({ metrics }) => {
      const costs = metrics.map((m) => m.costUsd).filter((v): v is number => v !== null);
      if (costs.length === 0) return '-';
      const avg = costs.reduce((a, b) => a + b, 0) / costs.length;
      return `$${avg.toFixed(2)}`;
    });
    lines.push(`| Avg cost/run | ${costCells.join(' | ')} |`);

    // Duration
    const durCells = condMetrics.map(({ metrics }) => {
      if (metrics.length === 0) return '-';
      const durs = metrics.map((m) => m.durationMs);
      const avg = durs.reduce((a, b) => a + b, 0) / durs.length;
      return formatDuration(avg);
    });
    lines.push(`| Avg duration | ${durCells.join(' | ')} |`);

    lines.push('');

    // Footer: total unique count + disclaimer for no-GT
    if (clusters) {
      const noun = gt ? 'unique bugs' : 'unique findings';
      lines.push(`> **${clusters.uniqueBugs} ${noun}** across all conditions (deduplicated by root cause).`);
    }
    if (!gt) {
      const classifyVotes = parseInt(process.env.CLASSIFY_VOTES || '') || 1;
      const votesLabel = classifyVotes > 1 ? `${classifyVotes}-vote consensus` : '1 Sonnet confirmation';
      lines.push(`> *No ground truth available. Classifications based on ${votesLabel}.*`);
    }
    lines.push('');
  }

  return lines;
}

// ─── Missed GT Findings ───

/**
 * Prominent section listing GT findings missed by ALL conditions.
 * Only emitted for codebases that have ground truth.
 */
function generateMissedGtSection(runs: RunData[]): string[] {
  const lines: string[] = [];

  const byCodebase = new Map<string, RunData[]>();
  for (const run of runs) {
    const arr = byCodebase.get(run.meta.codebaseId) ?? [];
    arr.push(run);
    byCodebase.set(run.meta.codebaseId, arr);
  }

  for (const [codebaseId, codebaseRuns] of byCodebase) {
    const gt = loadGroundTruth(codebaseId);
    if (!gt) continue;

    // Collect all GT IDs matched by any valid run
    const allMatched = new Set<string>();
    for (const run of codebaseRuns) {
      if (run.invalid || !run.classification) continue;
      for (const cl of run.classification.classifications) {
        if (cl.matchedGtId) allMatched.add(cl.matchedGtId);
      }
    }

    const missed = gt.findings.filter((g) => !allMatched.has(g.id));
    if (missed.length === 0) continue;

    lines.push(`## Missed GT Findings — ${codebaseId}`);
    lines.push('');
    lines.push(`${missed.length} of ${gt.findings.length} ground truth findings were missed by all conditions:`);
    lines.push('');
    lines.push('| GT ID | Finding |');
    lines.push('|-------|---------|');
    for (const g of missed) {
      const rawTitle = g.title ?? g.description;
      const title = rawTitle.length > 60 ? rawTitle.slice(0, 57) + '...' : rawTitle;
      lines.push(`| ${g.id} | ${title} |`);
    }
    lines.push('');
  }

  return lines;
}

// ─── Findings Ledger ───

interface LedgerRow {
  title: string;
  /** Per-condition cell: '-' or '✓' or '✓#1#3' */
  conditionCells: Map<string, string>;
  status: string;
  sortKey: number;
  gtId?: string;
}

/**
 * Build a per-condition cell showing which runs found this finding.
 * Returns '-' if not found, '✓' if found in all runs, '✓#1#3' if found in specific runs.
 */
function buildConditionCell(
  foundInIterations: number[],
  totalRunsForCondition: number,
): string {
  if (foundInIterations.length === 0) return '-';
  if (foundInIterations.length === totalRunsForCondition) return '✓';
  const sorted = [...foundInIterations].sort((a, b) => a - b);
  return `✓#${sorted.join('#')}`;
}

/**
 * Build a lookup: conditionId → number of valid runs for that condition in this codebase.
 */
function buildRunCountsByCondition(codebaseRuns: RunData[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of codebaseRuns) {
    if (run.invalid) continue;
    counts.set(run.meta.conditionId, (counts.get(run.meta.conditionId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Build a lookup: runId → iteration number.
 */
function buildRunIdToIteration(codebaseRuns: RunData[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const run of codebaseRuns) {
    map.set(run.meta.runId, run.meta.iteration);
  }
  return map;
}

function generateFindingsLedger(
  runs: RunData[],
  resultsDir: string,
): string[] {
  const lines: string[] = [];

  const byCodebase = new Map<string, RunData[]>();
  for (const run of runs) {
    const arr = byCodebase.get(run.meta.codebaseId) ?? [];
    arr.push(run);
    byCodebase.set(run.meta.codebaseId, arr);
  }

  for (const [codebaseId, codebaseRuns] of byCodebase) {
    const gt = loadGroundTruth(codebaseId);
    const clusters = loadClusters(resultsDir, codebaseId);
    const validations = loadValidations(resultsDir, codebaseId);
    const hasClassifications = codebaseRuns.some((r) => r.classification !== null);

    if (!gt && !hasClassifications && !clusters) continue;

    // Determine which conditions appear for this codebase
    const conditionIds = [...new Set(codebaseRuns.map((r) => r.meta.conditionId))]
      .sort((a, b) => conditionSortIndex(a) - conditionSortIndex(b));
    const condLabels = conditionIds.map(conditionLabel);
    const runCounts = buildRunCountsByCondition(codebaseRuns);
    const runIdToIter = buildRunIdToIteration(codebaseRuns);

    const rows: LedgerRow[] = [];

    // 1. GT findings
    if (gt && hasClassifications) {
      for (const g of gt.findings) {
        // For each condition, find which iterations matched this GT finding
        const conditionCells = new Map<string, string>();
        for (const condId of conditionIds) {
          const iterations: number[] = [];
          for (const run of codebaseRuns) {
            if (run.invalid || run.meta.conditionId !== condId || !run.classification) continue;
            for (const cl of run.classification.classifications) {
              if (cl.matchedGtId === g.id) iterations.push(run.meta.iteration);
            }
          }
          conditionCells.set(condId, buildConditionCell(iterations, runCounts.get(condId) ?? 0));
        }

        const rawTitle = g.title ?? g.description;
        const title = rawTitle.length > 50 ? rawTitle.slice(0, 47) + '...' : rawTitle;

        rows.push({ title, conditionCells, status: g.id, sortKey: 0, gtId: g.id });
      }
    }

    // 2. Novel findings from clusters
    if (clusters && clusters.clusters.length > 0) {
      const valMap = new Map<string, ValidationResult['validations'][number]>();
      if (validations) {
        for (const v of validations.validations) valMap.set(v.clusterId, v);
      }

      for (const c of clusters.clusters) {
        const val = valMap.get(c.clusterId);
        let status: string;
        let sortKey: number;
        if (val) {
          if (val.verdict === 'confirmed') {
            status = 'confirmed';
            sortKey = 1;
          } else if (val.verdict === 'plausible') {
            status = 'plausible';
            sortKey = 2;
          } else {
            status = '~~rejected~~';
            sortKey = 5;
          }
        } else {
          status = 'unvalidated';
          sortKey = 3;
        }

        const title = c.title.length > 50 ? c.title.slice(0, 47) + '...' : c.title;

        // Build per-condition cells from cluster's foundIn data
        const conditionCells = new Map<string, string>();
        for (const condId of conditionIds) {
          const iterations: number[] = [];
          for (const f of c.foundIn) {
            if (f.conditionId !== condId) continue;
            const iter = runIdToIter.get(f.runId);
            if (iter !== undefined) iterations.push(iter);
          }
          // Deduplicate iterations (a cluster can have multiple findings from the same run)
          const unique = [...new Set(iterations)];
          conditionCells.set(condId, buildConditionCell(unique, runCounts.get(condId) ?? 0));
        }

        rows.push({ title, conditionCells, status, sortKey });
      }
    }

    // 3. FP findings (deduplicated by title)
    if (hasClassifications) {
      const fpByTitle = new Map<string, Map<string, number[]>>();
      for (const run of codebaseRuns) {
        if (run.invalid || !run.classification) continue;
        for (const cl of run.classification.classifications) {
          if (cl.category === 'fp') {
            if (!fpByTitle.has(cl.findingTitle)) fpByTitle.set(cl.findingTitle, new Map());
            const condMap = fpByTitle.get(cl.findingTitle)!;
            const iters = condMap.get(run.meta.conditionId) ?? [];
            iters.push(run.meta.iteration);
            condMap.set(run.meta.conditionId, iters);
          }
        }
      }

      for (const [fpTitle, condMap] of fpByTitle) {
        const title = fpTitle.length > 50 ? fpTitle.slice(0, 47) + '...' : fpTitle;
        const conditionCells = new Map<string, string>();
        for (const condId of conditionIds) {
          const iters = condMap.get(condId) ?? [];
          conditionCells.set(condId, buildConditionCell(iters, runCounts.get(condId) ?? 0));
        }
        rows.push({ title, conditionCells, status: 'FP', sortKey: 4 });
      }
    }

    // Sort: GT by ID, then novels by validation status, then FPs, then rejected
    rows.sort((a, b) => {
      if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
      if (a.gtId && b.gtId) return a.gtId.localeCompare(b.gtId, undefined, { numeric: true });
      return 0;
    });

    if (rows.length === 0) continue;

    // Build table
    lines.push(`## Findings Ledger — ${codebaseId}`);
    lines.push('');
    lines.push(`| # | Finding | ${condLabels.join(' | ')} | Status |`);
    lines.push(`|---|---------|${condLabels.map(() => '---').join('|')}|--------|`);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const cells = conditionIds.map((condId) => r.conditionCells.get(condId) ?? '-');
      lines.push(
        `| ${i + 1} | ${r.title} | ${cells.join(' | ')} | ${r.status} |`,
      );
    }
    lines.push('');

    // Footnotes
    const hasUnvalidated = rows.some((r) => r.status === 'unvalidated');
    if (hasUnvalidated) {
      lines.push('> "unvalidated" = novel finding not yet confirmed against source code. Run `npm run analyze` (without `--no-validate`) to validate with Opus.');
    }
    if (gt) {
      lines.push(`> GT findings (${gt.findings.length}) from official C4 audit report. ✓ = found, ✓#N = found in run N only.`);
    } else {
      lines.push('> ✓ = found, ✓#N = found in run N only.');
    }
    lines.push('');
  }

  return lines;
}

// ─── LLM Analysis ───

function buildAnalysisPrompt(
  runs: RunData[],
  resultsDir: string,
): string {
  // Build a compact data summary for the LLM
  const byCodebase = new Map<string, RunData[]>();
  for (const run of runs) {
    const arr = byCodebase.get(run.meta.codebaseId) ?? [];
    arr.push(run);
    byCodebase.set(run.meta.codebaseId, arr);
  }

  const data: any[] = [];
  for (const [codebaseId, codebaseRuns] of byCodebase) {
    const gt = loadGroundTruth(codebaseId);
    const clusters = loadClusters(resultsDir, codebaseId);
    const validations = loadValidations(resultsDir, codebaseId);

    const byCondition = new Map<string, RunData[]>();
    for (const run of codebaseRuns) {
      if (run.invalid) continue; // exclude invalid runs from analysis data
      const arr = byCondition.get(run.meta.conditionId) ?? [];
      arr.push(run);
      byCondition.set(run.meta.conditionId, arr);
    }

    const allMatched = new Set<string>();
    for (const run of codebaseRuns) {
      if (run.invalid || !run.classification) continue;
      for (const cl of run.classification.classifications) {
        if (cl.matchedGtId) allMatched.add(cl.matchedGtId);
      }
    }

    const conditions = [...byCondition.entries()]
      .sort(([a], [b]) => conditionSortIndex(a) - conditionSortIndex(b))
      .map(([condId, condRuns]) => {
        const metrics = condRuns.map((r) => computeRunMetrics(r, gt, resultsDir));
        return {
          conditionId: condId,
          label: conditionLabel(condId),
          runs: metrics.map((m) => ({
            recall: m.recall,
            precision: m.precision,
            matched: m.matched,
            novel: m.novel,
            fp: m.fp,
            uncertain: m.uncertain,
            costUsd: m.costUsd,
            durationMs: m.durationMs,
            findingsCount: m.findingsCount,
          })),
        };
      });

    data.push({
      codebaseId,
      gtCount: gt?.findings.length ?? 0,
      missedByAll: gt?.findings.filter((g) => !allMatched.has(g.id)).map((g) => g.id) ?? [],
      conditions,
      novelClusters: clusters?.uniqueBugs ?? 0,
      validationSummary: validations
        ? { confirmed: validations.confirmed, plausible: validations.plausible, rejected: validations.rejected }
        : null,
    });
  }

  return `You are a senior smart contract security researcher writing the analysis section of a benchmark report comparing LLM-based auditing approaches.

## Benchmark Data

${JSON.stringify(data, null, 2)}

## Task

Write a concise markdown analysis (3 sections):

### 1. Executive Analysis
2-3 paragraphs interpreting the data. What worked, what didn't. Use specific numbers. Don't restate metrics — interpret them.

### 2. Condition Comparison
2-3 sentences per condition: strengths, weaknesses, recall, cost efficiency. Be direct about which is best.

### 3. Recommendation
3-5 bullet points. Which condition should be used? What should change? What's the most interesting finding?

RULES:
- Use specific numbers from the data
- Be brutally honest — if something performs poorly, say so
- No raw data tables — those are in the appendix
- No emojis
- Professional tone
- Output ONLY the markdown, no preamble`;
}

// ─── Deterministic number verification ───

function verifyAnalysisNumbers(analysis: string, _runs: RunData[], _resultsDir: string): string[] {
  const warnings: string[] = [];

  // Extract percentages like "75%", "25%"
  const pctMatches = analysis.matchAll(/(\d+)%/g);
  for (const match of pctMatches) {
    const pct = parseInt(match[1]!, 10);
    // Flag obviously wrong percentages (over 100 or negative context)
    if (pct > 100) {
      warnings.push(`Suspicious percentage: ${pct}% (over 100)`);
    }
  }

  // Extract dollar amounts like "$2.14", "$0.42"
  const dollarMatches = analysis.matchAll(/\$(\d+\.?\d*)/g);
  for (const match of dollarMatches) {
    const amount = parseFloat(match[1]!);
    if (amount > 100) {
      warnings.push(`Suspicious cost: $${amount} (unusually high for a single run)`);
    }
  }

  return warnings;
}

// ─── Data Appendix ───

/**
 * Sort runs by condition (CONDITION_ORDER), then chronologically within each condition.
 * Assign sequential run numbers (#1, #2, ...) per condition from chronological order,
 * ignoring meta.iteration (which resets across separate benchmark invocations).
 */
function sortAndLabelRuns(codebaseRuns: RunData[]): { sorted: RunData[]; labelOf: (run: RunData) => string } {
  // Sort: primary by condition order, secondary by timestamp
  const sorted = [...codebaseRuns].sort((a, b) => {
    const condDiff = conditionSortIndex(a.meta.conditionId) - conditionSortIndex(b.meta.conditionId);
    if (condDiff !== 0) return condDiff;
    return a.meta.timestampUtc.localeCompare(b.meta.timestampUtc);
  });

  // Assign sequential run numbers per condition
  const runNumbers = new Map<string, number>(); // runId → sequential number
  const condCounters = new Map<string, number>();
  const condTotals = new Map<string, number>();

  // Count totals per condition first (to know if we need #N suffix)
  for (const run of sorted) {
    condTotals.set(run.meta.conditionId, (condTotals.get(run.meta.conditionId) ?? 0) + 1);
  }

  for (const run of sorted) {
    const n = (condCounters.get(run.meta.conditionId) ?? 0) + 1;
    condCounters.set(run.meta.conditionId, n);
    runNumbers.set(run.meta.runId, n);
  }

  function labelOf(run: RunData): string {
    const base = conditionLabel(run.meta.conditionId);
    const total = condTotals.get(run.meta.conditionId) ?? 1;
    if (total === 1) return base;
    const n = runNumbers.get(run.meta.runId) ?? 1;
    return `${base} #${n}`;
  }

  return { sorted, labelOf };
}

function generateAppendix(runs: RunData[], resultsDir: string): string[] {
  const lines: string[] = [];

  lines.push('---');
  lines.push('');
  lines.push('# Data Appendix');
  lines.push('');

  const byCodebase = new Map<string, RunData[]>();
  for (const run of runs) {
    const arr = byCodebase.get(run.meta.codebaseId) ?? [];
    arr.push(run);
    byCodebase.set(run.meta.codebaseId, arr);
  }

  for (const [codebaseId, rawCodebaseRuns] of byCodebase) {
    const gt = loadGroundTruth(codebaseId);
    const validations = loadValidations(resultsDir, codebaseId);
    const { sorted: codebaseRuns, labelOf } = sortAndLabelRuns(rawCodebaseRuns);

    lines.push(`## ${codebaseId} — Raw Data`);
    lines.push('');

    // Recall chart (sorted by condition, labeled with #N)
    if (gt) {
      const gtCount = gt.findings.length;
      const maxLabel = Math.max(...codebaseRuns.map((r) => labelOf(r).length), 8);

      lines.push('### Recall');
      lines.push('');
      lines.push('```');
      for (const run of codebaseRuns) {
        const label = labelOf(run).padEnd(maxLabel);
        if (run.invalid) {
          lines.push(`${label} ${'X'.repeat(20)} INVALID`);
          continue;
        }
        if (!run.classification) {
          lines.push(`${label} ${'?'.repeat(20)} ?/${gtCount} (not classified)`);
          continue;
        }
        const matchedIds = getMatchedGtIds(run.classification);
        const matched = gt.findings.filter((g) => matchedIds.has(g.id));
        const pct = gtCount > 0 ? Math.round((matched.length / gtCount) * 100) : 0;
        lines.push(
          `${label} ${bar(matched.length, gtCount)} ${matched.length}/${gtCount} (${pct}%) ${matched.map((g) => g.id).join(', ')}`,
        );
      }
      lines.push('```');
      lines.push('');

      // Classification breakdown (sorted by condition, labeled with #N)
      lines.push('### Classification Breakdown');
      lines.push('');
      lines.push('```');
      for (const run of codebaseRuns) {
        const label = labelOf(run).padEnd(maxLabel);
        if (run.invalid) {
          lines.push(`${label} INVALID — excluded from averages`);
          continue;
        }
        if (!run.classification) {
          lines.push(`${label} ? (not classified)`);
          continue;
        }
        const cls = run.classification.classifications;
        const matched = cls.filter((c) => c.category === 'matched').length;
        const novel = cls.filter((c) => c.category === 'novel').length;
        const fp = cls.filter((c) => c.category === 'fp').length;
        const uncertain = cls.filter((c) => c.category === 'uncertain').length;
        const parts = [`${matched} matched`, `${novel} novel`, `${fp} FP`];
        if (uncertain > 0) parts.push(`${uncertain} uncertain`);
        lines.push(`${label} ${parts.join(' · ')}`);
      }
      lines.push('```');
      lines.push('');

      // Findings matrix (columns sorted by condition, labeled with #N)
      lines.push('### Findings Matrix');
      lines.push('');
      const colHeaders = codebaseRuns.map((r) => labelOf(r));
      lines.push(`| GT | Finding | ${colHeaders.join(' | ')} |`);
      lines.push(`|----|---------|${colHeaders.map(() => '---').join('|')}|`);
      for (const g of gt.findings) {
        const cells = codebaseRuns.map((run) => {
          if (run.invalid) return 'X';
          if (!run.classification) return '?';
          const match = run.classification.classifications.find(
            (cl) => cl.matchedGtId === g.id,
          );
          if (!match) return '-';
          return match.agreement;
        });
        const rawTitle = g.title ?? g.description;
        const title = rawTitle.length > 45 ? rawTitle.slice(0, 42) + '...' : rawTitle;
        lines.push(`| ${g.id} | ${title} | ${cells.join(' | ')} |`);
      }
      lines.push('');
    }

    // Consistency (per GT finding across runs — excludes invalid runs)
    if (gt && codebaseRuns.some((r) => r.classification && !r.invalid)) {
      const byCondition = new Map<string, RunData[]>();
      for (const run of codebaseRuns) {
        if (run.invalid) continue;
        const arr = byCondition.get(run.meta.conditionId) ?? [];
        arr.push(run);
        byCondition.set(run.meta.conditionId, arr);
      }

      const multiRunConditions = [...byCondition.entries()]
        .filter(([, runs]) => runs.length > 1 && runs.some((r) => r.classification))
        .sort(([a], [b]) => conditionSortIndex(a) - conditionSortIndex(b));

      if (multiRunConditions.length > 0) {
        lines.push('### Consistency (multi-run conditions)');
        lines.push('');
        for (const [condId, condRuns] of multiRunConditions) {
          lines.push(`**${conditionLabel(condId)}** (${condRuns.length} runs):`);
          for (const g of gt.findings) {
            let foundCount = 0;
            let totalClassified = 0;
            for (const run of condRuns) {
              if (!run.classification) continue;
              totalClassified++;
              if (getMatchedGtIds(run.classification).has(g.id)) foundCount++;
            }
            if (foundCount === 0) continue;
            const label =
              foundCount === totalClassified
                ? 'RELIABLE'
                : foundCount === 1
                  ? 'INCONSISTENT'
                  : `${foundCount}/${totalClassified}`;
            const gtTitle = (g.title ?? g.description).slice(0, 40);
            lines.push(`- ${label}: ${g.id} (${gtTitle})`);
          }
          lines.push('');
        }
      }
    }

    // Novel validation details
    if (validations && validations.validations.length > 0) {
      lines.push(
        `### Novel Validation (${validations.confirmed} confirmed, ${validations.plausible} plausible, ${validations.rejected} rejected)`,
      );
      lines.push('');
      lines.push('| Cluster | Verdict | Severity | Evidence |');
      lines.push('|---------|---------|----------|----------|');
      for (const v of validations.validations) {
        const verdict =
          v.verdict === 'confirmed'
            ? '**CONFIRMED**'
            : v.verdict === 'rejected'
              ? '~~rejected~~'
              : 'plausible';
        const evidence = (v.codeEvidence ?? '-').slice(0, 60);
        lines.push(`| ${v.title.slice(0, 45)} | ${verdict} | ${v.severity} | ${evidence} |`);
      }
      lines.push('');
    }

    // Per-run overview table (sorted by condition, sequential run numbers)
    lines.push('### Per-Run Overview');
    lines.push('');
    lines.push('| Run | Condition | Findings | Duration | Cost |');
    lines.push('|-----|-----------|----------|----------|------|');
    for (const run of codebaseRuns) {
      const label = labelOf(run);
      const dur = formatDuration(run.meta.durationMs);
      const cost = extractCostFromEvents(resultsDir, run.meta.runId);
      const costStr = cost !== null ? `$${cost.toFixed(2)}` : '-';
      const suffix = run.invalid
        ? ` (INVALID: ${run.invalid})`
        : run.meta.timedOut
          ? ' (timeout)'
          : '';
      // Extract run number from label (e.g., "V2 #2" → "2", "V1" → "1")
      const runNumMatch = label.match(/#(\d+)$/);
      const runNum = runNumMatch ? runNumMatch[1] : '1';
      lines.push(
        `| ${runNum} | ${conditionLabel(run.meta.conditionId)} | ${run.parse.findings.length} | ${dur}${suffix} | ${costStr} |`,
      );
    }
    lines.push('');
  }

  return lines;
}

// ─── Pipeline Integrity Check ───

/**
 * Hard invariant: for every classified run, the sum of categories must equal
 * the number of parsed findings. Any mismatch means the pipeline is silently
 * dropping or duplicating findings.
 */
function checkFindingsIntegrity(runs: RunData[]): string[] {
  const lines: string[] = [];
  const violations: string[] = [];

  for (const run of runs) {
    if (!run.classification) continue;

    const parsed = run.parse.findings.length;
    const classified = run.classification.classifications.length;
    const matched = run.classification.classifications.filter((c) => c.category === 'matched').length;
    const novel = run.classification.classifications.filter((c) => c.category === 'novel').length;
    const fp = run.classification.classifications.filter((c) => c.category === 'fp').length;
    const uncertain = run.classification.classifications.filter((c) => c.category === 'uncertain').length;
    const categorySum = matched + novel + fp + uncertain;

    // Check 1: classified count must equal parsed count
    // (allowing for LLM-recovered findings which increase parsed count)
    if (classified !== parsed && classified < parsed) {
      violations.push(
        `${conditionLabel(run.meta.conditionId)} run ${run.meta.iteration}: ` +
        `parsed ${parsed} findings but only ${classified} classified (${parsed - classified} lost)`,
      );
    }

    // Check 2: category sum must equal classified count
    if (categorySum !== classified) {
      violations.push(
        `${conditionLabel(run.meta.conditionId)} run ${run.meta.iteration}: ` +
        `${classified} classified but categories sum to ${categorySum} ` +
        `(${matched}m + ${novel}n + ${fp}fp + ${uncertain}u)`,
      );
    }
  }

  lines.push('## Pipeline Integrity');
  lines.push('');
  if (violations.length === 0) {
    lines.push('All findings accounted for. Category sums match parsed counts across all runs.');
  } else {
    lines.push('**INTEGRITY VIOLATIONS DETECTED:**');
    lines.push('');
    for (const v of violations) {
      lines.push(`- ${v}`);
    }
  }
  lines.push('');

  // Log violations as errors
  if (violations.length > 0) {
    log.error(`INTEGRITY CHECK FAILED: ${violations.length} violation(s)`);
    for (const v of violations) log.error(`  ${v}`);
  }

  return lines;
}

// ─── Main report generation ───

export async function generateReport(
  resultsDir: string,
  options: ReportOptions,
): Promise<void> {
  const allRuns = loadValidRuns(resultsDir);
  if (allRuns.length === 0) {
    log.warn('No results found');
    return;
  }

  const runs = options.latest ? filterLatestRuns(allRuns) : allRuns;
  const invalidCount = runs.filter((r) => r.invalid).length;
  const validCount = runs.length - invalidCount;
  log.info(`Generating report from ${runs.length} run(s) (${validCount} valid, ${invalidCount} invalid)`);
  if (invalidCount > 0) {
    for (const r of runs.filter((r) => r.invalid)) {
      log.warn(`  INVALID: ${r.meta.conditionId} iter ${r.meta.iteration} — ${r.invalid}`);
    }
  }

  const reportLines: string[] = [];

  // Header
  reportLines.push('# Benchmark Report');
  reportLines.push('');
  reportLines.push(
    `> Generated: ${new Date().toISOString().split('T')[0]} | ${options.latest ? 'Latest run per condition' : 'All runs'}`,
  );
  reportLines.push('');

  // Comparison table
  const compTable = generateComparisonTable(runs, resultsDir);
  reportLines.push(...compTable);

  // Missed GT findings (prominent, between comparison and ledger)
  const missedLines = generateMissedGtSection(runs);
  reportLines.push(...missedLines);

  // Findings ledger
  const ledger = generateFindingsLedger(runs, resultsDir);
  reportLines.push(...ledger);

  // LLM analysis
  log.info('Generating LLM analysis...');
  try {
    const prompt = buildAnalysisPrompt(runs, resultsDir);
    log.info(`  Prompt: ${Math.round(prompt.length / 1024)}KB`);
    const analysis = await callLLMRaw(prompt, ANALYST_MODEL, ANALYST_TIMEOUT);

    if (analysis && analysis.trim().length > 0) {
      // Deterministic number verification
      const warnings = verifyAnalysisNumbers(analysis, runs, resultsDir);
      if (warnings.length > 0) {
        reportLines.push(`*Analysis status: ${warnings.length} number warning(s) — see appendix*`);
      } else {
        reportLines.push('*Analysis status: numbers verified*');
      }
      reportLines.push('');
      reportLines.push(analysis);
      reportLines.push('');
    } else {
      reportLines.push('*Analysis: generation returned empty — see data appendix*');
      reportLines.push('');
    }
  } catch (err) {
    const msg = err instanceof LLMError ? err.message : String(err);
    log.warn(`Analysis failed: ${msg}`);
    reportLines.push('*Analysis: generation failed — see data appendix*');
    reportLines.push('');
  }

  // Pipeline integrity check — findings count invariant
  const integrityLines = checkFindingsIntegrity(runs);
  reportLines.push(...integrityLines);

  // Deterministic appendix
  const appendix = generateAppendix(runs, resultsDir);
  reportLines.push(...appendix);

  // Write
  const outputPath = path.resolve(process.cwd(), 'summary.md');
  const content = reportLines.join('\n');
  fs.writeFileSync(outputPath, content);
  log.success(`Report written to ${outputPath} (${reportLines.length} lines)`);
}
