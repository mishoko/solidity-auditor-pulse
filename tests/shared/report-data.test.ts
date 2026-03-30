import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import { computeReportData, jaccardSimilarity, filterByCodebases, type ReportData } from '../../src/shared/report-data.js';

/**
 * Test computeReportData with fixture files.
 *
 * Fixtures represent a single codebase ("test-codebase") with:
 *   - 3 GT findings (H-01, H-02, M-01)
 *   - 3 runs: 2 × skill_v2, 1 × bare_audit
 *   - 3 novel clusters: flash-loan (confirmed, no riskCategory),
 *     unchecked-return (plausible, no riskCategory),
 *     centralization (confirmed, riskCategory=centralization-risk)
 *
 * Hybrid strategy: explicit assertions for critical metrics,
 * snapshot for full structural shape.
 */

const FIXTURES_DIR = path.resolve(import.meta.dirname, '../fixtures/report-data-input');

let data: ReportData;

beforeAll(() => {
  // computeReportData resolves GT relative to resultsDir/../ground_truth
  // We need to trick it by setting up the path correctly.
  // The function does: path.resolve(resultsDir, '..', 'ground_truth')
  // So resultsDir/../ground_truth must point to our GT fixture.
  // We'll symlink or just override by passing a custom path.

  // Since computeReportData hardcodes the GT path relative to resultsDir,
  // we need our fixture dir structure to match:
  //   fixtures/report-data-input/  (resultsDir)
  //   fixtures/ground_truth/       (GT dir — one level up from resultsDir + ground_truth)

  const result = computeReportData(FIXTURES_DIR, { latest: false });
  expect(result).not.toBeNull();
  data = result!;
});

// ─── Top-level structure ───

describe('top-level fields', () => {
  it('has correct run counts', () => {
    expect(data.totalRuns).toBe(3);
    expect(data.validRuns).toBe(3);
    expect(data.invalidRuns).toBe(0);
  });

  it('discovers the codebase', () => {
    expect(data.codebaseIds).toEqual(['test-codebase']);
    expect(data.codebases).toHaveLength(1);
  });

  it('mode is all', () => {
    expect(data.mode).toBe('all');
  });
});

// ─── GT missed by all ───

describe('GT missed-by-all', () => {
  it('counts M-01 as missed by all conditions', () => {
    // H-01 matched by skill runs 1&2 + bare. H-02 matched by skill-1 + bare.
    // M-01 never matched by anyone.
    expect(data.gtMissedByAllTotal).toBe(1);
    expect(data.gtTotalAll).toBe(3);
    expect(data.gtMissedByAllPercent).toBe(33);
  });
});

// ─── Per-codebase data ───

describe('codebase data', () => {
  it('has GT info', () => {
    const cb = data.codebases[0]!;
    expect(cb.hasGt).toBe(true);
    expect(cb.gtTotal).toBe(3);
  });

  it('has correct conditions in order', () => {
    const cb = data.codebases[0]!;
    // Skills sort before bare_audit (baseline always last)
    expect(cb.conditions).toEqual(['skill_v2', 'bare_audit']);
    expect(cb.conditionLabels).toEqual(['skill_v2', 'Bare CC']);
  });

  it('has correct number of runs', () => {
    const cb = data.codebases[0]!;
    expect(cb.runs).toHaveLength(3);
  });

  it('assigns sequential run numbers per condition', () => {
    const cb = data.codebases[0]!;
    const skillRuns = cb.runs.filter((r) => r.conditionId === 'skill_v2');
    const bareRuns = cb.runs.filter((r) => r.conditionId === 'bare_audit');
    expect(skillRuns.map((r) => r.runNumber)).toEqual([1, 2]);
    expect(bareRuns.map((r) => r.runNumber)).toEqual([1]);
  });
});

// ─── Condition aggregates (critical metrics — explicit assertions) ───

describe('V2 condition aggregate', () => {
  let agg: ReportData['codebases'][0]['aggregates'][0];

  beforeAll(() => {
    const cb = data.codebases[0]!;
    agg = cb.aggregates.find((a) => a.conditionId === 'skill_v2')!;
    expect(agg).toBeDefined();
  });

  it('has correct run counts', () => {
    expect(agg.validRuns).toBe(2);
    expect(agg.totalRuns).toBe(2);
  });

  it('computes recall correctly', () => {
    // Run 1: matched H-01, H-02 (2/3 = 0.667)
    // Run 2: matched H-01 only (1/3 = 0.333)
    // Average matched = (2+1)/2 = 1.5, recall = 1.5/3 = 0.5
    expect(agg.avgRecall).toBeCloseTo(0.5);
    expect(agg.avgMatched).toBeCloseTo(1.5);
    expect(agg.gtTotal).toBe(3);
  });

  it('computes FP metrics correctly', () => {
    // Run 1: 1 FP out of 4 classified. Run 2: 0 FP out of 3 classified.
    // totalFp = 1, totalFindings = 4+3 = 7, fpRate = 1/7
    expect(agg.totalFp).toBe(1);
    expect(agg.totalFindings).toBe(7);
    expect(agg.fpRate).toBeCloseTo(1 / 7);
    expect(agg.avgFp).toBeCloseTo(0.5);
  });

  it('computes novel findings correctly (unfiltered)', () => {
    // Clusters caught by skill_v2: flash-loan (confirmed), unchecked-return (plausible), centralization (confirmed+centralization-risk)
    expect(agg.confirmedNovels).toBe(2);
    expect(agg.plausibleNovels).toBe(1);
  });

  it('computes novel findings correctly (filtered)', () => {
    // Filtered: excludes centralization-risk
    // flash-loan confirmed (no riskCategory) → counted
    // centralization confirmed (riskCategory=centralization-risk) → excluded
    expect(agg.confirmedNovelsFiltered).toBe(1);
    // unchecked-return plausible (no riskCategory) → counted
    expect(agg.plausibleNovelsFiltered).toBe(1);
  });

  it('computes cost and duration', () => {
    expect(agg.avgDurationMs).toBeCloseTo(125000); // (120000 + 130000) / 2
  });

  it('computes consistency', () => {
    // Run 1 matched: {H-01, H-02}, Run 2 matched: {H-01}
    // Jaccard = |{H-01}| / |{H-01, H-02}| = 1/2 = 0.5
    expect(agg.consistency).toBeCloseTo(0.5);
  });
});

describe('Bare CC condition aggregate', () => {
  let agg: ReportData['codebases'][0]['aggregates'][0];

  beforeAll(() => {
    const cb = data.codebases[0]!;
    agg = cb.aggregates.find((a) => a.conditionId === 'bare_audit')!;
    expect(agg).toBeDefined();
  });

  it('has correct run counts', () => {
    expect(agg.validRuns).toBe(1);
    expect(agg.totalRuns).toBe(1);
  });

  it('computes recall correctly', () => {
    // Matched H-01, H-02 → 2/3
    expect(agg.avgRecall).toBeCloseTo(2 / 3);
    expect(agg.avgMatched).toBeCloseTo(2);
  });

  it('computes FP correctly', () => {
    // 1 FP (Floating Pragma) out of 4 classified
    expect(agg.totalFp).toBe(1);
    expect(agg.fpRate).toBeCloseTo(0.25);
  });

  it('computes novel findings correctly', () => {
    // Bare catches flash-loan cluster (confirmed, no riskCategory)
    expect(agg.confirmedNovels).toBe(1);
    expect(agg.confirmedNovelsFiltered).toBe(1);
    // No plausible clusters caught by bare
    expect(agg.plausibleNovels).toBe(0);
    expect(agg.plausibleNovelsFiltered).toBe(0);
  });

  it('has no consistency (single run)', () => {
    expect(agg.consistency).toBeNull();
  });
});

// ─── Ledger ───

describe('findings ledger', () => {
  it('has correct number of rows', () => {
    const cb = data.codebases[0]!;
    // 3 GT + 3 novel clusters + 2 FP titles (Gas Optimization, Floating Pragma)
    expect(cb.ledger.length).toBeGreaterThanOrEqual(5);
  });

  it('GT findings come first (sortKey 0)', () => {
    const cb = data.codebases[0]!;
    const gtRows = cb.ledger.filter((r) => r.sortKey === 0);
    expect(gtRows).toHaveLength(3);
    // Sorted by GT ID
    expect(gtRows.map((r) => r.gtId)).toEqual(['H-01', 'H-02', 'M-01']);
  });

  it('confirmed novels come next (sortKey 1)', () => {
    const cb = data.codebases[0]!;
    const confirmed = cb.ledger.filter((r) => r.status === 'confirmed');
    expect(confirmed.length).toBeGreaterThanOrEqual(1);
    expect(confirmed[0]!.sortKey).toBe(1);
  });

  it('FP rows have sortKey 4', () => {
    const cb = data.codebases[0]!;
    const fpRows = cb.ledger.filter((r) => r.status === 'FP');
    expect(fpRows.length).toBeGreaterThanOrEqual(1);
    for (const row of fpRows) {
      expect(row.sortKey).toBe(4);
    }
  });

  it('ledger is deterministically sorted', () => {
    const cb = data.codebases[0]!;
    // Verify sortKeys are non-decreasing
    for (let i = 1; i < cb.ledger.length; i++) {
      expect(cb.ledger[i]!.sortKey).toBeGreaterThanOrEqual(cb.ledger[i - 1]!.sortKey);
    }
  });
});

// ─── Ledger novel cluster cells ───

describe('ledger novel cluster cells', () => {
  it('flash-loan cluster shows presence in both V2 and Bare', () => {
    const cb = data.codebases[0]!;
    const flashLoan = cb.ledger.find((r) => r.title.includes('Flash Loan'));
    expect(flashLoan).toBeDefined();
    // Both skill_v2 and bare_audit contributed findings to this cluster
    expect(flashLoan!.conditionCells['skill_v2']).not.toBe('-');
    expect(flashLoan!.conditionCells['bare_audit']).not.toBe('-');
  });

  it('FP findings are deduplicated by title', () => {
    const cb = data.codebases[0]!;
    const fpRows = cb.ledger.filter((r) => r.status === 'FP');
    const fpTitles = fpRows.map((r) => r.title);
    // No duplicate titles
    expect(new Set(fpTitles).size).toBe(fpTitles.length);
  });
});

// ─── Invalid run handling ───

describe('invalid run handling', () => {
  it('no runs marked invalid in fixture data', () => {
    const cb = data.codebases[0]!;
    const invalidRuns = cb.runs.filter((r) => r.invalid);
    expect(invalidRuns).toHaveLength(0);
  });

  it('all runs contribute to valid run count', () => {
    expect(data.validRuns).toBe(3);
    expect(data.invalidRuns).toBe(0);
  });

  it('avgFindingsCount only from valid runs', () => {
    const cb = data.codebases[0]!;
    const v2 = cb.aggregates.find((a) => a.conditionId === 'skill_v2')!;
    // Run 1: 4 findings, Run 2: 3 findings → avg = 3.5
    expect(v2.avgFindingsCount).toBeCloseTo(3.5);
  });
});

// ─── Missed GT ───

describe('missed GT findings', () => {
  it('identifies M-01 as missed', () => {
    const cb = data.codebases[0]!;
    expect(cb.missedGt).toHaveLength(1);
    expect(cb.missedGt[0]!.id).toBe('M-01');
  });
});

// ─── Validation entries ───

describe('validation entries', () => {
  it('has all 3 cluster validations', () => {
    const cb = data.codebases[0]!;
    expect(cb.validations).toHaveLength(3);
  });

  it('carries risk category through', () => {
    const cb = data.codebases[0]!;
    const centralization = cb.validations.find((v) => v.clusterId === 'novel-centralization');
    expect(centralization).toBeDefined();
    expect(centralization!.riskCategory).toBe('centralization-risk');
  });

  it('has correct validation summary', () => {
    const cb = data.codebases[0]!;
    expect(cb.validationSummary).toEqual({ confirmed: 2, plausible: 1, rejected: 0 });
  });
});

// ─── Cross-codebase aggregates ───

describe('cross-codebase aggregates', () => {
  it('has entries for both conditions', () => {
    expect(data.crossCodebaseAggregates).toHaveLength(2);
    expect(data.crossCodebaseAggregates.map((a) => a.conditionId)).toEqual(['skill_v2', 'bare_audit']);
  });

  it('V2 cross-aggregate matches single-codebase (only 1 codebase)', () => {
    const cross = data.crossCodebaseAggregates.find((a) => a.conditionId === 'skill_v2')!;
    expect(cross.avgRecall).toBeCloseTo(0.5);
    expect(cross.confirmedNovelsFiltered).toBe(1);
    expect(cross.plausibleNovelsFiltered).toBe(1);
  });
});

// ─── MetricBests ───

describe('metricBests', () => {
  it('bare has best recall (0.667 > 0.5)', () => {
    expect(data.metricBests.recall).toContain('bare_audit');
  });

  it('identifies lowest FP rate', () => {
    // V2: 1/7 ≈ 0.143, Bare: 1/4 = 0.25 → V2 is lower
    expect(data.metricBests.fpRate).toContain('skill_v2');
  });
});

// ─── Risk category exclusion count ───

describe('totalExcludedByRiskCategory', () => {
  it('counts centralization-risk as excluded', () => {
    // 1 cluster has riskCategory and is confirmed/plausible
    expect(data.totalExcludedByRiskCategory).toBe(1);
  });
});

// ─── Integrity ───

describe('integrity', () => {
  it('has no integrity violations', () => {
    expect(data.integrityViolations).toHaveLength(0);
  });
});

// ─── Findings matrix ───

describe('findings matrix', () => {
  it('has rows for all 3 GT findings', () => {
    const cb = data.codebases[0]!;
    expect(cb.findingsMatrix).toHaveLength(3);
    expect(cb.findingsMatrix.map((r) => r.gtId)).toEqual(['H-01', 'H-02', 'M-01']);
  });

  it('H-01 found in all runs', () => {
    const cb = data.codebases[0]!;
    const h01 = cb.findingsMatrix.find((r) => r.gtId === 'H-01')!;
    expect(h01.cells['run-skill-1']).toBe('1/1');
    expect(h01.cells['run-skill-2']).toBe('1/1');
    expect(h01.cells['run-bare-1']).toBe('1/1');
  });

  it('M-01 not found in any run', () => {
    const cb = data.codebases[0]!;
    const m01 = cb.findingsMatrix.find((r) => r.gtId === 'M-01')!;
    expect(m01.cells['run-skill-1']).toBe('-');
    expect(m01.cells['run-skill-2']).toBe('-');
    expect(m01.cells['run-bare-1']).toBe('-');
  });
});

// ─── jaccardSimilarity (pure logic) ───

describe('jaccardSimilarity', () => {
  it('returns null for single set', () => {
    expect(jaccardSimilarity([new Set(['a', 'b'])])).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(jaccardSimilarity([])).toBeNull();
  });

  it('identical sets → 1.0', () => {
    const s = new Set(['H-01', 'H-02']);
    expect(jaccardSimilarity([s, s])).toBeCloseTo(1.0);
  });

  it('disjoint sets → 0.0', () => {
    const a = new Set(['H-01']);
    const b = new Set(['M-01']);
    expect(jaccardSimilarity([a, b])).toBeCloseTo(0.0);
  });

  it('partial overlap → correct ratio', () => {
    const a = new Set(['H-01', 'H-02']);
    const b = new Set(['H-01']);
    // intersection = {H-01}, union = {H-01, H-02} → 1/2
    expect(jaccardSimilarity([a, b])).toBeCloseTo(0.5);
  });

  it('two empty sets → 1.0 (both found nothing = perfect agreement)', () => {
    expect(jaccardSimilarity([new Set(), new Set()])).toBeCloseTo(1.0);
  });

  it('three sets → average of all pairs', () => {
    const a = new Set(['H-01', 'H-02']);
    const b = new Set(['H-01', 'H-02']);
    const c = new Set(['H-01']);
    // pair(a,b) = 1.0, pair(a,c) = 0.5, pair(b,c) = 0.5
    // average = (1.0 + 0.5 + 0.5) / 3 = 0.667
    expect(jaccardSimilarity([a, b, c])).toBeCloseTo(2 / 3);
  });
});

// ─── filterByCodebases ───

describe('filterByCodebases', () => {
  it('returns aggregates for the filtered codebase', () => {
    const filtered = filterByCodebases(data, new Set(['test-codebase']));
    expect(filtered.codebaseIds).toEqual(['test-codebase']);
    expect(filtered.aggregates.length).toBeGreaterThan(0);
  });

  it('metrics match full data when filtering to all codebases', () => {
    const filtered = filterByCodebases(data, new Set(['test-codebase']));
    const v2Full = data.crossCodebaseAggregates.find((a) => a.conditionId === 'skill_v2')!;
    const v2Filtered = filtered.aggregates.find((a) => a.conditionId === 'skill_v2')!;
    // Single codebase → filtered should match full
    expect(v2Filtered.avgRecall).toBeCloseTo(v2Full.avgRecall!);
    expect(v2Filtered.confirmedNovelsFiltered).toBe(v2Full.confirmedNovelsFiltered);
  });

  it('respects visibleConditions filter', () => {
    const filtered = filterByCodebases(
      data,
      new Set(['test-codebase']),
      new Set(['skill_v2']),
    );
    expect(filtered.aggregates).toHaveLength(1);
    expect(filtered.aggregates[0]!.conditionId).toBe('skill_v2');
  });

  it('computes metricBests for filtered set', () => {
    const filtered = filterByCodebases(data, new Set(['test-codebase']));
    expect(filtered.metricBests.recall.length).toBeGreaterThan(0);
    expect(filtered.metricBests.fpRate.length).toBeGreaterThan(0);
  });

  it('computes GT missed stats for filtered set', () => {
    const filtered = filterByCodebases(data, new Set(['test-codebase']));
    expect(filtered.gtTotalAll).toBe(3);
    expect(filtered.gtMissedByAllTotal).toBe(1);
    expect(filtered.gtMissedByAllPercent).toBe(33);
  });

  it('returns empty aggregates for unknown codebase', () => {
    const filtered = filterByCodebases(data, new Set(['nonexistent']));
    expect(filtered.aggregates).toHaveLength(0);
    expect(filtered.gtTotalAll).toBe(0);
  });
});

// ─── Full shape snapshot (structural drift catch) ───

describe('full shape snapshot', () => {
  it('matches snapshot (excluding timestamp)', () => {
    // Strip generatedAt since it changes every run
    const { generatedAt, ...stable } = data;
    expect(stable).toMatchSnapshot();
  });
});
