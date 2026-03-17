import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { collectAllFindings } from '../../src/classifier/cluster.js';

/**
 * Test that no-GT clustering context includes rich descriptions.
 *
 * Uses the report-data-input fixtures which have parseable stdout files.
 * Verifies that collectAllFindings produces ClusterInputs with
 * meaningful reasoning (not just "Location: X. Type: Y.").
 */

const FIXTURES_DIR = path.resolve(import.meta.dirname, '../fixtures/report-data-input');

describe('collectAllFindings context quality', () => {
  it('includes description in reasoning for bare format findings', () => {
    const inputs = collectAllFindings(FIXTURES_DIR, 'test-codebase');
    // bare run has findings with descriptions
    const bareInputs = inputs.filter((i) => i.conditionId === 'bare_audit');

    expect(bareInputs.length).toBeGreaterThan(0);
    for (const input of bareInputs) {
      // Reasoning should be more than just "Location: X. Type: Y."
      expect(
        input.reasoning.length,
        `finding "${input.findingTitle}" has thin reasoning: "${input.reasoning}"`,
      ).toBeGreaterThan(30);
    }
  });

  it('includes description in reasoning for skill format findings', () => {
    const inputs = collectAllFindings(FIXTURES_DIR, 'test-codebase');
    const skillInputs = inputs.filter((i) => i.conditionId === 'skill_v2');

    expect(skillInputs.length).toBeGreaterThan(0);
    for (const input of skillInputs) {
      expect(
        input.reasoning.length,
        `finding "${input.findingTitle}" has thin reasoning: "${input.reasoning}"`,
      ).toBeGreaterThan(30);
    }
  });

  it('reasoning contains the description body, not just location+type', () => {
    const inputs = collectAllFindings(FIXTURES_DIR, 'test-codebase');
    // Find the reentrancy finding — should mention CEI or drain or re-enter
    const reentry = inputs.find((i) => i.findingTitle.toLowerCase().includes('reentrancy'));
    expect(reentry).toBeDefined();
    // Should contain actual description, not just "Location: Vault.withdraw. Type: reentrancy."
    expect(reentry!.reasoning).toMatch(/checks-effects|drain|re-enter|reentr/i);
  });

  it('preserves Location and Type at the end of reasoning', () => {
    const inputs = collectAllFindings(FIXTURES_DIR, 'test-codebase');
    for (const input of inputs) {
      expect(input.reasoning).toContain('Location:');
      expect(input.reasoning).toContain('Type:');
    }
  });
});
