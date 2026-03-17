import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { computeReportData, writeReportData } from '../../src/shared/report-data.js';

/**
 * Test that report-data.json (the shared feed consumed by the dashboard)
 * is correctly written and contains all fields the dashboard needs.
 *
 * The dashboard's main() runs at import time, so direct import testing
 * is not possible. Instead we validate the data contract — if the feed
 * has the right shape, the dashboard (a pure renderer) will work.
 */

const FIXTURES_DIR = path.resolve(import.meta.dirname, '../fixtures/report-data-input');
const RD_PATH = path.join(FIXTURES_DIR, 'report-data.json');

describe('dashboard data contract', () => {
  it('writes report-data.json with all dashboard-required fields', () => {
    const data = computeReportData(FIXTURES_DIR, { latest: false });
    expect(data).not.toBeNull();

    writeReportData(data!, FIXTURES_DIR);
    expect(fs.existsSync(RD_PATH)).toBe(true);

    const loaded = JSON.parse(fs.readFileSync(RD_PATH, 'utf8'));

    // Top-level fields the dashboard reads
    expect(loaded.codebaseIds).toBeDefined();
    expect(loaded.gtTotalAll).toBeTypeOf('number');
    expect(loaded.gtMissedByAllTotal).toBeTypeOf('number');
    expect(loaded.gtMissedByAllPercent).toBeTypeOf('number');
    expect(loaded.totalExcludedByRiskCategory).toBeTypeOf('number');
    expect(loaded.generatedAt).toBeTypeOf('string');
  });

  it('crossCodebaseAggregates have all dashboard metric fields', () => {
    const data = computeReportData(FIXTURES_DIR, { latest: false })!;

    for (const agg of data.crossCodebaseAggregates) {
      // Every field the dashboard reads
      expect(agg).toHaveProperty('conditionId');
      expect(agg).toHaveProperty('label');
      expect(agg).toHaveProperty('subtitle');
      expect(agg).toHaveProperty('validRuns');
      expect(agg).toHaveProperty('avgRecall');
      expect(agg).toHaveProperty('confirmedNovelsFiltered');
      expect(agg).toHaveProperty('plausibleNovelsFiltered');
      expect(agg).toHaveProperty('fpRate');
      expect(agg).toHaveProperty('consistency');
      expect(agg).toHaveProperty('avgCost');
      expect(agg).toHaveProperty('avgDurationMs');
    }
  });

  it('metricBests have all dashboard highlight fields', () => {
    const data = computeReportData(FIXTURES_DIR, { latest: false })!;

    expect(data.metricBests).toHaveProperty('recall');
    expect(data.metricBests).toHaveProperty('confirmedNovelsFiltered');
    expect(data.metricBests).toHaveProperty('fpRate');
    expect(data.metricBests).toHaveProperty('consistency');
    expect(data.metricBests).toHaveProperty('avgCost');
    expect(data.metricBests).toHaveProperty('avgDuration');
  });

  it('per-codebase aggregates have fields for filtered dashboard view', () => {
    const data = computeReportData(FIXTURES_DIR, { latest: false })!;

    for (const cb of data.codebases) {
      for (const agg of cb.aggregates) {
        expect(agg).toHaveProperty('conditionId');
        expect(agg).toHaveProperty('validRuns');
        expect(agg).toHaveProperty('avgRecall');
        expect(agg).toHaveProperty('avgMatched');
        expect(agg).toHaveProperty('gtTotal');
        expect(agg).toHaveProperty('confirmedNovelsFiltered');
        expect(agg).toHaveProperty('plausibleNovelsFiltered');
        expect(agg).toHaveProperty('totalFp');
        expect(agg).toHaveProperty('totalFindings');
        expect(agg).toHaveProperty('consistency');
        expect(agg).toHaveProperty('avgCost');
        expect(agg).toHaveProperty('avgDurationMs');
      }
    }
  });

  it('existing dashboard.html has correct structure', () => {
    const htmlPath = path.resolve(import.meta.dirname, '../../dashboard.html');
    if (!fs.existsSync(htmlPath)) return; // skip on clean builds

    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Skills Auditor Benchmark');
    expect(html).toContain('GT Recall');
    expect(html).toContain('Confirmed Novel Findings');
    expect(html).toContain('Conditional Novel Findings');
    expect(html).toContain('False Positive Rate');
    expect(html).toContain('Consistency');
  });
});

afterAll(() => {
  if (fs.existsSync(RD_PATH)) fs.unlinkSync(RD_PATH);
});
