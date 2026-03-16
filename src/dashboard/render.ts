/**
 * Dashboard renderer — reads report-data.json (shared feed) and outputs
 * a self-contained HTML comparison table for management presentation.
 *
 * Usage:  npm run dashboard
 * Output: dashboard.html (project root)
 *
 * Zero computation — purely renders from the shared data feed.
 * Must run `npm run analyze` or `npm run report` first to generate the feed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadReportData,
  type ReportData,
  type ConditionAggregate,
} from '../shared/report-data.js';

// ─── Config ───

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RESULTS_DIR = path.join(ROOT, 'results');
const OUTPUT_FILE = path.join(ROOT, 'dashboard.html');

/** Column order: leftmost = newest/most visible, rightmost = baseline. */
const CONDITION_DISPLAY: { id: string; label: string; subtitle: string }[] = [
  { id: 'skill_v2', label: 'Skill V2', subtitle: '5 agents + FP gate' },
  { id: 'skill_v1_default', label: 'Skill V1', subtitle: '4 agents (Sonnet)' },
  // { id: 'skill_v1_deep', label: 'Skill V1 Deep', subtitle: '+ adversarial (Opus)' },
  { id: 'bare_audit', label: 'Bare CC', subtitle: 'No skill, audit prompt only' },
];

// ─── Types ───

interface MetricRow {
  name: string;
  description: string;
  values: Map<string, string>;
  best: Set<string>;
}

// ─── Aggregate across codebases ───

interface CrossCodebaseAggregate {
  conditionId: string;
  avgRecall: number | null;
  gtTotal: number | null;
  confirmedNovels: number;
  fpRate: number | null;
  consistency: number | null;
  validRuns: number;
  avgCost: number | null;
  avgDurationMs: number | null;
}

function aggregateAcrossCodebases(data: ReportData): Map<string, CrossCodebaseAggregate> {
  // Collect all per-codebase aggregates by conditionId
  const byCondition = new Map<string, ConditionAggregate[]>();
  for (const cb of data.codebases) {
    for (const agg of cb.aggregates) {
      const arr = byCondition.get(agg.conditionId) ?? [];
      arr.push(agg);
      byCondition.set(agg.conditionId, arr);
    }
  }

  const result = new Map<string, CrossCodebaseAggregate>();

  for (const [conditionId, aggs] of byCondition) {
    // GT recall: weighted by GT count across codebases that have GT
    const gtAggs = aggs.filter((a) => a.avgRecall !== null && a.gtTotal !== null);
    let avgRecall: number | null = null;
    let gtTotal: number | null = null;
    if (gtAggs.length > 0) {
      const totalMatched = gtAggs.reduce((sum, a) => sum + (a.avgMatched ?? 0), 0);
      const totalGt = gtAggs.reduce((sum, a) => sum + (a.gtTotal ?? 0), 0);
      avgRecall = totalGt > 0 ? totalMatched / totalGt : null;
      gtTotal = totalGt;
    }

    // Confirmed novels: sum across codebases
    const confirmedNovels = aggs.reduce((sum, a) => sum + a.confirmedNovels, 0);

    // FP rate: total FP / total findings across codebases
    const totalFp = aggs.reduce((sum, a) => sum + a.totalFp, 0);
    const totalFindings = aggs.reduce((sum, a) => sum + a.totalFindings, 0);
    const fpRate = totalFindings > 0 ? totalFp / totalFindings : null;

    // Consistency: average across GT codebases (only those with multi-run data)
    const consAggs = aggs.filter((a) => a.consistency !== null);
    const consistency = consAggs.length > 0
      ? consAggs.reduce((sum, a) => sum + a.consistency!, 0) / consAggs.length
      : null;

    // Valid runs total
    const validRuns = aggs.reduce((sum, a) => sum + a.validRuns, 0);

    // Cost: weighted average by valid runs
    const costAggs = aggs.filter((a) => a.avgCost !== null && a.validRuns > 0);
    const avgCost = costAggs.length > 0
      ? costAggs.reduce((sum, a) => sum + a.avgCost! * a.validRuns, 0) /
        costAggs.reduce((sum, a) => sum + a.validRuns, 0)
      : null;

    // Duration: weighted average by valid runs
    const durAggs = aggs.filter((a) => a.avgDurationMs !== null && a.validRuns > 0);
    const avgDurationMs = durAggs.length > 0
      ? durAggs.reduce((sum, a) => sum + a.avgDurationMs! * a.validRuns, 0) /
        durAggs.reduce((sum, a) => sum + a.validRuns, 0)
      : null;

    result.set(conditionId, {
      conditionId,
      avgRecall,
      gtTotal,
      confirmedNovels,
      fpRate,
      consistency,
      validRuns,
      avgCost,
      avgDurationMs,
    });
  }

  return result;
}

// ─── Metric row building ───

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${sec}s`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function buildMetricRows(
  metrics: Map<string, CrossCodebaseAggregate>,
  conditions: typeof CONDITION_DISPLAY,
  gtTotal: number,
): MetricRow[] {
  const rows: MetricRow[] = [];
  const active = conditions.filter((c) => metrics.has(c.id));

  // Helper: find best (higher is better)
  function bestHigher(getter: (a: CrossCodebaseAggregate) => number | null): Set<string> {
    let bestVal = -Infinity;
    const best = new Set<string>();
    for (const c of active) {
      const val = getter(metrics.get(c.id)!);
      if (val === null) continue;
      if (val > bestVal) { bestVal = val; best.clear(); best.add(c.id); }
      else if (val === bestVal) best.add(c.id);
    }
    return best;
  }

  // Helper: find best (lower is better)
  function bestLower(getter: (a: CrossCodebaseAggregate) => number | null): Set<string> {
    let bestVal = Infinity;
    const best = new Set<string>();
    for (const c of active) {
      const val = getter(metrics.get(c.id)!);
      if (val === null) continue;
      if (val < bestVal) { bestVal = val; best.clear(); best.add(c.id); }
      else if (val === bestVal) best.add(c.id);
    }
    return best;
  }

  // 1. GT Recall
  {
    const values = new Map<string, string>();
    for (const c of active) {
      const m = metrics.get(c.id)!;
      values.set(c.id, m.avgRecall !== null ? formatPercent(m.avgRecall) : '\u2014');
    }
    rows.push({ name: 'GT Recall', description: `Known bugs found (${gtTotal} in GT)`, values, best: bestHigher((a) => a.avgRecall) });
  }

  // 2. Confirmed Novel Bugs
  {
    const values = new Map<string, string>();
    for (const c of active) values.set(c.id, String(metrics.get(c.id)!.confirmedNovels));
    rows.push({ name: 'Confirmed Novel Findings', description: 'Opus-validated across all codebases', values, best: bestHigher((a) => a.confirmedNovels) });
  }

  // 3. FP Rate
  {
    const values = new Map<string, string>();
    for (const c of active) {
      const m = metrics.get(c.id)!;
      values.set(c.id, m.fpRate !== null ? formatPercent(m.fpRate) : '\u2014');
    }
    rows.push({ name: 'False Positive Rate', description: 'FP \u00F7 total findings (lower is better)', values, best: bestLower((a) => a.fpRate) });
  }

  // 4. Consistency
  {
    const values = new Map<string, string>();
    for (const c of active) {
      const m = metrics.get(c.id)!;
      if (m.consistency !== null && m.validRuns >= 2) {
        values.set(c.id, m.consistency.toFixed(2));
      } else {
        values.set(c.id, m.validRuns < 2 ? '1 run' : '\u2014');
      }
    }
    rows.push({ name: 'Consistency across runs', description: 'Cross-run GT agreement (Jaccard)', values, best: bestHigher((a) => a.consistency) });
  }

  // 5. Avg Cost
  {
    const values = new Map<string, string>();
    for (const c of active) {
      const m = metrics.get(c.id)!;
      values.set(c.id, m.avgCost !== null ? `$${m.avgCost.toFixed(2)}` : '\u2014');
    }
    rows.push({ name: 'Avg Cost / Run', description: 'Claude API usage per run', values, best: bestLower((a) => a.avgCost) });
  }

  // 6. Avg Duration
  {
    const values = new Map<string, string>();
    for (const c of active) {
      const m = metrics.get(c.id)!;
      values.set(c.id, m.avgDurationMs !== null ? formatDuration(m.avgDurationMs) : '\u2014');
    }
    rows.push({ name: 'Avg Duration', description: 'Wall clock per run', values, best: bestLower((a) => a.avgDurationMs) });
  }

  return rows;
}

// ─── HTML rendering ───

function escapeHTML(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderHTML(
  rows: MetricRow[],
  conditions: typeof CONDITION_DISPLAY,
  data: ReportData,
  metrics: Map<string, CrossCodebaseAggregate>,
): string {
  const active = conditions.filter((c) =>
    rows.some((r) => r.values.has(c.id) && r.values.get(c.id) !== '\u2014'),
  );

  const headerCells = active
    .map((c, i) => {
      const m = metrics.get(c.id);
      const runCount = m ? `${m.validRuns} run${m.validRuns !== 1 ? 's' : ''}` : '';
      return `      <th${i === 0 ? ' class="highlight"' : ''}>
        <span class="model-name">${escapeHTML(c.label)}</span>
        <span class="model-sub">${escapeHTML(c.subtitle)}</span>
        <span class="model-sub">${escapeHTML(runCount)}</span>
      </th>`;
    })
    .join('\n');

  const dataRows = rows
    .map((row) => {
      const cells = active
        .map((c, i) => {
          const val = row.values.get(c.id) ?? '\u2014';
          const isBest = row.best.has(c.id);
          const isDash = val === '\u2014' || val === '1 run';
          const classes: string[] = [];
          if (i === 0) classes.push('highlight');
          if (isBest && !isDash) classes.push('best');
          if (isDash) classes.push('dash');
          const classAttr = classes.length > 0 ? ` class="${classes.join(' ')}"` : '';
          return `      <td${classAttr}>${escapeHTML(val)}</td>`;
        })
        .join('\n');

      return `    <tr>
      <td>
        <span class="metric-name">${escapeHTML(row.name)}</span>
        <span class="metric-desc">${escapeHTML(row.description)}</span>
      </td>
${cells}
    </tr>`;
    })
    .join('\n');

  const codebaseList = data.codebaseIds.join(' + ');
  const dateStr = data.generatedAt.slice(0, 10);

  const missedCallout =
    data.gtTotalAll > 0
      ? `
  <div class="callout">
    <strong>${Math.round((data.gtMissedByAllTotal / data.gtTotalAll) * 100)}% of known vulnerabilities (${data.gtMissedByAllTotal}/${data.gtTotalAll}) were missed by all approaches.</strong>
    The primary gap is not between tools &mdash; it&rsquo;s between current LLM auditing and the bugs that matter.
  </div>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Solidity Auditor Benchmark</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: #fff; color: #1a1a1a; padding: 48px;
  }
  .container { max-width: 960px; margin: 0 auto; }
  .header {
    display: flex; align-items: baseline; gap: 32px;
    margin-bottom: 40px; padding-bottom: 20px; border-bottom: 1px solid #e5e5e5;
  }
  .header h1 { font-size: 18px; font-weight: 600; letter-spacing: -0.3px; }
  .header .subtitle { font-size: 13px; color: #888; }

  table { width: 100%; border-collapse: collapse; }
  thead th {
    font-size: 12px; font-weight: 400; color: #888;
    text-align: right; padding: 8px 16px 16px; vertical-align: bottom;
  }
  thead th:first-child { text-align: left; }
  thead .model-name { display: block; font-size: 15px; font-weight: 600; color: #1a1a1a; margin-top: 2px; }
  thead .model-sub { display: block; font-size: 11px; color: #aaa; margin-top: 2px; }

  tbody tr { border-top: 1px solid #f0f0f0; }
  tbody td {
    padding: 18px 16px; text-align: right;
    font-size: 16px; font-weight: 400; vertical-align: middle;
  }
  tbody td:first-child { text-align: left; }

  .metric-name { font-size: 14px; font-weight: 600; display: block; }
  .metric-desc { font-size: 11px; color: #999; display: block; margin-top: 2px; }
  .best { font-weight: 700; }
  .best::before { content: "\\25CF  "; font-size: 8px; vertical-align: middle; }
  .dash { color: #ccc; }

  .highlight { background: #fef8f6; }

  .callout {
    margin-top: 24px; padding: 16px 20px;
    background: #fafafa; border-left: 3px solid #ddd;
    font-size: 13px; color: #666; line-height: 1.5;
  }
  .footnotes { margin-top: 32px; font-size: 11px; color: #999; line-height: 1.6; }
  .footnotes p { margin-bottom: 4px; }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <h1>Skills Auditor Benchmark</h1>
    <span class="subtitle">${escapeHTML(codebaseList)} &middot; ${dateStr}</span>
  </div>

  <table>
    <thead>
      <tr>
        <th></th>
${headerCells}
      </tr>
    </thead>
    <tbody>
${dataRows}
    </tbody>
  </table>
${missedCallout}

  <div class="footnotes">
    <p>GT/Official Findings recall measured against ${data.gtTotalAll} findings from official C4 audit reports (codebases with ground truth only).</p>
    <p>INVALID runs excluded (skill runs with 0 findings). Novel (out of GT) findings validated by Claude Opus against scoped source code.</p>
    <p>Consistency = Jaccard similarity of matched GT IDs across runs. &ldquo;1 run&rdquo; = single run, consistency undefined.</p>
    <p>Cost = Claude API usage as reported by CLI. Duration = wall clock including agent orchestration.</p>
  </div>

</div>
</body>
</html>`;
}

// ─── Main ───

function main(): void {
  // Parse --codebases filter (comma-separated or repeated)
  const args = process.argv.slice(2);
  const codebaseFilter = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--codebases' && args[i + 1]) {
      for (const id of args[i + 1]!.split(',')) codebaseFilter.add(id.trim());
      i++;
    }
  }

  let data = loadReportData(RESULTS_DIR);
  if (!data) {
    console.error('No report-data.json found. Run `npm run report` or `npm run analyze` first.');
    process.exit(1);
  }

  // Filter codebases if requested
  if (codebaseFilter.size > 0) {
    data = {
      ...data,
      codebaseIds: data.codebaseIds.filter((id) => codebaseFilter.has(id)),
      codebases: data.codebases.filter((cb) => codebaseFilter.has(cb.codebaseId)),
      gtMissedByAllTotal: data.codebases
        .filter((cb) => codebaseFilter.has(cb.codebaseId))
        .reduce((sum, cb) => sum + cb.missedGt.length, 0),
      gtTotalAll: data.codebases
        .filter((cb) => codebaseFilter.has(cb.codebaseId))
        .reduce((sum, cb) => sum + cb.gtTotal, 0),
    };
  }

  console.log(`Reading report data (${data.codebases.reduce((s, cb) => s + cb.runs.length, 0)} runs, codebases: ${data.codebaseIds.join(', ')})`);

  const metrics = aggregateAcrossCodebases(data);
  const active = CONDITION_DISPLAY.filter((c) => metrics.has(c.id));
  const rows = buildMetricRows(metrics, active, data.gtTotalAll);
  const html = renderHTML(rows, active, data, metrics);

  fs.writeFileSync(OUTPUT_FILE, html, 'utf8');
  console.log(`Dashboard written to ${OUTPUT_FILE}`);
}

main();
