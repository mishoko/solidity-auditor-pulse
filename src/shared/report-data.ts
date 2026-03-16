/**
 * Shared report data — single source of truth for all renderers.
 *
 * Computed once by the report pipeline, written to report-data.json,
 * consumed by both summary.md renderer and dashboard.html renderer.
 *
 * No renderer should compute metrics — only read from this structure.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  RunMeta,
  GroundTruth,
  RunClassification,
  ClusterResult,
  ValidationResult,
} from './types.js';
import { parseOutput, type ParseResult } from './parser.js';

// ─── Report Data Types ───

/** Per-run computed metrics. */
export interface RunEntry {
  runId: string;
  codebaseId: string;
  conditionId: string;
  iteration: number;
  /** Sequential run number per condition (1-based, chronological). */
  runNumber: number;
  durationMs: number;
  costUsd: number | null;
  timedOut: boolean;
  findingsCount: number;
  /** Run excluded from metric averages (corrupt/empty). */
  invalid: string | undefined;
  // Classification breakdown (null if not classified)
  matched: number | null;
  novel: number | null;
  fp: number | null;
  uncertain: number | null;
  recall: number | null;
  precision: number | null;
  /** Matched GT IDs for this run. */
  matchedGtIds: string[];
}

/** Per-condition aggregate metrics within a codebase. */
export interface ConditionAggregate {
  conditionId: string;
  label: string;
  validRuns: number;
  totalRuns: number;
  // GT metrics (null if no GT for this codebase)
  avgRecall: number | null;
  avgMatched: number | null;
  gtTotal: number | null;
  consistency: number | null;
  // Findings
  avgFindingsCount: number | null;
  totalFp: number;
  avgFp: number | null;
  totalFindings: number;
  fpRate: number | null;
  avgUncertain: number | null;
  // Novel findings from validation
  confirmedNovels: number;
  /** Confirmed novels excluding centralization-risk and informational. */
  confirmedNovelsFiltered: number;
  plausibleNovels: number;
  /** Plausible novels excluding centralization-risk and informational. */
  plausibleNovelsFiltered: number;
  uniqueBugsFound: number;
  // Cost & duration
  avgCost: number | null;
  avgDurationMs: number | null;
}

/** Findings ledger row (GT match, novel cluster, or FP). */
export interface LedgerRow {
  title: string;
  /** Per-condition cell: '-' or '✓' or '✓#1#3' */
  conditionCells: Record<string, string>;
  status: string;
  sortKey: number;
  gtId?: string;
}

/** GT finding that was missed by all conditions. */
export interface MissedGtFinding {
  id: string;
  title: string;
}

/** Validation detail for novel clusters. */
export interface ValidationEntry {
  clusterId: string;
  title: string;
  verdict: 'confirmed' | 'plausible' | 'rejected';
  severity: string;
  codeEvidence: string;
  reasoning: string;
  riskCategory?: 'centralization-risk' | 'informational';
}

/** Per-GT-finding consistency detail across runs. */
export interface ConsistencyEntry {
  conditionId: string;
  conditionLabel: string;
  totalRuns: number;
  findings: Array<{
    gtId: string;
    gtTitle: string;
    foundCount: number;
    totalClassified: number;
    label: string; // 'RELIABLE' | 'INCONSISTENT' | 'N/M'
  }>;
}

/** Findings matrix row (one per GT finding). */
export interface FindingsMatrixRow {
  gtId: string;
  title: string;
  /** Per-run cells: runId → agreement string or '-' or 'X' (invalid) or '?' (unclassified). */
  cells: Record<string, string>;
}

/** Per-codebase data block. */
export interface CodebaseData {
  codebaseId: string;
  hasGt: boolean;
  gtTotal: number;
  conditions: string[];
  conditionLabels: string[];
  aggregates: ConditionAggregate[];
  runs: RunEntry[];
  ledger: LedgerRow[];
  missedGt: MissedGtFinding[];
  validations: ValidationEntry[];
  validationSummary: { confirmed: number; plausible: number; rejected: number } | null;
  uniqueBugsTotal: number;
  /** Findings matrix (only for GT codebases). */
  findingsMatrix: FindingsMatrixRow[];
  /** Consistency detail (only for multi-run GT codebases). */
  consistency: ConsistencyEntry[];
}

/** Cross-codebase aggregate for dashboard display. */
export interface CrossCodebaseAggregate {
  conditionId: string;
  label: string;
  subtitle: string;
  validRuns: number;
  avgRecall: number | null;
  gtTotal: number | null;
  confirmedNovels: number;
  confirmedNovelsFiltered: number;
  plausibleNovelsFiltered: number;
  fpRate: number | null;
  consistency: number | null;
  avgCost: number | null;
  avgDurationMs: number | null;
}

/** Per-metric best condition IDs (for highlighting in renderers). */
export interface MetricBests {
  recall: string[];
  confirmedNovelsFiltered: string[];
  fpRate: string[];
  consistency: string[];
  avgCost: string[];
  avgDuration: string[];
}

/** Top-level report data — the shared feed. */
export interface ReportData {
  generatedAt: string;
  mode: 'all' | 'latest';
  totalRuns: number;
  validRuns: number;
  invalidRuns: number;
  codebaseIds: string[];
  codebases: CodebaseData[];
  /** Overall GT missed by all across all codebases. */
  gtMissedByAllTotal: number;
  gtTotalAll: number;
  gtMissedByAllPercent: number;
  /** Cross-codebase aggregates for dashboard. */
  crossCodebaseAggregates: CrossCodebaseAggregate[];
  /** Total confirmed novels excluded by risk category filtering (across all conditions). */
  totalExcludedByRiskCategory: number;
  /** Per-metric best condition IDs. */
  metricBests: MetricBests;
  /** Integrity violations. */
  integrityViolations: string[];
}

// ─── Constants ───

const CONDITION_ORDER: { id: string; label: string; subtitle: string }[] = [
  { id: 'skill_v2', label: 'V2', subtitle: '5 agents + FP gate' },
  { id: 'skill_v1_default', label: 'V1', subtitle: '4 agents (Sonnet)' },
  { id: 'skill_v1_deep', label: 'V1 Deep', subtitle: '+ adversarial (Opus)' },
  { id: 'bare_audit', label: 'Bare CC', subtitle: 'No skill, audit prompt only' },
];

function conditionLabel(id: string): string {
  return CONDITION_ORDER.find((c) => c.id === id)?.label ?? id;
}

function conditionSubtitle(id: string): string {
  return CONDITION_ORDER.find((c) => c.id === id)?.subtitle ?? '';
}

function conditionSortIndex(id: string): number {
  const idx = CONDITION_ORDER.findIndex((c) => c.id === id);
  return idx >= 0 ? idx : 999;
}

const MIN_SKILL_FINDINGS = 1;
const MIN_SKILL_STDOUT_CHARS = 500;

// ─── Internal types ───

interface LoadedRun {
  meta: RunMeta;
  parse: ParseResult;
  classification: RunClassification | null;
  invalid?: string;
  costUsd: number | null;
}

// ─── Data loading ───

function loadJSON<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function detectInvalidRun(meta: RunMeta, text: string, findingsCount: number): string | undefined {
  if (meta.mode === 'skill' && findingsCount < MIN_SKILL_FINDINGS) {
    return `skill run produced ${findingsCount} findings (expected ≥${MIN_SKILL_FINDINGS})`;
  }
  if (meta.mode === 'skill' && text.length < MIN_SKILL_STDOUT_CHARS) {
    return `stdout only ${text.length} chars (expected ≥${MIN_SKILL_STDOUT_CHARS} for skill run)`;
  }
  return undefined;
}

function loadAllRuns(resultsDir: string): LoadedRun[] {
  const metaFiles = fs.readdirSync(resultsDir).filter((f) => f.endsWith('.meta.json'));
  const runs: LoadedRun[] = [];

  for (const file of metaFiles) {
    const meta = loadJSON<RunMeta>(path.join(resultsDir, file));
    if (!meta) continue;
    if (meta.exitCode !== 0 && meta.exitCode !== 143) continue;

    const stdoutFile = path.join(resultsDir, `${meta.runId}.stdout.txt`);
    if (!fs.existsSync(stdoutFile)) continue;

    const text = fs.readFileSync(stdoutFile, 'utf8');
    const parse = parseOutput(text);
    const findingsCount = parse.findings.length;

    const classFile = path.join(resultsDir, `${meta.runId}.classifications.json`);
    const classification = loadJSON<RunClassification>(classFile);

    const invalid = detectInvalidRun(meta, text, findingsCount);
    const costUsd = extractCostFromEvents(resultsDir, meta.runId);

    runs.push({ meta, parse, classification, invalid, costUsd });
  }

  runs.sort((a, b) => a.meta.timestampUtc.localeCompare(b.meta.timestampUtc));
  return runs;
}

function filterLatestRuns(runs: LoadedRun[]): LoadedRun[] {
  const latest = new Map<string, LoadedRun>();
  for (const run of runs) {
    const key = `${run.meta.codebaseId}::${run.meta.conditionId}`;
    const existing = latest.get(key);
    if (!existing || run.meta.timestampUtc > existing.meta.timestampUtc) {
      latest.set(key, run);
    }
  }
  return [...latest.values()];
}

// ─── Metric computation ───

function getMatchedGtIds(c: RunClassification): Set<string> {
  const ids = new Set<string>();
  for (const cl of c.classifications) {
    if (cl.matchedGtId) ids.add(cl.matchedGtId);
  }
  return ids;
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

function buildConditionCell(
  foundInIterations: number[],
  totalRunsForCondition: number,
): string {
  if (foundInIterations.length === 0) return '-';
  if (foundInIterations.length === totalRunsForCondition) return '✓';
  const sorted = [...foundInIterations].sort((a, b) => a - b);
  return `✓#${sorted.join('#')}`;
}

// ─── Main computation ───

export function computeReportData(
  resultsDir: string,
  options: { latest: boolean },
): ReportData | null {
  const gtDir = path.resolve(resultsDir, '..', 'ground_truth');

  const allRuns = loadAllRuns(resultsDir);
  if (allRuns.length === 0) return null;

  const runs = options.latest ? filterLatestRuns(allRuns) : allRuns;
  const invalidCount = runs.filter((r) => r.invalid).length;

  // Discover codebases
  const codebaseIds = [...new Set(runs.map((r) => r.meta.codebaseId))].sort();

  // Build per-codebase data
  const codebases: CodebaseData[] = [];
  let gtMissedByAllTotal = 0;
  let gtTotalAll = 0;

  for (const codebaseId of codebaseIds) {
    const codebaseRuns = runs.filter((r) => r.meta.codebaseId === codebaseId);

    // Load GT, clusters, validations
    const gt = loadJSON<GroundTruth>(path.join(gtDir, `${codebaseId}.json`));
    const clusters =
      loadJSON<ClusterResult>(path.join(resultsDir, `clusters-${codebaseId}.json`)) ??
      loadJSON<ClusterResult>(path.join(resultsDir, `novel-clusters-${codebaseId}.json`));
    const validationsData = loadJSON<ValidationResult>(path.join(resultsDir, `validations-${codebaseId}.json`));

    // Sort runs by condition then timestamp, assign sequential run numbers
    const sorted = [...codebaseRuns].sort((a, b) => {
      const condDiff = conditionSortIndex(a.meta.conditionId) - conditionSortIndex(b.meta.conditionId);
      if (condDiff !== 0) return condDiff;
      return a.meta.timestampUtc.localeCompare(b.meta.timestampUtc);
    });

    const runNumbers = new Map<string, number>();
    const condCounters = new Map<string, number>();
    for (const run of sorted) {
      const n = (condCounters.get(run.meta.conditionId) ?? 0) + 1;
      condCounters.set(run.meta.conditionId, n);
      runNumbers.set(run.meta.runId, n);
    }

    // Get sorted conditions for this codebase
    const conditionIds = [...new Set(codebaseRuns.map((r) => r.meta.conditionId))]
      .sort((a, b) => conditionSortIndex(a) - conditionSortIndex(b));
    const condLabels = conditionIds.map(conditionLabel);

    // Build RunEntry array
    const runEntries: RunEntry[] = sorted.map((run) => {
      const cls = run.classification?.classifications;
      let matched: number | null = null;
      let novel: number | null = null;
      let fp: number | null = null;
      let uncertain: number | null = null;
      let recall: number | null = null;
      let precision: number | null = null;
      let matchedGtIds: string[] = [];

      if (cls && gt) {
        matched = cls.filter((c) => c.category === 'matched').length;
        novel = cls.filter((c) => c.category === 'novel').length;
        fp = cls.filter((c) => c.category === 'fp').length;
        uncertain = cls.filter((c) => c.category === 'uncertain').length;
        recall = gt.findings.length > 0 ? matched / gt.findings.length : null;
        const totalPositive = matched + fp;
        precision = totalPositive > 0 ? matched / totalPositive : null;
        // Preserve GT finding order (for deterministic display in recall charts)
        const gtOrder = gt.findings.map((g) => g.id);
        matchedGtIds = cls
          .filter((c) => c.matchedGtId)
          .map((c) => c.matchedGtId!)
          .sort((a, b) => gtOrder.indexOf(a) - gtOrder.indexOf(b));
      } else if (cls) {
        // No GT — still count categories
        matched = cls.filter((c) => c.category === 'matched').length;
        novel = cls.filter((c) => c.category === 'novel').length;
        fp = cls.filter((c) => c.category === 'fp').length;
        uncertain = cls.filter((c) => c.category === 'uncertain').length;
      }

      return {
        runId: run.meta.runId,
        codebaseId: run.meta.codebaseId,
        conditionId: run.meta.conditionId,
        iteration: run.meta.iteration,
        runNumber: runNumbers.get(run.meta.runId) ?? 1,
        durationMs: run.meta.durationMs,
        costUsd: run.costUsd,
        timedOut: run.meta.timedOut ?? false,
        findingsCount: run.parse.findings.length,
        invalid: run.invalid,
        matched,
        novel,
        fp,
        uncertain,
        recall,
        precision,
        matchedGtIds,
      };
    });

    // Compute per-condition aggregates
    const aggregates: ConditionAggregate[] = conditionIds.map((condId) => {
      const condRuns = runEntries.filter((r) => r.conditionId === condId);
      const validRuns = condRuns.filter((r) => !r.invalid);

      // GT metrics
      let avgRecall: number | null = null;
      let avgMatched: number | null = null;
      let consistency: number | null = null;

      if (gt) {
        const matchedCounts = validRuns.map((r) => r.matched).filter((v): v is number => v !== null);
        if (matchedCounts.length > 0) {
          avgMatched = matchedCounts.reduce((a, b) => a + b, 0) / matchedCounts.length;
          avgRecall = gt.findings.length > 0 ? avgMatched / gt.findings.length : null;
        }

        const matchedSets = validRuns
          .filter((r) => r.matchedGtIds.length > 0 || r.matched !== null)
          .map((r) => new Set(r.matchedGtIds));
        consistency = jaccardSimilarity(matchedSets);
      }

      // FP rate
      let totalFp = 0;
      let totalFindings = 0;
      for (const r of validRuns) {
        if (r.fp !== null) totalFp += r.fp;
        if (r.matched !== null || r.novel !== null || r.fp !== null) {
          totalFindings += (r.matched ?? 0) + (r.novel ?? 0) + (r.fp ?? 0) + (r.uncertain ?? 0);
        }
      }
      const fpRate = totalFindings > 0 ? totalFp / totalFindings : null;
      const avgFp = validRuns.length > 0 ? totalFp / validRuns.length : null;

      // Novel findings from validation
      let confirmedNovels = 0;
      let confirmedNovelsFiltered = 0;
      let plausibleNovels = 0;
      let plausibleNovelsFiltered = 0;
      let uniqueBugsFound = 0;
      if (clusters && validationsData) {
        for (const cluster of clusters.clusters) {
          if (!cluster.conditionsCaught.includes(condId)) continue;
          uniqueBugsFound++;
          const val = validationsData.validations.find((v) => v.clusterId === cluster.clusterId);
          if (val?.verdict === 'confirmed') {
            confirmedNovels++;
            if (!val.riskCategory) confirmedNovelsFiltered++;
          }
          if (val?.verdict === 'plausible') {
            plausibleNovels++;
            if (!val.riskCategory) plausibleNovelsFiltered++;
          }
        }
      } else if (clusters) {
        for (const cluster of clusters.clusters) {
          if (cluster.conditionsCaught.includes(condId)) uniqueBugsFound++;
        }
      }

      // Cost & duration
      const costs = validRuns.map((r) => r.costUsd).filter((c): c is number => c !== null);
      const durations = validRuns.map((r) => r.durationMs);
      const avgFindings = validRuns.length > 0
        ? validRuns.reduce((a, r) => a + r.findingsCount, 0) / validRuns.length
        : null;

      // Uncertain average
      const uncertainCounts = validRuns.map((r) => r.uncertain).filter((v): v is number => v !== null);
      const avgUncertain = uncertainCounts.length > 0
        ? uncertainCounts.reduce((a, b) => a + b, 0) / uncertainCounts.length
        : null;

      return {
        conditionId: condId,
        label: conditionLabel(condId),
        validRuns: validRuns.length,
        totalRuns: condRuns.length,
        avgRecall,
        avgMatched,
        gtTotal: gt ? gt.findings.length : null,
        consistency,
        avgFindingsCount: avgFindings,
        totalFp,
        avgFp,
        totalFindings,
        fpRate,
        avgUncertain,
        confirmedNovels,
        confirmedNovelsFiltered,
        plausibleNovels,
        plausibleNovelsFiltered,
        uniqueBugsFound,
        avgCost: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
        avgDurationMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      };
    });

    // Missed GT findings
    const missedGt: MissedGtFinding[] = [];
    if (gt) {
      gtTotalAll += gt.findings.length;
      const allMatchedIds = new Set<string>();
      for (const run of runEntries) {
        if (run.invalid) continue;
        for (const id of run.matchedGtIds) allMatchedIds.add(id);
      }
      for (const g of gt.findings) {
        if (!allMatchedIds.has(g.id)) {
          const rawTitle = g.title ?? g.description;
          missedGt.push({ id: g.id, title: rawTitle });
          gtMissedByAllTotal++;
        }
      }
    }

    // Findings ledger
    const runCounts = new Map<string, number>();
    for (const r of runEntries) {
      if (r.invalid) continue;
      runCounts.set(r.conditionId, (runCounts.get(r.conditionId) ?? 0) + 1);
    }

    const ledger: LedgerRow[] = [];

    // 1. GT findings
    if (gt) {
      for (const g of gt.findings) {
        const conditionCells: Record<string, string> = {};
        for (const condId of conditionIds) {
          const iterations: number[] = [];
          for (const r of runEntries) {
            if (r.invalid || r.conditionId !== condId) continue;
            if (r.matchedGtIds.includes(g.id)) iterations.push(r.runNumber);
          }
          conditionCells[condId] = buildConditionCell(iterations, runCounts.get(condId) ?? 0);
        }
        const rawTitle = g.title ?? g.description;
        const title = rawTitle.length > 50 ? rawTitle.slice(0, 47) + '...' : rawTitle;
        ledger.push({ title, conditionCells, status: g.id, sortKey: 0, gtId: g.id });
      }
    }

    // 2. Novel findings from clusters
    if (clusters && clusters.clusters.length > 0) {
      const valMap = new Map<string, ValidationResult['validations'][number]>();
      if (validationsData) {
        for (const v of validationsData.validations) valMap.set(v.clusterId, v);
      }

      for (const c of clusters.clusters) {
        const val = valMap.get(c.clusterId);
        let status: string;
        let sortKey: number;
        if (val) {
          if (val.verdict === 'confirmed') { status = 'confirmed'; sortKey = 1; }
          else if (val.verdict === 'plausible') { status = 'plausible'; sortKey = 2; }
          else { status = '~~rejected~~'; sortKey = 5; }
        } else {
          status = 'unvalidated';
          sortKey = 3;
        }

        const title = c.title.length > 50 ? c.title.slice(0, 47) + '...' : c.title;

        const conditionCells: Record<string, string> = {};
        for (const condId of conditionIds) {
          const iterations: number[] = [];
          for (const f of c.foundIn) {
            if (f.conditionId !== condId) continue;
            const rn = runNumbers.get(f.runId);
            if (rn !== undefined) iterations.push(rn);
          }
          const unique = [...new Set(iterations)];
          conditionCells[condId] = buildConditionCell(unique, runCounts.get(condId) ?? 0);
        }

        ledger.push({ title, conditionCells, status, sortKey });
      }
    }

    // 3. FP findings (deduplicated by title)
    {
      const fpByTitle = new Map<string, Map<string, number[]>>();
      for (const run of sorted) {
        if (run.invalid || !run.classification) continue;
        for (const cl of run.classification.classifications) {
          if (cl.category === 'fp') {
            if (!fpByTitle.has(cl.findingTitle)) fpByTitle.set(cl.findingTitle, new Map());
            const condMap = fpByTitle.get(cl.findingTitle)!;
            const iters = condMap.get(run.meta.conditionId) ?? [];
            iters.push(runNumbers.get(run.meta.runId) ?? 1);
            condMap.set(run.meta.conditionId, iters);
          }
        }
      }

      for (const [fpTitle, condMap] of fpByTitle) {
        const title = fpTitle.length > 50 ? fpTitle.slice(0, 47) + '...' : fpTitle;
        const conditionCells: Record<string, string> = {};
        for (const condId of conditionIds) {
          const iters = condMap.get(condId) ?? [];
          conditionCells[condId] = buildConditionCell(iters, runCounts.get(condId) ?? 0);
        }
        ledger.push({ title, conditionCells, status: 'FP', sortKey: 4 });
      }
    }

    // Sort ledger: by sortKey, then GT ID (for GT rows), then title (for stability)
    ledger.sort((a, b) => {
      if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
      if (a.gtId && b.gtId) return a.gtId.localeCompare(b.gtId, undefined, { numeric: true });
      return a.title.localeCompare(b.title);
    });

    // Validation entries
    const validationEntries: ValidationEntry[] = validationsData?.validations.map((v) => ({
      clusterId: v.clusterId,
      title: v.title,
      verdict: v.verdict,
      severity: v.severity,
      codeEvidence: v.codeEvidence ?? '-',
      reasoning: v.reasoning,
      riskCategory: v.riskCategory,
    })) ?? [];

    // Findings matrix (GT codebases only)
    const findingsMatrix: FindingsMatrixRow[] = [];
    if (gt) {
      for (const g of gt.findings) {
        const cells: Record<string, string> = {};
        for (const run of sorted) {
          if (run.invalid) {
            cells[run.meta.runId] = 'X';
            continue;
          }
          if (!run.classification) {
            cells[run.meta.runId] = '?';
            continue;
          }
          const match = run.classification.classifications.find(
            (cl) => cl.matchedGtId === g.id,
          );
          cells[run.meta.runId] = match ? match.agreement : '-';
        }
        const rawTitle = g.title ?? g.description;
        const title = rawTitle.length > 45 ? rawTitle.slice(0, 42) + '...' : rawTitle;
        findingsMatrix.push({ gtId: g.id, title, cells });
      }
    }

    // Consistency detail
    const consistencyEntries: ConsistencyEntry[] = [];
    if (gt) {
      const byCondition = new Map<string, LoadedRun[]>();
      for (const run of sorted) {
        if (run.invalid) continue;
        const arr = byCondition.get(run.meta.conditionId) ?? [];
        arr.push(run);
        byCondition.set(run.meta.conditionId, arr);
      }

      const multiRunConditions = [...byCondition.entries()]
        .filter(([, condRuns]) => condRuns.length > 1 && condRuns.some((r) => r.classification))
        .sort(([a], [b]) => conditionSortIndex(a) - conditionSortIndex(b));

      for (const [condId, condRuns] of multiRunConditions) {
        const findings: ConsistencyEntry['findings'] = [];
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
          findings.push({ gtId: g.id, gtTitle, foundCount, totalClassified, label });
        }
        consistencyEntries.push({
          conditionId: condId,
          conditionLabel: conditionLabel(condId),
          totalRuns: condRuns.length,
          findings,
        });
      }
    }

    codebases.push({
      codebaseId,
      hasGt: gt !== null,
      gtTotal: gt?.findings.length ?? 0,
      conditions: conditionIds,
      conditionLabels: condLabels,
      aggregates,
      runs: runEntries,
      ledger,
      missedGt,
      validations: validationEntries,
      validationSummary: validationsData
        ? { confirmed: validationsData.confirmed, plausible: validationsData.plausible, rejected: validationsData.rejected }
        : null,
      uniqueBugsTotal: clusters?.uniqueBugs ?? 0,
      findingsMatrix,
      consistency: consistencyEntries,
    });
  }

  // Integrity check
  const integrityViolations: string[] = [];
  for (const run of runs) {
    if (!run.classification) continue;
    const parsed = run.parse.findings.length;
    const classified = run.classification.classifications.length;
    const matched = run.classification.classifications.filter((c) => c.category === 'matched').length;
    const novel = run.classification.classifications.filter((c) => c.category === 'novel').length;
    const fp = run.classification.classifications.filter((c) => c.category === 'fp').length;
    const uncertain = run.classification.classifications.filter((c) => c.category === 'uncertain').length;
    const categorySum = matched + novel + fp + uncertain;

    if (classified !== parsed && classified < parsed) {
      integrityViolations.push(
        `${conditionLabel(run.meta.conditionId)} run ${run.meta.iteration}: ` +
        `parsed ${parsed} findings but only ${classified} classified (${parsed - classified} lost)`,
      );
    }
    if (categorySum !== classified) {
      integrityViolations.push(
        `${conditionLabel(run.meta.conditionId)} run ${run.meta.iteration}: ` +
        `${classified} classified but categories sum to ${categorySum} ` +
        `(${matched}m + ${novel}n + ${fp}fp + ${uncertain}u)`,
      );
    }
  }

  // ── Cross-codebase aggregates (for dashboard) ──

  const allConditionIds = [...new Set(codebases.flatMap((cb) => cb.conditions))];
  const crossAggregates: CrossCodebaseAggregate[] = allConditionIds
    .sort((a, b) => conditionSortIndex(a) - conditionSortIndex(b))
    .map((condId) => {
      const perCb = codebases
        .map((cb) => cb.aggregates.find((a) => a.conditionId === condId))
        .filter((a): a is ConditionAggregate => a !== undefined);

      // Weighted recall across GT codebases
      const gtAggs = perCb.filter((a) => a.avgRecall !== null && a.gtTotal !== null);
      let avgRecall: number | null = null;
      let crossGtTotal: number | null = null;
      if (gtAggs.length > 0) {
        const totalMatched = gtAggs.reduce((sum, a) => sum + (a.avgMatched ?? 0), 0);
        const totalGt = gtAggs.reduce((sum, a) => sum + (a.gtTotal ?? 0), 0);
        avgRecall = totalGt > 0 ? totalMatched / totalGt : null;
        crossGtTotal = totalGt;
      }

      const confirmedNovels = perCb.reduce((sum, a) => sum + a.confirmedNovels, 0);
      const confirmedNovelsFiltered = perCb.reduce((sum, a) => sum + a.confirmedNovelsFiltered, 0);
      const plausibleNovelsFiltered = perCb.reduce((sum, a) => sum + a.plausibleNovelsFiltered, 0);

      const totalFp = perCb.reduce((sum, a) => sum + a.totalFp, 0);
      const totalFindings = perCb.reduce((sum, a) => sum + a.totalFindings, 0);
      const fpRate = totalFindings > 0 ? totalFp / totalFindings : null;

      const consAggs = perCb.filter((a) => a.consistency !== null);
      const consistency = consAggs.length > 0
        ? consAggs.reduce((sum, a) => sum + a.consistency!, 0) / consAggs.length
        : null;

      const validRuns = perCb.reduce((sum, a) => sum + a.validRuns, 0);

      const costAggs = perCb.filter((a) => a.avgCost !== null && a.validRuns > 0);
      const avgCost = costAggs.length > 0
        ? costAggs.reduce((sum, a) => sum + a.avgCost! * a.validRuns, 0) /
          costAggs.reduce((sum, a) => sum + a.validRuns, 0)
        : null;

      const durAggs = perCb.filter((a) => a.avgDurationMs !== null && a.validRuns > 0);
      const avgDurationMs = durAggs.length > 0
        ? durAggs.reduce((sum, a) => sum + a.avgDurationMs! * a.validRuns, 0) /
          durAggs.reduce((sum, a) => sum + a.validRuns, 0)
        : null;

      return {
        conditionId: condId,
        label: conditionLabel(condId),
        subtitle: conditionSubtitle(condId),
        validRuns,
        avgRecall,
        gtTotal: crossGtTotal,
        confirmedNovels,
        confirmedNovelsFiltered,
        plausibleNovelsFiltered,
        fpRate,
        consistency,
        avgCost,
        avgDurationMs,
      };
    });

  // ── Per-metric best condition IDs ──

  function bestHigher(getter: (a: CrossCodebaseAggregate) => number | null): string[] {
    let bestVal = -Infinity;
    let best: string[] = [];
    for (const a of crossAggregates) {
      const val = getter(a);
      if (val === null) continue;
      if (val > bestVal) { bestVal = val; best = [a.conditionId]; }
      else if (val === bestVal) best.push(a.conditionId);
    }
    return best;
  }

  function bestLower(getter: (a: CrossCodebaseAggregate) => number | null): string[] {
    let bestVal = Infinity;
    let best: string[] = [];
    for (const a of crossAggregates) {
      const val = getter(a);
      if (val === null) continue;
      if (val < bestVal) { bestVal = val; best = [a.conditionId]; }
      else if (val === bestVal) best.push(a.conditionId);
    }
    return best;
  }

  const metricBests: MetricBests = {
    recall: bestHigher((a) => a.avgRecall),
    confirmedNovelsFiltered: bestHigher((a) => a.confirmedNovelsFiltered),
    fpRate: bestLower((a) => a.fpRate),
    consistency: bestHigher((a) => a.consistency),
    avgCost: bestLower((a) => a.avgCost),
    avgDuration: bestLower((a) => a.avgDurationMs),
  };

  return {
    generatedAt: new Date().toISOString(),
    mode: options.latest ? 'latest' : 'all',
    totalRuns: runs.length,
    validRuns: runs.length - invalidCount,
    invalidRuns: invalidCount,
    codebaseIds,
    codebases,
    gtMissedByAllTotal,
    gtTotalAll,
    gtMissedByAllPercent: gtTotalAll > 0 ? Math.round((gtMissedByAllTotal / gtTotalAll) * 100) : 0,
    crossCodebaseAggregates: crossAggregates,
    totalExcludedByRiskCategory: codebases.reduce((sum, cb) =>
      sum + cb.validations.filter((v) =>
        v.riskCategory && (v.verdict === 'confirmed' || v.verdict === 'plausible'),
      ).length, 0),
    metricBests,
    integrityViolations,
  };
}

/** Write report data to JSON file. */
export function writeReportData(data: ReportData, resultsDir: string): string {
  const outputPath = path.join(resultsDir, 'report-data.json');
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
  return outputPath;
}

/** Load report data from JSON file. */
export function loadReportData(resultsDir: string): ReportData | null {
  const filePath = path.join(resultsDir, 'report-data.json');
  return loadJSON<ReportData>(filePath);
}
