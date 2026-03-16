/**
 * Dashboard renderer — reads report-data.json (shared feed) and outputs
 * a self-contained HTML comparison table for management presentation.
 *
 * Usage:  npm run dashboard
 * Output: dashboard.html (project root)
 *
 * PURE RENDERER — zero computation. All metrics pre-computed in report-data.ts.
 * Must run `npm run analyze` or `npm run report` first to generate the feed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadReportData,
  type ReportData,
  type CrossCodebaseAggregate,
  type MetricBests,
} from '../shared/report-data.js';

// ─── Config ───

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RESULTS_DIR = path.join(ROOT, 'results');
const OUTPUT_FILE = path.join(ROOT, 'dashboard.html');

/** Condition IDs to show in dashboard (comment out to hide). */
const VISIBLE_CONDITIONS = new Set([
  'skill_v2',
  'skill_v1_default',
  // 'skill_v1_deep',
  'bare_audit',
]);

// ─── Display formatting (no computation — just string conversion) ───

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${sec}s`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

// ─── Metric rows (pure mapping from pre-computed data) ───

interface MetricRow {
  name: string;
  description: string;
  values: Map<string, string>;
  bestIds: string[];
}

function buildMetricRows(
  aggregates: CrossCodebaseAggregate[],
  bests: MetricBests,
  gtTotal: number,
): MetricRow[] {
  const rows: MetricRow[] = [];

  // 1. GT Recall
  {
    const values = new Map<string, string>();
    for (const a of aggregates) {
      values.set(a.conditionId, a.avgRecall !== null ? formatPercent(a.avgRecall) : '\u2014');
    }
    rows.push({ name: 'GT Recall', description: `Known bugs found (${gtTotal} in GT)`, values, bestIds: bests.recall });
  }

  // 2. Confirmed Novel Findings (filtered)
  {
    const values = new Map<string, string>();
    for (const a of aggregates) values.set(a.conditionId, String(a.confirmedNovelsFiltered));
    rows.push({ name: 'Confirmed Novel Findings', description: 'Opus-validated, excludes centralization & informational', values, bestIds: bests.confirmedNovelsFiltered });
  }

  // 2b. Conditional Novel Findings (plausible, filtered)
  {
    const values = new Map<string, string>();
    for (const a of aggregates) values.set(a.conditionId, String(a.plausibleNovelsFiltered));
    rows.push({ name: 'Conditional Novel Findings', description: 'Plausible, exploitation depends on assumptions or edge-cases', values, bestIds: bests.confirmedNovelsFiltered });
  }

  // 3. FP Rate
  {
    const values = new Map<string, string>();
    for (const a of aggregates) {
      values.set(a.conditionId, a.fpRate !== null ? formatPercent(a.fpRate) : '\u2014');
    }
    rows.push({ name: 'False Positive Rate', description: 'FP \u00F7 total findings (lower is better)', values, bestIds: bests.fpRate });
  }

  // 4. Consistency
  {
    const values = new Map<string, string>();
    for (const a of aggregates) {
      if (a.consistency !== null && a.validRuns >= 2) {
        values.set(a.conditionId, a.consistency.toFixed(2));
      } else {
        values.set(a.conditionId, a.validRuns < 2 ? '1 run' : '\u2014');
      }
    }
    rows.push({ name: 'Consistency', description: 'Cross-run GT agreement (Jaccard)', values, bestIds: bests.consistency });
  }

  // 5. Avg Cost
  {
    const values = new Map<string, string>();
    for (const a of aggregates) {
      values.set(a.conditionId, a.avgCost !== null ? `$${a.avgCost.toFixed(2)}` : '\u2014');
    }
    rows.push({ name: 'Avg Cost / Run', description: 'Claude API usage per run', values, bestIds: bests.avgCost });
  }

  // 6. Avg Duration
  {
    const values = new Map<string, string>();
    for (const a of aggregates) {
      values.set(a.conditionId, a.avgDurationMs !== null ? formatDuration(a.avgDurationMs) : '\u2014');
    }
    rows.push({ name: 'Avg Duration', description: 'Wall clock per run', values, bestIds: bests.avgDuration });
  }

  return rows;
}

// ─── HTML rendering ───

function escapeHTML(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderHTML(
  rows: MetricRow[],
  aggregates: CrossCodebaseAggregate[],
  data: ReportData,
): string {
  const headerCells = aggregates
    .map((a, i) => {
      const runCount = `${a.validRuns} run${a.validRuns !== 1 ? 's' : ''}`;
      return `      <th${i === 0 ? ' class="highlight"' : ''}>
        <span class="model-name">${escapeHTML(a.label)}</span>
        <span class="model-sub">${escapeHTML(a.subtitle)}</span>
        <span class="model-sub">${escapeHTML(runCount)}</span>
      </th>`;
    })
    .join('\n');

  const dataRows = rows
    .map((row) => {
      const bestSet = new Set(row.bestIds);
      const cells = aggregates
        .map((a, i) => {
          const val = row.values.get(a.conditionId) ?? '\u2014';
          const isBest = bestSet.has(a.conditionId);
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
    <strong>${data.gtMissedByAllPercent}% of known vulnerabilities (${data.gtMissedByAllTotal}/${data.gtTotalAll}) were missed by all approaches.</strong>
    The primary gap is not between tools &mdash; it&rsquo;s between current LLM auditing and the bugs that matter.
  </div>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Skills Auditor Benchmark</title>
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
    <p>INVALID runs excluded (skill runs with 0 findings). Novel bugs validated by Claude Opus against scoped source code.</p>
    <p>Confirmed novel findings exclude centralization-risk and informational categories (${data.totalExcludedByRiskCategory} finding${data.totalExcludedByRiskCategory !== 1 ? 's' : ''} excluded).</p>
    <p>Consistency = Jaccard similarity of matched GT IDs across runs. &ldquo;1 run&rdquo; = single run, consistency undefined.</p>
    <p>Cost = Claude API usage as reported by CLI. Duration = wall clock including agent orchestration.</p>
  </div>

</div>
</body>
</html>`;
}

// ─── Main ───

function main(): void {
  // Parse --codebases filter
  const args = process.argv.slice(2);
  const codebaseFilter = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--codebases' && args[i + 1]) {
      for (const id of args[i + 1]!.split(',')) codebaseFilter.add(id.trim());
      i++;
    }
  }

  const data = loadReportData(RESULTS_DIR);
  if (!data) {
    console.error('No report-data.json found. Run `npm run report` or `npm run analyze` first.');
    process.exit(1);
  }

  // Filter aggregates by visible conditions and optional codebase filter
  let aggregates = data.crossCodebaseAggregates.filter((a) => VISIBLE_CONDITIONS.has(a.conditionId));

  // If codebase filter is active, recompute is NOT needed — the aggregates
  // are pre-computed across all codebases. For codebase-specific view,
  // we read per-codebase aggregates directly.
  let displayData = data;
  if (codebaseFilter.size > 0) {
    // Use per-codebase aggregates for filtered view
    const filteredCbs = data.codebases.filter((cb) => codebaseFilter.has(cb.codebaseId));
    const conditionIds = [...new Set(filteredCbs.flatMap((cb) => cb.conditions))];

    aggregates = conditionIds
      .filter((id) => VISIBLE_CONDITIONS.has(id))
      .map((condId) => {
        const perCb = filteredCbs
          .map((cb) => cb.aggregates.find((a) => a.conditionId === condId))
          .filter((a): a is (typeof a & {}) => a !== undefined);

        // Find the full aggregate to get label/subtitle
        const base = data.crossCodebaseAggregates.find((a) => a.conditionId === condId);

        return {
          conditionId: condId,
          label: base?.label ?? condId,
          subtitle: base?.subtitle ?? '',
          validRuns: perCb.reduce((s, a) => s + a.validRuns, 0),
          avgRecall: (() => {
            const gt = perCb.filter((a) => a.avgRecall !== null && a.gtTotal !== null);
            if (gt.length === 0) return null;
            const m = gt.reduce((s, a) => s + (a.avgMatched ?? 0), 0);
            const t = gt.reduce((s, a) => s + (a.gtTotal ?? 0), 0);
            return t > 0 ? m / t : null;
          })(),
          gtTotal: perCb.reduce((s, a) => s + (a.gtTotal ?? 0), 0) || null,
          confirmedNovels: perCb.reduce((s, a) => s + a.confirmedNovels, 0),
          confirmedNovelsFiltered: perCb.reduce((s, a) => s + a.confirmedNovelsFiltered, 0),
          plausibleNovelsFiltered: perCb.reduce((s, a) => s + a.plausibleNovelsFiltered, 0),
          fpRate: (() => {
            const tf = perCb.reduce((s, a) => s + a.totalFindings, 0);
            return tf > 0 ? perCb.reduce((s, a) => s + a.totalFp, 0) / tf : null;
          })(),
          consistency: (() => {
            const c = perCb.filter((a) => a.consistency !== null);
            return c.length > 0 ? c.reduce((s, a) => s + a.consistency!, 0) / c.length : null;
          })(),
          avgCost: (() => {
            const c = perCb.filter((a) => a.avgCost !== null && a.validRuns > 0);
            if (c.length === 0) return null;
            return c.reduce((s, a) => s + a.avgCost! * a.validRuns, 0) / c.reduce((s, a) => s + a.validRuns, 0);
          })(),
          avgDurationMs: (() => {
            const d = perCb.filter((a) => a.avgDurationMs !== null && a.validRuns > 0);
            if (d.length === 0) return null;
            return d.reduce((s, a) => s + a.avgDurationMs! * a.validRuns, 0) / d.reduce((s, a) => s + a.validRuns, 0);
          })(),
        };
      });

    displayData = {
      ...data,
      codebaseIds: [...codebaseFilter],
      gtTotalAll: filteredCbs.reduce((s, cb) => s + cb.gtTotal, 0),
      gtMissedByAllTotal: filteredCbs.reduce((s, cb) => s + cb.missedGt.length, 0),
      gtMissedByAllPercent: (() => {
        const t = filteredCbs.reduce((s, cb) => s + cb.gtTotal, 0);
        const m = filteredCbs.reduce((s, cb) => s + cb.missedGt.length, 0);
        return t > 0 ? Math.round((m / t) * 100) : 0;
      })(),
    };
  }

  // Filter out conditions with no data
  aggregates = aggregates.filter((a) => a.validRuns > 0 || a.avgRecall !== null);

  console.log(`Reading report data (${aggregates.reduce((s, a) => s + a.validRuns, 0)} runs, codebases: ${displayData.codebaseIds.join(', ')})`);

  // Compute bests for the filtered set
  function bestH(getter: (a: CrossCodebaseAggregate) => number | null): string[] {
    let bv = -Infinity; let b: string[] = [];
    for (const a of aggregates) { const v = getter(a); if (v === null) continue; if (v > bv) { bv = v; b = [a.conditionId]; } else if (v === bv) b.push(a.conditionId); }
    return b;
  }
  function bestL(getter: (a: CrossCodebaseAggregate) => number | null): string[] {
    let bv = Infinity; let b: string[] = [];
    for (const a of aggregates) { const v = getter(a); if (v === null) continue; if (v < bv) { bv = v; b = [a.conditionId]; } else if (v === bv) b.push(a.conditionId); }
    return b;
  }

  const bests: MetricBests = codebaseFilter.size > 0
    ? {
        recall: bestH((a) => a.avgRecall),
        confirmedNovelsFiltered: bestH((a) => a.confirmedNovelsFiltered),
        fpRate: bestL((a) => a.fpRate),
        consistency: bestH((a) => a.consistency),
        avgCost: bestL((a) => a.avgCost),
        avgDuration: bestL((a) => a.avgDurationMs),
      }
    : data.metricBests;

  const rows = buildMetricRows(aggregates, bests, displayData.gtTotalAll);
  const html = renderHTML(rows, aggregates, displayData);

  fs.writeFileSync(OUTPUT_FILE, html, 'utf8');
  console.log(`Dashboard written to ${OUTPUT_FILE}`);
}

main();
