import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseOutput, classifyVuln, extractUnmatchedBlocks } from '../../src/shared/parser.js';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/parser-samples');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// ─── Skill format ───

describe('parseOutput — skill format', () => {
  const result = parseOutput(loadFixture('skill-format.txt'));

  it('detects skill format', () => {
    expect(result.format).toBe('skill');
  });

  it('extracts all findings', () => {
    expect(result.findings).toHaveLength(3);
  });

  it('parses confidence scores', () => {
    expect(result.findings.map((f) => f.confidence)).toEqual([95, 80, 60]);
  });

  it('parses titles', () => {
    expect(result.findings[0]!.title).toBe('Reentrancy in Vault.withdraw allows drain');
    expect(result.findings[1]!.title).toBe('Missing Access Control on TokenSale.setPrice');
  });

  it('extracts locations from backtick notation', () => {
    expect(result.findings[0]!.location).toBe('Vault.withdraw');
    expect(result.findings[1]!.location).toBe('TokenSale.setPrice');
    expect(result.findings[2]!.location).toBe('PriceOracle.getPrice');
  });

  it('assigns sequential indices', () => {
    expect(result.findings.map((f) => f.index)).toEqual([1, 2, 3]);
  });

  it('counts reported findings from table', () => {
    expect(result.reportedCount).toBe(3);
  });

  it('severity is null for skill format', () => {
    expect(result.findings.every((f) => f.severity === null)).toBe(true);
  });

  it('generates root cause keys', () => {
    expect(result.findings[0]!.rootCause).toBe('vault::withdraw::reentrancy');
    expect(result.findings[1]!.rootCause).toBe('tokensale::setprice::access-control');
    // "Flash Loan" keyword matches before "oracle" in VULN_KEYWORDS order
    expect(result.findings[2]!.rootCause).toBe('priceoracle::getprice::flash-loan');
  });

  it('matches snapshot', () => {
    expect(result.findings).toMatchSnapshot();
  });
});

// ─── Bare format: [SEVERITY] Title ───

describe('parseOutput — bare severity brackets', () => {
  const result = parseOutput(loadFixture('bare-severity-brackets.txt'));

  it('detects bare format', () => {
    expect(result.format).toBe('bare');
  });

  it('extracts all findings', () => {
    expect(result.findings).toHaveLength(4);
  });

  it('parses severity levels', () => {
    expect(result.findings.map((f) => f.severity)).toEqual([
      'CRITICAL',
      'HIGH',
      'MEDIUM',
      'LOW',
    ]);
  });

  it('extracts location from title', () => {
    expect(result.findings[0]!.location).toBe('Vault.withdraw');
  });

  it('extracts location from explicit location string', () => {
    expect(result.findings[1]!.location).toBe('TokenSale.setPrice');
  });

  it('counts reported findings from summary table', () => {
    expect(result.reportedCount).toBe(4);
  });

  it('confidence is null for bare format', () => {
    expect(result.findings.every((f) => f.confidence === null)).toBe(true);
  });

  it('matches snapshot', () => {
    expect(result.findings).toMatchSnapshot();
  });
});

// ─── Bare format: H-1: Title ───

describe('parseOutput — bare numbered prefix', () => {
  const result = parseOutput(loadFixture('bare-numbered-prefix.txt'));

  it('detects bare format', () => {
    expect(result.format).toBe('bare');
  });

  it('extracts all findings', () => {
    expect(result.findings).toHaveLength(4);
  });

  it('maps severity letters to words', () => {
    expect(result.findings.map((f) => f.severity)).toEqual([
      'HIGH',
      'HIGH',
      'MEDIUM',
      'LOW',
    ]);
  });

  it('extracts locations from titles', () => {
    expect(result.findings[0]!.location).toBe('Vault.withdraw');
    expect(result.findings[1]!.location).toBe('PriceOracle.getPrice');
    expect(result.findings[2]!.location).toBe('Bridge.deposit');
  });

  it('matches snapshot', () => {
    expect(result.findings).toMatchSnapshot();
  });
});

// ─── Bare format: [H-1] Title ───

describe('parseOutput — bare bracketed numbered', () => {
  const result = parseOutput(loadFixture('bare-bracketed-numbered.txt'));

  it('detects bare format', () => {
    expect(result.format).toBe('bare');
  });

  it('extracts all findings', () => {
    expect(result.findings).toHaveLength(2);
  });

  it('maps severity letters', () => {
    expect(result.findings[0]!.severity).toBe('HIGH');
    expect(result.findings[1]!.severity).toBe('MEDIUM');
  });

  it('matches snapshot', () => {
    expect(result.findings).toMatchSnapshot();
  });
});

// ─── Bare format: ### N. Title — **SEVERITY** ───

describe('parseOutput — bare trailing severity', () => {
  const result = parseOutput(loadFixture('bare-trailing-severity.txt'));

  it('detects bare format', () => {
    expect(result.format).toBe('bare');
  });

  it('extracts all findings', () => {
    expect(result.findings).toHaveLength(3);
  });

  it('parses trailing severity', () => {
    expect(result.findings.map((f) => f.severity)).toEqual([
      'CRITICAL',
      'HIGH',
      'LOW',
    ]);
  });

  it('matches snapshot', () => {
    expect(result.findings).toMatchSnapshot();
  });
});

// ─── Bare format: ### N. Title (Severity) ───

describe('parseOutput — bare parenthesized severity', () => {
  const result = parseOutput(loadFixture('bare-paren-severity.txt'));

  it('detects bare format', () => {
    expect(result.format).toBe('bare');
  });

  it('extracts all findings', () => {
    expect(result.findings).toHaveLength(3);
  });

  it('parses parenthesized severity', () => {
    expect(result.findings.map((f) => f.severity)).toEqual([
      'CRITICAL',
      'HIGH',
      'MEDIUM',
    ]);
  });

  it('classifies vulnerability types', () => {
    expect(result.findings[0]!.vulnType).toBe('reentrancy');
    expect(result.findings[1]!.vulnType).toBe('frontrunning');
    expect(result.findings[2]!.vulnType).toBe('delegatecall');
  });

  it('matches snapshot', () => {
    expect(result.findings).toMatchSnapshot();
  });
});

// ─── Bare format: section-based severity ───

describe('parseOutput — bare section numbered', () => {
  const result = parseOutput(loadFixture('bare-section-numbered.txt'));

  it('detects bare format', () => {
    expect(result.format).toBe('bare');
  });

  it('extracts all findings', () => {
    expect(result.findings).toHaveLength(4);
  });

  it('inherits severity from section headers', () => {
    expect(result.findings.map((f) => f.severity)).toEqual([
      'HIGH',
      'HIGH',
      'MEDIUM',
      'LOW',
    ]);
  });

  it('matches snapshot', () => {
    expect(result.findings).toMatchSnapshot();
  });
});

// ─── Empty input ───

describe('parseOutput — empty input', () => {
  const result = parseOutput('');

  it('returns unknown format', () => {
    expect(result.format).toBe('unknown');
  });

  it('returns no findings', () => {
    expect(result.findings).toHaveLength(0);
  });

  it('reports null count', () => {
    expect(result.reportedCount).toBeNull();
  });
});

// ─── classifyVuln ───

describe('classifyVuln', () => {
  it('detects reentrancy', () => {
    expect(classifyVuln('Reentrancy in withdraw')).toBe('reentrancy');
  });

  it('detects access control', () => {
    expect(classifyVuln('Missing Access Control on setPrice')).toBe('access-control');
  });

  it('detects oracle manipulation', () => {
    expect(classifyVuln('Oracle Price Manipulation')).toBe('oracle-manipulation');
  });

  it('detects frontrunning', () => {
    expect(classifyVuln('Front-Running Attack on Buy')).toBe('frontrunning');
  });

  it('detects flash loan', () => {
    expect(classifyVuln('Flash Loan Attack Vector')).toBe('flash-loan');
  });

  it('detects overflow', () => {
    expect(classifyVuln('Integer Overflow in Multiply')).toBe('overflow');
  });

  it('detects delegatecall', () => {
    expect(classifyVuln('Unsafe Delegatecall Proxy')).toBe('delegatecall');
  });

  it('returns other for unknown', () => {
    expect(classifyVuln('Some Generic Issue')).toBe('other');
  });
});

// ─── extractUnmatchedBlocks ───

describe('extractUnmatchedBlocks', () => {
  it('returns no unmatched blocks for clean bare format', () => {
    const text = loadFixture('bare-severity-brackets.txt');
    const parsed = parseOutput(text);
    const unmatched = extractUnmatchedBlocks(text, parsed.findings);
    expect(unmatched).toHaveLength(0);
  });

  it('detects vulnerability headings not in parsed findings', () => {
    const text = `## Report

### [HIGH] Known Reentrancy Bug

Some description of the vulnerability.

### Missed Overflow Vulnerability

This has an integer overflow that was not captured.`;

    const parsed = parseOutput(text);
    const unmatched = extractUnmatchedBlocks(text, parsed.findings);
    // The "Missed Overflow" heading should be detected as unmatched
    expect(unmatched.length).toBeGreaterThan(0);
  });

  it('ignores section headers', () => {
    const text = `## Summary

Overview of the audit.

## Methodology

How we conducted the audit.`;

    const unmatched = extractUnmatchedBlocks(text, []);
    expect(unmatched).toHaveLength(0);
  });
});

// ─── rawFindingEstimate ───

describe('rawFindingEstimate', () => {
  it('estimates at least as many as parsed', () => {
    const fixtures = [
      'skill-format.txt',
      'bare-severity-brackets.txt',
      'bare-numbered-prefix.txt',
    ];
    for (const name of fixtures) {
      const result = parseOutput(loadFixture(name));
      expect(result.rawFindingEstimate).toBeGreaterThanOrEqual(result.findings.length);
    }
  });

  it('is 0 for empty input', () => {
    const result = parseOutput('');
    expect(result.rawFindingEstimate).toBe(0);
  });
});
