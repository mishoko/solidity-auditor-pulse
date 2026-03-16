/**
 * Pipeline orchestrator: classify → cluster → validate.
 *
 * Simple linear flow with staleness detection.
 * No verification, no retry-to-FP, no reconciliation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyAllRuns } from './classify.js';
import { clusterAllCodebases } from './cluster.js';
import { validateAllClusters } from './validate.js';
import type { RunMeta } from '../shared/types.js';
import * as log from '../shared/util/logger.js';

export interface PipelineOptions {
  force: boolean;
  validate: boolean;
  report: boolean;
  latest: boolean;
}

// ─── Pre-flight validation ───

interface PreflightFailure {
  file: string;
  reason: string;
}

/**
 * Validate that all files the pipeline will consume exist and parse correctly.
 * Fails fast with a clear listing of problems, before any LLM calls are made.
 */
function preflightCheck(resultsDir: string): PreflightFailure[] {
  const failures: PreflightFailure[] = [];

  const metaFiles = fs.readdirSync(resultsDir).filter((f) => f.endsWith('.meta.json'));

  if (metaFiles.length === 0) {
    failures.push({ file: resultsDir, reason: 'no .meta.json files found' });
    return failures;
  }

  for (const file of metaFiles) {
    const metaPath = path.join(resultsDir, file);

    // Validate meta file parses as JSON with required fields
    let meta: RunMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (err) {
      failures.push({ file, reason: `invalid JSON — ${(err as Error).message}` });
      continue;
    }

    if (!meta.runId || !meta.codebaseId || !meta.conditionId) {
      failures.push({ file, reason: 'missing required fields (runId, codebaseId, or conditionId)' });
      continue;
    }

    // Only check stdout for runs that would be processed (exit 0 or 143)
    if (meta.exitCode !== 0 && meta.exitCode !== 143) continue;

    // Validate stdout file exists and is non-empty
    const stdoutPath = path.join(resultsDir, `${meta.runId}.stdout.txt`);
    if (!fs.existsSync(stdoutPath)) {
      failures.push({ file: `${meta.runId}.stdout.txt`, reason: 'missing (meta says exit 0 but no stdout file)' });
    } else {
      const stat = fs.statSync(stdoutPath);
      if (stat.size === 0) {
        failures.push({ file: `${meta.runId}.stdout.txt`, reason: 'empty file (0 bytes)' });
      }
    }
  }

  // Validate ground truth files (if they exist, they must parse)
  const gtDir = path.resolve(process.cwd(), 'ground_truth');
  if (fs.existsSync(gtDir)) {
    const gtFiles = fs.readdirSync(gtDir).filter((f) => f.endsWith('.json'));
    for (const file of gtFiles) {
      const gtPath = path.join(gtDir, file);
      try {
        const gt = JSON.parse(fs.readFileSync(gtPath, 'utf8'));
        if (!gt.findings || !Array.isArray(gt.findings)) {
          failures.push({ file: `ground_truth/${file}`, reason: 'missing or invalid "findings" array' });
        }
      } catch (err) {
        failures.push({ file: `ground_truth/${file}`, reason: `invalid JSON — ${(err as Error).message}` });
      }
    }
  }

  return failures;
}

export async function runPipeline(
  resultsDir: string,
  options: PipelineOptions,
): Promise<void> {
  const startTime = Date.now();

  log.info('Pipeline starting');
  log.separator();

  // ── Pre-flight: validate all input files before any LLM calls ──
  log.info('Pre-flight check...');
  const failures = preflightCheck(resultsDir);
  if (failures.length > 0) {
    log.error(`Pre-flight failed — ${failures.length} file(s) have problems:`);
    for (const f of failures) {
      log.error(`  ✗ ${f.file} — ${f.reason}`);
    }
    log.error('Fix or remove the broken files before running the pipeline.');
    process.exit(1);
  }

  const metaCount = fs.readdirSync(resultsDir).filter((f) => f.endsWith('.meta.json')).length;
  log.success(`Pre-flight OK — ${metaCount} run(s) validated`);
  log.separator();

  // ── Step 1: Classify (only codebases with GT) ──
  log.info('Step 1/3: Classify findings against ground truth');
  const classifications = await classifyAllRuns(resultsDir, {
    force: options.force,
  });
  log.separator();

  // ── Step 2: Cluster (all codebases — GT and no-GT) ──
  log.info('Step 2/3: Cluster findings by root cause');
  await clusterAllCodebases(resultsDir, classifications, {
    force: options.force,
    scopeFiles: options.validate, // only add file scoping when validation will run
  });
  log.separator();

  // ── Step 3: Validate (optional) ──
  if (options.validate) {
    log.info('Step 3/3: Validate clusters against source code');
    await validateAllClusters(resultsDir, { force: options.force });
  } else {
    log.info('Step 3/3: Validation — skipped (--no-validate)');
  }
  log.separator();

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  log.success(`Pipeline complete in ${elapsed}s`);

  if (options.report) {
    log.info('Generating report...');
    const { generateReport } = await import('../reports/report.js');
    await generateReport(resultsDir, { latest: options.latest });
  }
}
