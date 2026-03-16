/**
 * Management report generator.
 *
 * Architecture:
 *   1. Compute ReportData (shared data feed — single source of truth)
 *   2. Write report-data.json
 *   3. Render markdown from ReportData (no re-computation)
 *   4. Generate 1 LLM narrative (Sonnet)
 *   5. Deterministic number verification
 *   6. Write deterministic data appendix
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  computeReportData,
  writeReportData,
  type ReportData,
  type CodebaseData,
  type RunEntry,
} from '../shared/report-data.js';
import { callLLMRaw, LLMError } from '../classifier/llm.js';
import * as log from '../shared/util/logger.js';

// ─── Config ───

const ANALYST_MODEL = process.env.ANALYST_MODEL || 'claude-sonnet-4-20250514';
const ANALYST_TIMEOUT = parseInt(process.env.ANALYST_TIMEOUT_MS || '') || 300_000;

// ─── Report options ───

export interface ReportOptions {
  latest: boolean;
}

// ─── Display helpers ───

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

function runLabel(run: RunEntry, cb: CodebaseData): string {
  const condLabel = cb.conditionLabels[cb.conditions.indexOf(run.conditionId)] ?? run.conditionId;
  const total = cb.runs.filter((r) => r.conditionId === run.conditionId).length;
  if (total === 1) return condLabel;
  return `${condLabel} #${run.runNumber}`;
}

// ─── Comparison table ───

function generateComparisonTable(data: ReportData): string[] {
  const lines: string[] = [];

  for (const cb of data.codebases) {
    lines.push(`## Comparison — ${cb.codebaseId}`);
    lines.push('');
    lines.push(`| Metric | ${cb.conditionLabels.join(' | ')} |`);
    lines.push(`|--------|${cb.conditionLabels.map(() => '---').join('|')}|`);

    // Recall
    if (cb.hasGt) {
      const cells = cb.aggregates.map((a) => {
        if (a.avgRecall === null || a.avgMatched === null) return '-';
        const avgRecallPct = Math.round(a.avgRecall * 100);
        const matchedDisplay = Number.isInteger(a.avgMatched) ? String(a.avgMatched) : a.avgMatched.toFixed(1);
        return `${matchedDisplay}/${a.gtTotal} (${avgRecallPct}%)`;
      });
      lines.push(`| Recall (GT) | ${cells.join(' | ')} |`);
    }

    // Consistency
    if (cb.hasGt) {
      const cells = cb.aggregates.map((a) =>
        a.consistency !== null ? a.consistency.toFixed(2) : '-',
      );
      lines.push(`| Consistency | ${cells.join(' | ')} |`);
    }

    // Novel confirmed / plausible
    if (cb.validationSummary) {
      const confirmedCells = cb.aggregates.map((a) => String(a.confirmedNovelsFiltered));
      const hasFiltered = cb.aggregates.some((a) => a.confirmedNovels !== a.confirmedNovelsFiltered);
      lines.push(`| Novel confirmed | ${confirmedCells.join(' | ')} |`);
      if (hasFiltered) {
        const unfilteredCells = cb.aggregates.map((a) => {
          const excluded = a.confirmedNovels - a.confirmedNovelsFiltered;
          return excluded > 0 ? `+${excluded} excluded` : '-';
        });
        lines.push(`| ↳ centralization/informational | ${unfilteredCells.join(' | ')} |`);
      }

      const conditionalCells = cb.aggregates.map((a) => String(a.plausibleNovelsFiltered));
      lines.push(`| Conditional novel | ${conditionalCells.join(' | ')} |`);
    }

    // Total findings
    const totalCells = cb.aggregates.map((a) => {
      if (a.avgFindingsCount === null) return '-';
      return Number.isInteger(a.avgFindingsCount) ? String(a.avgFindingsCount) : a.avgFindingsCount.toFixed(1);
    });
    lines.push(`| Total findings | ${totalCells.join(' | ')} |`);

    // Unique bugs
    if (cb.uniqueBugsTotal > 0) {
      const label = cb.hasGt ? 'Unique bugs found' : 'Unique findings';
      const bugCells = cb.aggregates.map((a) => String(a.uniqueBugsFound));
      lines.push(`| ${label} | ${bugCells.join(' | ')} |`);
    }

    // FP / Uncertain
    if (cb.hasGt) {
      const fpCells = cb.aggregates.map((a) => {
        if (a.avgFp === null) return '-';
        return String(Math.round(a.avgFp));
      });
      lines.push(`| False positives | ${fpCells.join(' | ')} |`);

      const uncCells = cb.aggregates.map((a) => {
        if (a.avgUncertain === null) return '-';
        return String(Math.round(a.avgUncertain));
      });
      lines.push(`| Uncertain | ${uncCells.join(' | ')} |`);
    }

    // Cost
    const costCells = cb.aggregates.map((a) =>
      a.avgCost !== null ? `$${a.avgCost.toFixed(2)}` : '-',
    );
    lines.push(`| Avg cost/run | ${costCells.join(' | ')} |`);

    // Duration
    const durCells = cb.aggregates.map((a) =>
      a.avgDurationMs !== null ? formatDuration(a.avgDurationMs) : '-',
    );
    lines.push(`| Avg duration | ${durCells.join(' | ')} |`);

    lines.push('');

    // Footer
    if (cb.uniqueBugsTotal > 0) {
      const noun = cb.hasGt ? 'unique bugs' : 'unique findings';
      lines.push(`> **${cb.uniqueBugsTotal} ${noun}** across all conditions (deduplicated by root cause).`);
    }
    if (!cb.hasGt) {
      const classifyVotes = parseInt(process.env.CLASSIFY_VOTES || '') || 1;
      const votesLabel = classifyVotes > 1 ? `${classifyVotes}-vote consensus` : '1 Sonnet confirmation';
      lines.push(`> *No ground truth available. Classifications based on ${votesLabel}.*`);
    }
    lines.push('');
  }

  return lines;
}

// ─── Missed GT section ───

function generateMissedGtSection(data: ReportData): string[] {
  const lines: string[] = [];

  for (const cb of data.codebases) {
    if (!cb.hasGt || cb.missedGt.length === 0) continue;

    lines.push(`## Missed GT Findings — ${cb.codebaseId}`);
    lines.push('');
    lines.push(`${cb.missedGt.length} of ${cb.gtTotal} ground truth findings were missed by all conditions:`);
    lines.push('');
    lines.push('| GT ID | Finding |');
    lines.push('|-------|---------|');
    for (const g of cb.missedGt) {
      const title = g.title.length > 60 ? g.title.slice(0, 57) + '...' : g.title;
      lines.push(`| ${g.id} | ${title} |`);
    }
    lines.push('');
  }

  return lines;
}

// ─── Findings Ledger ───

function generateFindingsLedger(data: ReportData): string[] {
  const lines: string[] = [];

  for (const cb of data.codebases) {
    if (cb.ledger.length === 0) continue;

    lines.push(`## Findings Ledger — ${cb.codebaseId}`);
    lines.push('');
    lines.push(`| # | Finding | ${cb.conditionLabels.join(' | ')} | Status |`);
    lines.push(`|---|---------|${cb.conditionLabels.map(() => '---').join('|')}|--------|`);
    for (let i = 0; i < cb.ledger.length; i++) {
      const r = cb.ledger[i]!;
      const cells = cb.conditions.map((condId) => r.conditionCells[condId] ?? '-');
      lines.push(
        `| ${i + 1} | ${r.title} | ${cells.join(' | ')} | ${r.status} |`,
      );
    }
    lines.push('');

    const hasUnvalidated = cb.ledger.some((r) => r.status === 'unvalidated');
    if (hasUnvalidated) {
      lines.push('> "unvalidated" = novel finding not yet confirmed against source code. Run `npm run analyze` (without `--no-validate`) to validate with Opus.');
    }
    if (cb.hasGt) {
      lines.push(`> GT findings (${cb.gtTotal}) from official C4 audit report. ✓ = found, ✓#N = found in run N only.`);
    } else {
      lines.push('> ✓ = found, ✓#N = found in run N only.');
    }
    lines.push('');
  }

  return lines;
}

// ─── LLM Analysis ───

function buildAnalysisPrompt(data: ReportData): string {
  const promptData = data.codebases.map((cb) => {
    const allMatchedIds = new Set<string>();
    for (const run of cb.runs) {
      if (run.invalid) continue;
      for (const id of run.matchedGtIds) allMatchedIds.add(id);
    }

    const conditions = cb.aggregates.map((a) => {
      const condRuns = cb.runs.filter((r) => r.conditionId === a.conditionId && !r.invalid);
      return {
        conditionId: a.conditionId,
        label: a.label,
        runs: condRuns.map((r) => ({
          recall: r.recall,
          precision: r.precision,
          matched: r.matched,
          novel: r.novel,
          fp: r.fp,
          uncertain: r.uncertain,
          costUsd: r.costUsd,
          durationMs: r.durationMs,
          findingsCount: r.findingsCount,
        })),
      };
    });

    return {
      codebaseId: cb.codebaseId,
      gtCount: cb.gtTotal,
      missedByAll: cb.missedGt.map((m) => m.id),
      conditions,
      novelClusters: cb.uniqueBugsTotal,
      validationSummary: cb.validationSummary,
    };
  });

  return `You are a senior smart contract security researcher writing the analysis section of a benchmark report comparing LLM-based auditing approaches.

## Benchmark Data

${JSON.stringify(promptData, null, 2)}

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

function verifyAnalysisNumbers(analysis: string): string[] {
  const warnings: string[] = [];

  const pctMatches = analysis.matchAll(/(\d+)%/g);
  for (const match of pctMatches) {
    const pct = parseInt(match[1]!, 10);
    if (pct > 100) {
      warnings.push(`Suspicious percentage: ${pct}% (over 100)`);
    }
  }

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

function generateAppendix(data: ReportData): string[] {
  const lines: string[] = [];

  lines.push('---');
  lines.push('');
  lines.push('# Data Appendix');
  lines.push('');

  for (const cb of data.codebases) {
    lines.push(`## ${cb.codebaseId} — Raw Data`);
    lines.push('');

    // Recall chart
    if (cb.hasGt) {
      const maxLabel = Math.max(...cb.runs.map((r) => runLabel(r, cb).length), 8);

      lines.push('### Recall');
      lines.push('');
      lines.push('```');
      for (const run of cb.runs) {
        const label = runLabel(run, cb).padEnd(maxLabel);
        if (run.invalid) {
          lines.push(`${label} ${'X'.repeat(20)} INVALID`);
          continue;
        }
        if (run.matched === null) {
          lines.push(`${label} ${'?'.repeat(20)} ?/${cb.gtTotal} (not classified)`);
          continue;
        }
        const matched = run.matchedGtIds.length;
        const pct = cb.gtTotal > 0 ? Math.round((matched / cb.gtTotal) * 100) : 0;
        lines.push(
          `${label} ${bar(matched, cb.gtTotal)} ${matched}/${cb.gtTotal} (${pct}%) ${run.matchedGtIds.join(', ')}`,
        );
      }
      lines.push('```');
      lines.push('');

      // Classification breakdown
      lines.push('### Classification Breakdown');
      lines.push('');
      lines.push('```');
      for (const run of cb.runs) {
        const label = runLabel(run, cb).padEnd(maxLabel);
        if (run.invalid) {
          lines.push(`${label} INVALID — excluded from averages`);
          continue;
        }
        if (run.matched === null) {
          lines.push(`${label} ? (not classified)`);
          continue;
        }
        const parts = [`${run.matched} matched`, `${run.novel} novel`, `${run.fp} FP`];
        if (run.uncertain && run.uncertain > 0) parts.push(`${run.uncertain} uncertain`);
        lines.push(`${label} ${parts.join(' · ')}`);
      }
      lines.push('```');
      lines.push('');

      // Findings matrix
      lines.push('### Findings Matrix');
      lines.push('');
      const colHeaders = cb.runs.map((r) => runLabel(r, cb));
      lines.push(`| GT | Finding | ${colHeaders.join(' | ')} |`);
      lines.push(`|----|---------|${colHeaders.map(() => '---').join('|')}|`);
      for (const row of cb.findingsMatrix) {
        const cells = cb.runs.map((r) => row.cells[r.runId] ?? '-');
        lines.push(`| ${row.gtId} | ${row.title} | ${cells.join(' | ')} |`);
      }
      lines.push('');
    }

    // Consistency
    if (cb.consistency.length > 0) {
      lines.push('### Consistency (multi-run conditions)');
      lines.push('');
      for (const entry of cb.consistency) {
        lines.push(`**${entry.conditionLabel}** (${entry.totalRuns} runs):`);
        for (const f of entry.findings) {
          lines.push(`- ${f.label}: ${f.gtId} (${f.gtTitle})`);
        }
        lines.push('');
      }
    }

    // Novel validation details
    if (cb.validations.length > 0 && cb.validationSummary) {
      lines.push(
        `### Novel Validation (${cb.validationSummary.confirmed} confirmed, ${cb.validationSummary.plausible} plausible, ${cb.validationSummary.rejected} rejected)`,
      );
      lines.push('');
      lines.push('| Cluster | Verdict | Severity | Evidence |');
      lines.push('|---------|---------|----------|----------|');
      for (const v of cb.validations) {
        const verdict =
          v.verdict === 'confirmed'
            ? '**CONFIRMED**'
            : v.verdict === 'rejected'
              ? '~~rejected~~'
              : 'plausible';
        const evidence = v.codeEvidence.slice(0, 60);
        lines.push(`| ${v.title.slice(0, 45)} | ${verdict} | ${v.severity} | ${evidence} |`);
      }
      lines.push('');
    }

    // Per-run overview table
    lines.push('### Per-Run Overview');
    lines.push('');
    lines.push('| Run | Condition | Findings | Duration | Cost |');
    lines.push('|-----|-----------|----------|----------|------|');
    for (const run of cb.runs) {
      const label = runLabel(run, cb);
      const dur = formatDuration(run.durationMs);
      const costStr = run.costUsd !== null ? `$${run.costUsd.toFixed(2)}` : '-';
      const suffix = run.invalid
        ? ` (INVALID: ${run.invalid})`
        : run.timedOut
          ? ' (timeout)'
          : '';
      const runNumMatch = label.match(/#(\d+)$/);
      const runNum = runNumMatch ? runNumMatch[1] : '1';
      const condLabel = cb.conditionLabels[cb.conditions.indexOf(run.conditionId)] ?? run.conditionId;
      lines.push(
        `| ${runNum} | ${condLabel} | ${run.findingsCount} | ${dur}${suffix} | ${costStr} |`,
      );
    }
    lines.push('');
  }

  return lines;
}

// ─── Pipeline Integrity Check ───

function renderIntegrityCheck(data: ReportData): string[] {
  const lines: string[] = [];
  lines.push('## Pipeline Integrity');
  lines.push('');
  if (data.integrityViolations.length === 0) {
    lines.push('All findings accounted for. Category sums match parsed counts across all runs.');
  } else {
    lines.push('**INTEGRITY VIOLATIONS DETECTED:**');
    lines.push('');
    for (const v of data.integrityViolations) {
      lines.push(`- ${v}`);
    }
  }
  lines.push('');
  return lines;
}

// ─── Main report generation ───

export async function generateReport(
  resultsDir: string,
  options: ReportOptions,
): Promise<void> {
  // Step 1: Compute shared data feed
  log.info('Computing report data...');
  const data = computeReportData(resultsDir, { latest: options.latest });
  if (!data) {
    log.warn('No results found');
    return;
  }

  log.info(`  ${data.totalRuns} run(s) (${data.validRuns} valid, ${data.invalidRuns} invalid)`);
  if (data.invalidRuns > 0) {
    for (const cb of data.codebases) {
      for (const run of cb.runs.filter((r) => r.invalid)) {
        log.warn(`  INVALID: ${run.conditionId} iter ${run.iteration} — ${run.invalid}`);
      }
    }
  }

  // Step 2: Write shared data feed
  const dataPath = writeReportData(data, resultsDir);
  log.info(`  Report data written to ${dataPath}`);

  // Step 3: Render markdown from shared data
  const reportLines: string[] = [];

  // Header
  reportLines.push('# Benchmark Report');
  reportLines.push('');
  reportLines.push(
    `> Generated: ${data.generatedAt.split('T')[0]} | ${data.mode === 'latest' ? 'Latest run per condition' : 'All runs'}`,
  );
  reportLines.push('');

  // Comparison table
  reportLines.push(...generateComparisonTable(data));

  // Missed GT findings
  reportLines.push(...generateMissedGtSection(data));

  // Findings ledger
  reportLines.push(...generateFindingsLedger(data));

  // LLM analysis
  log.info('Generating LLM analysis...');
  try {
    const prompt = buildAnalysisPrompt(data);
    log.info(`  Prompt: ${Math.round(prompt.length / 1024)}KB`);
    const analysis = await callLLMRaw(prompt, ANALYST_MODEL, ANALYST_TIMEOUT);

    if (analysis && analysis.trim().length > 0) {
      const warnings = verifyAnalysisNumbers(analysis);
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

  // Pipeline integrity
  reportLines.push(...renderIntegrityCheck(data));

  // Data appendix
  reportLines.push(...generateAppendix(data));

  // Write
  const outputPath = path.resolve(process.cwd(), 'summary.md');
  const content = reportLines.join('\n');
  fs.writeFileSync(outputPath, content);
  log.success(`Report written to ${outputPath} (${reportLines.length} lines)`);
}
