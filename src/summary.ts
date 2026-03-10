/**
 * Reads all results/*.meta.json + *.stdout.txt, parses findings,
 * normalizes root causes, and generates a comparison markdown table.
 *
 * Column order: V2 default, V2 deep, V1 default, V1 deep, CC bare
 * Rows grouped by iteration (Run 1, Run 2, …)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunMeta } from './types.js';
import { parseOutput, type ParsedFinding, type ParseResult } from './parser.js';
import * as log from './util/logger.js';

interface RunData {
  meta: RunMeta;
  parse: ParseResult;
}

/** Display names and sort order for conditions */
const CONDITION_ORDER: [string, string][] = [
  ['skill_v2_default', 'V2 Default'],
  ['skill_v2_deep', 'V2 Deep'],
  ['skill_v1_default', 'V1 Default'],
  ['skill_v1_deep', 'V1 Deep'],
  ['bare_audit', 'CC Bare'],
];

function conditionLabel(id: string): string {
  return CONDITION_ORDER.find(([k]) => k === id)?.[1] ?? id;
}

function conditionSortIndex(id: string): number {
  const idx = CONDITION_ORDER.findIndex(([k]) => k === id);
  return idx >= 0 ? idx : 999;
}

function loadRuns(resultsDir: string): RunData[] {
  const runs: RunData[] = [];
  const metaFiles = fs.readdirSync(resultsDir).filter(f => f.endsWith('.meta.json'));

  for (const file of metaFiles) {
    const meta: RunMeta = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8'));
    if (meta.exitCode !== 0) continue; // skip failed runs
    const stdoutFile = path.join(resultsDir, `${meta.runId}.stdout.txt`);
    if (!fs.existsSync(stdoutFile)) continue;

    const text = fs.readFileSync(stdoutFile, 'utf8');
    const parse = parseOutput(text);
    runs.push({ meta, parse });
  }

  return runs;
}

function formatDuration(ms: number): string {
  if (ms === 0) return '-';
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${totalSec}s (${min}m ${sec}s)`;
}

function severityOrConfidence(f: ParsedFinding): string {
  if (f.confidence !== null) return `[${f.confidence}]`;
  if (f.severity !== null) return f.severity;
  return '?';
}

export function generateSummary(resultsDir: string, outputPath: string): void {
  const allRuns = loadRuns(resultsDir);
  if (allRuns.length === 0) {
    log.warn('No results found');
    return;
  }

  const lines: string[] = [];
  const push = (s: string) => lines.push(s);

  push('# Benchmark Results');
  push('');

  // Group by codebase
  const byCodebase = new Map<string, RunData[]>();
  for (const run of allRuns) {
    const arr = byCodebase.get(run.meta.codebaseId) ?? [];
    arr.push(run);
    byCodebase.set(run.meta.codebaseId, arr);
  }

  for (const [codebaseId, codebaseRuns] of byCodebase) {
    const iterations = [...new Set(codebaseRuns.map(r => r.meta.iteration))].sort();

    for (const iteration of iterations) {
      const iterRuns = codebaseRuns.filter(r => r.meta.iteration === iteration);

      // Sort runs by condition order
      iterRuns.sort((a, b) =>
        conditionSortIndex(a.meta.conditionId) - conditionSortIndex(b.meta.conditionId)
      );

      push(`## ${codebaseId} — Root Cause (Run ${iteration})`);
      push('');

      const colHeaders = iterRuns.map(r => conditionLabel(r.meta.conditionId));

      // Collect all root causes across this iteration's runs
      const allRootCauses = new Map<string, { title: string; location: string | null }>();
      for (const { parse } of iterRuns) {
        for (const f of parse.findings) {
          if (!allRootCauses.has(f.rootCause)) {
            allRootCauses.set(f.rootCause, { title: f.title, location: f.location });
          }
        }
      }

      // Build all rows first, then pad for alignment
      type Row = { label: string; cells: string[] };
      const rows: Row[] = [];

      for (const [rootCause] of allRootCauses) {
        const titles: string[] = [];
        const cells = iterRuns.map(({ parse }) => {
          const match = parse.findings.find(f => f.rootCause === rootCause);
          if (!match) return '-';
          titles.push(match.title);
          return severityOrConfidence(match);
        });
        const title = titles.reduce((a, b) => a.length <= b.length ? a : b, titles[0] || rootCause);
        rows.push({ label: title, cells });
      }

      // Footer rows
      rows.push({
        label: '**Total**',
        cells: iterRuns.map(r => `**${r.parse.findings.length}**`),
      });
      rows.push({
        label: '**Duration**',
        cells: iterRuns.map(r => formatDuration(r.meta.durationMs)),
      });

      // Compute column widths
      const colCount = colHeaders.length;
      const labelWidth = Math.max(
        'Root Cause'.length,
        ...rows.map(r => r.label.length),
      );
      const colWidths: number[] = [];
      for (let c = 0; c < colCount; c++) {
        colWidths.push(Math.max(
          colHeaders[c].length,
          ...rows.map(r => r.cells[c].length),
        ));
      }

      const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

      // Emit aligned table
      const hdr = `| ${pad('Root Cause', labelWidth)} | ${colHeaders.map((h, i) => pad(h, colWidths[i])).join(' | ')} |`;
      const sep = `| ${'-'.repeat(labelWidth)} | ${colWidths.map(w => '-'.repeat(w)).join(' | ')} |`;
      push(hdr);
      push(sep);

      for (const row of rows) {
        const line = `| ${pad(row.label, labelWidth)} | ${row.cells.map((c, i) => pad(c, colWidths[i])).join(' | ')} |`;
        push(line);
      }

      push('');
    }
  }

  push(`*Generated: ${new Date().toISOString()}*`);
  push('');

  const content = lines.join('\n');
  fs.writeFileSync(outputPath, content);
  log.success(`Summary written to ${outputPath}`);
  console.log('\n' + content);
}

// CLI entrypoint
const resultsDir = path.resolve(process.cwd(), 'results');
const outputPath = path.resolve(process.cwd(), 'summary.md');
generateSummary(resultsDir, outputPath);
