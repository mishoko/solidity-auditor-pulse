import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { setLLMProvider, resetLLMProvider, type LLMProvider } from '../../src/classifier/llm.js';

/**
 * Test the report generator end-to-end using fixture data.
 *
 * Since generateReport() writes to disk and calls LLM, we test by:
 *   1. Computing ReportData from fixtures (same as report-data.test.ts)
 *   2. Importing and calling the deterministic rendering functions
 *   3. Snapshot the output (excluding LLM narrative which is non-deterministic)
 *
 * The LLM narrative is replaced with a fake via LLMProvider.
 */

const FIXTURES_DIR = path.resolve(import.meta.dirname, '../fixtures/report-data-input');

class FakeAnalyst implements LLMProvider {
  async call(_prompt: string, _model: string, _timeout: number): Promise<string> {
    return '### 1. Executive Analysis\n\nTest analysis paragraph.\n\n### 2. Condition Comparison\n\nV2 performed well. Bare CC was cheaper.\n\n### 3. Recommendation\n\n- Use V2 for production\n- Use Bare CC for cost-sensitive runs';
  }
}

beforeAll(() => {
  setLLMProvider(new FakeAnalyst());
});

afterAll(() => {
  resetLLMProvider();
});

describe('report generation', () => {
  it('generates report via generateReport()', async () => {
    // Import generateReport dynamically to use the fake provider
    const { generateReport } = await import('../../src/reports/report.js');

    // Use a temp directory for output
    const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, 'tmp-report-'));
    const origCwd = process.cwd();

    try {
      // generateReport writes summary.md to cwd and report-data.json to resultsDir
      process.chdir(tmpDir);
      await generateReport(FIXTURES_DIR, { latest: false });

      const summaryPath = path.join(tmpDir, 'summary.md');
      expect(fs.existsSync(summaryPath)).toBe(true);

      const content = fs.readFileSync(summaryPath, 'utf8');

      // Structural checks — report must contain these sections
      expect(content).toContain('# Benchmark Report');
      expect(content).toContain('## Comparison');
      expect(content).toContain('## Findings Ledger');
      expect(content).toContain('# Data Appendix');
      expect(content).toContain('## Pipeline Integrity');

      // Must contain both conditions
      expect(content).toContain('V2');
      expect(content).toContain('Bare CC');

      // Must contain GT recall data
      expect(content).toContain('Recall (GT)');
      expect(content).toContain('1.5/3');   // V2 recall
      expect(content).toContain('2/3');     // Bare recall

      // Must contain missed GT
      expect(content).toContain('## Missed GT Findings');
      expect(content).toContain('M-01');

      // Must contain novel findings
      expect(content).toContain('Novel confirmed');

      // Must contain filtered exclusion sub-row
      expect(content).toContain('centralization/informational');

      // Must contain conditional novel findings
      expect(content).toContain('Conditional novel');

      // Must contain integrity check
      expect(content).toContain('All findings accounted for');

      // Must contain LLM narrative (from fake)
      expect(content).toContain('Executive Analysis');

      // Must contain data appendix sections
      expect(content).toContain('### Recall');
      expect(content).toContain('### Classification Breakdown');
      expect(content).toContain('### Findings Matrix');
      expect(content).toContain('### Per-Run Overview');

      // Snapshot the full content (excludes timestamps via generated date)
      // Strip the date line which changes
      const stable = content.replace(/Generated: \d{4}-\d{2}-\d{2}/, 'Generated: DATE');
      expect(stable).toMatchSnapshot();
    } finally {
      process.chdir(origCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
