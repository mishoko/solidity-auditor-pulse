/**
 * Reads results/*.meta.json + *.stdout.txt, parses findings,
 * and generates a comparison markdown report with graphical elements.
 *
 * Uses ONLY the latest run per (codebase, condition) — ignores older test runs.
 * Matches findings against ground truth using location-based fuzzy matching.
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

function loadLatestRuns(resultsDir: string): RunData[] {
  const runs: RunData[] = [];
  const metaFiles = fs.readdirSync(resultsDir).filter(f => f.endsWith('.meta.json'));

  // Keep only the latest run per (codebase, condition)
  const latest = new Map<string, { file: string; ts: string }>();
  for (const file of metaFiles) {
    const meta: RunMeta = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8'));
    const key = `${meta.codebaseId}::${meta.conditionId}`;
    const existing = latest.get(key);
    if (!existing || meta.timestampUtc > existing.ts) {
      latest.set(key, { file, ts: meta.timestampUtc });
    }
  }

  for (const { file } of latest.values()) {
    const meta: RunMeta = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8'));

    // Accept exitCode 0 or 143 (grace-killed after result received)
    if (meta.exitCode !== 0 && meta.exitCode !== 143) continue;

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
  const sec = Math.round(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m${s}s` : `${sec}s`;
}

// ─── Ground Truth ───

interface GTFinding {
  id: string;
  severity?: string;
  title?: string;
  rootCause?: string;
  location?: string;
  line?: number;
  description: string;
  judgeVerdict?: string;
}

interface GroundTruth {
  codebaseId: string;
  findings: GTFinding[];
}

function loadGroundTruth(codebaseId: string): GroundTruth | null {
  const gtPath = path.resolve(process.cwd(), 'ground_truth', `${codebaseId}.json`);
  if (!fs.existsSync(gtPath)) return null;
  return JSON.parse(fs.readFileSync(gtPath, 'utf8'));
}

/**
 * Fuzzy match: does the parsed finding match this GT entry?
 * Uses location (contract.function) and title keyword overlap.
 */
function matchesGT(finding: ParsedFinding, gt: GTFinding): boolean {
  const fLoc = (finding.location ?? '').toLowerCase();
  const gtLoc = (gt.location ?? '').toLowerCase();

  // Location-based matching (only when GT has location data)
  let contractMatch = false;
  let funcMatch = false;
  if (gtLoc) {
    const gtContract = (gtLoc.split('.')[0] ?? '').replace(/\s*\(.*$/, '');
    const gtFunc = gtLoc.includes('.') ? (gtLoc.split('.')[1] ?? '').split(/\s/)[0] ?? '' : null;
    contractMatch = fLoc.includes(gtContract) || gtContract.includes(fLoc.split('.')[0] ?? '');
    funcMatch = !!(gtFunc && fLoc.includes(gtFunc));
  }

  // Title keyword overlap (at least 2 significant words match)
  const gtWords = new Set(
    ((gt.title ?? '') + ' ' + gt.description)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length > 3)
  );
  const fWords = finding.title.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
  const overlap = fWords.filter(w => gtWords.has(w)).length;

  // Match if: (same contract AND same function) OR (same contract AND ≥3 keyword overlap)
  if (contractMatch && funcMatch) return true;
  if (contractMatch && overlap >= 3) return true;
  if (overlap >= 5) return true; // strong title match even without contract

  return false;
}

// ─── ASCII Bar Chart ───

function bar(value: number, max: number, width: number = 20): string {
  if (max === 0) return '░'.repeat(width);
  const filled = Math.round((value / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ─── Report Generation ───

export function generateSummary(resultsDir: string, outputPath: string): void {
  const allRuns = loadLatestRuns(resultsDir);
  if (allRuns.length === 0) {
    log.warn('No results found');
    return;
  }

  const lines: string[] = [];
  const push = (s: string) => lines.push(s);

  push('# Benchmark Results');
  push('');
  push(`> Generated: ${new Date().toISOString().split('T')[0]}`);
  push('');

  // Group by codebase, sorted by condition order
  const byCodebase = new Map<string, RunData[]>();
  for (const run of allRuns) {
    const arr = byCodebase.get(run.meta.codebaseId) ?? [];
    arr.push(run);
    byCodebase.set(run.meta.codebaseId, arr);
  }
  for (const runs of byCodebase.values()) {
    runs.sort((a, b) => conditionSortIndex(a.meta.conditionId) - conditionSortIndex(b.meta.conditionId));
  }

  // Overview table
  push('## Overview');
  push('');
  push('| Codebase | Condition | Findings | Duration | Cost |');
  push('|----------|-----------|----------|----------|------|');
  for (const [codebaseId, runs] of byCodebase) {
    for (const run of runs) {
      const label = conditionLabel(run.meta.conditionId);
      const dur = formatDuration(run.meta.durationMs);
      // Try to extract cost from events
      const eventsPath = path.join(resultsDir, `${run.meta.runId}.events.jsonl`);
      let cost = '-';
      if (fs.existsSync(eventsPath)) {
        const eventsText = fs.readFileSync(eventsPath, 'utf8');
        const costMatch = eventsText.match(/"total_cost_usd":\s*([\d.]+)/);
        if (costMatch?.[1]) cost = `$${parseFloat(costMatch[1]).toFixed(2)}`;
      }
      push(`| ${codebaseId} | ${label} | ${run.parse.findings.length} | ${dur} | ${cost} |`);
    }
  }
  push('');

  // Per-codebase detailed sections
  for (const [codebaseId, runs] of byCodebase) {
    const gt = loadGroundTruth(codebaseId);
    const gtCount = gt?.findings.length ?? 0;

    push(`## ${codebaseId}`);
    push('');

    // Recall bar chart
    if (gt) {
      push('### Recall');
      push('');
      push('```');
      for (const run of runs) {
        const label = conditionLabel(run.meta.conditionId).padEnd(8);
        const matched = gt.findings.filter(g => run.parse.findings.some(f => matchesGT(f, g)));
        const matchedIds = matched.map(g => g.id);
        const recallPct = gtCount > 0 ? Math.round((matched.length / gtCount) * 100) : 0;
        push(`${label} ${bar(matched.length, gtCount)} ${matched.length}/${gtCount} (${recallPct}%) ${matchedIds.join(', ')}`);
      }
      push('```');
      push('');

      // Missed findings
      const allMatched = new Set<string>();
      for (const run of runs) {
        for (const g of gt.findings) {
          if (run.parse.findings.some(f => matchesGT(f, g))) {
            allMatched.add(g.id);
          }
        }
      }
      const missed = gt.findings.filter(g => !allMatched.has(g.id));
      if (missed.length > 0) {
        push(`**Missed by all**: ${missed.map(g => `${g.id} (${(g.title ?? g.description).slice(0, 50)})`).join(', ')}`);
        push('');
      }

      // FP chart
      push('### False Positives');
      push('');
      push('```');
      const maxFindings = Math.max(...runs.map(r => r.parse.findings.length), 1);
      for (const run of runs) {
        const label = conditionLabel(run.meta.conditionId).padEnd(8);
        const fps = run.parse.findings.filter(f => !gt.findings.some(g => matchesGT(f, g)));
        push(`${label} ${bar(fps.length, maxFindings)} ${fps.length} FP(s)${fps.length > 0 ? ': ' + fps.map(f => f.title.slice(0, 40)).join('; ') : ''}`);
      }
      push('```');
      push('');
    }

    // Findings count chart (always shown)
    push('### Findings');
    push('');
    push('```');
    const maxFindings = Math.max(...runs.map(r => r.parse.findings.length), 1);
    for (const run of runs) {
      const label = conditionLabel(run.meta.conditionId).padEnd(8);
      push(`${label} ${bar(run.parse.findings.length, maxFindings)} ${run.parse.findings.length} finding(s)`);
    }
    push('```');
    push('');

    // Duration chart
    push('### Duration');
    push('');
    push('```');
    const maxDur = Math.max(...runs.map(r => r.meta.durationMs));
    for (const run of runs) {
      const label = conditionLabel(run.meta.conditionId).padEnd(8);
      push(`${label} ${bar(run.meta.durationMs, maxDur)} ${formatDuration(run.meta.durationMs)}`);
    }
    push('```');
    push('');

    // Per-condition findings list (always shown)
    for (const run of runs) {
      const label = conditionLabel(run.meta.conditionId);
      if (run.parse.findings.length === 0) continue;
      push(`<details><summary>${label} — ${run.parse.findings.length} finding(s)</summary>`);
      push('');
      for (const f of run.parse.findings) {
        const conf = f.confidence !== null ? ` [${f.confidence}]` : '';
        const loc = f.location ? ` · ${f.location}` : '';
        push(`- ${f.title}${conf}${loc}`);
      }
      push('');
      push('</details>');
      push('');
    }

    // GT-based sections (only when ground truth available)
    if (gt) {
      push('### Findings Matrix');
      push('');
      const colHeaders = runs.map(r => conditionLabel(r.meta.conditionId));
      push(`| GT | Finding | ${colHeaders.join(' | ')} |`);
      push(`| -- | ------- | ${colHeaders.map(() => '---').join(' | ')} |`);

      for (const g of gt.findings) {
        const cells = runs.map(run => {
          const match = run.parse.findings.find(f => matchesGT(f, g));
          if (!match) return '-';
          if (match.confidence !== null) return `[${match.confidence}]`;
          return '✓';
        });
        const rawTitle = g.title ?? g.description;
        const title = rawTitle.length > 55 ? rawTitle.slice(0, 52) + '...' : rawTitle;
        push(`| ${g.id} | ${title} | ${cells.join(' | ')} |`);
      }
      push('');
    }
  }

  const content = lines.join('\n');
  fs.writeFileSync(outputPath, content);
  log.success(`Summary written to ${outputPath} (${lines.length} lines)`);
  console.log('\n' + content);
}

// CLI entrypoint
const resultsDir = path.resolve(process.cwd(), 'results');
const outputPath = path.resolve(process.cwd(), 'summary.md');
generateSummary(resultsDir, outputPath);
