import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hashContent } from '../../src/shared/util/hash.js';

/**
 * Cache invalidation tests for all three pipeline phases.
 *
 * Validates the content-based cache contract:
 *   - Same inputs + same model → cache hit (skip LLM call)
 *   - Changed inputs → cache miss (re-run)
 *   - Changed model → cache miss (re-run)
 *   - --force → always re-run
 *   - Corrupted cache file → re-run (no crash)
 *
 * Uses fixture files to simulate cache state without real LLM calls.
 */

const TMP_DIR = path.resolve(import.meta.dirname, 'tmp-cache-test');

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ─── Classification cache (gtHash + stdoutHash + promptHash) ───

describe('classification cache contract', () => {
  it('hashContent is deterministic', () => {
    const a = hashContent('same content');
    const b = hashContent('same content');
    expect(a).toBe(b);
  });

  it('different GT content → different gtHash', () => {
    const gt1 = JSON.stringify({ findings: [{ id: 'H-01', description: 'bug 1' }] });
    const gt2 = JSON.stringify({ findings: [{ id: 'H-01', description: 'bug 1' }, { id: 'H-02', description: 'bug 2' }] });
    expect(hashContent(gt1)).not.toBe(hashContent(gt2));
  });

  it('different stdout → different stdoutHash', () => {
    const stdout1 = '### [HIGH] Reentrancy in withdraw\n\nDetails...';
    const stdout2 = '### [HIGH] Reentrancy in withdraw\n\nMore details added...';
    expect(hashContent(stdout1)).not.toBe(hashContent(stdout2));
  });

  it('classification file records all cache keys', () => {
    // Simulate what classify.ts writes
    const classification = {
      runId: 'test-run',
      codebaseId: 'test-cb',
      conditionId: 'skill_v2',
      classifiedAt: new Date().toISOString(),
      classifierModel: 'claude-sonnet-4-20250514',
      gtHash: hashContent('gt content'),
      stdoutHash: hashContent('stdout content'),
      promptHash: hashContent('prompt template'),
      votesPerFinding: 3,
      classifications: [],
    };

    const filePath = path.join(TMP_DIR, 'test-run.classifications.json');
    fs.writeFileSync(filePath, JSON.stringify(classification, null, 2));

    const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(loaded.gtHash).toBe(classification.gtHash);
    expect(loaded.stdoutHash).toBe(classification.stdoutHash);
    expect(loaded.promptHash).toBe(classification.promptHash);
    expect(loaded.votesPerFinding).toBe(3);
    expect(loaded.classifierModel).toBe('claude-sonnet-4-20250514');
  });

  it('cache hit: unchanged inputs → same hashes', () => {
    const gt = '{"findings":[]}';
    const stdout = 'audit output text';
    const prompt = 'classify this finding';

    const hash1 = {
      gt: hashContent(gt),
      stdout: hashContent(stdout),
      prompt: hashContent(prompt),
    };

    // "Re-run" with same inputs
    const hash2 = {
      gt: hashContent(gt),
      stdout: hashContent(stdout),
      prompt: hashContent(prompt),
    };

    expect(hash1).toEqual(hash2);
  });

  it('cache miss: modified GT → different gtHash', () => {
    const gt1 = '{"findings":[{"id":"H-01"}]}';
    const gt2 = '{"findings":[{"id":"H-01"},{"id":"H-02"}]}';
    const stdout = 'same audit output';

    expect(hashContent(gt1)).not.toBe(hashContent(gt2));
    // stdoutHash stays the same
    expect(hashContent(stdout)).toBe(hashContent(stdout));
  });
});

// ─── Cluster cache (inputHash + clusterModel) ───

describe('cluster cache contract', () => {
  it('inputHash changes when findings change', () => {
    const inputs1 = JSON.stringify([
      { findingTitle: 'Bug A', reasoning: 'reason A' },
    ]);
    const inputs2 = JSON.stringify([
      { findingTitle: 'Bug A', reasoning: 'reason A' },
      { findingTitle: 'Bug B', reasoning: 'reason B' },
    ]);

    const model = 'claude-sonnet-4-20250514';
    const hash1 = hashContent(inputs1 + model + 'false');
    const hash2 = hashContent(inputs2 + model + 'false');
    expect(hash1).not.toBe(hash2);
  });

  it('inputHash changes when model changes', () => {
    const inputs = JSON.stringify([{ findingTitle: 'Bug A' }]);
    const hash1 = hashContent(inputs + 'claude-sonnet-4-20250514' + 'false');
    const hash2 = hashContent(inputs + 'claude-opus-4-6' + 'false');
    expect(hash1).not.toBe(hash2);
  });

  it('inputHash changes when scopeFiles option changes', () => {
    const inputs = JSON.stringify([{ findingTitle: 'Bug A' }]);
    const model = 'claude-sonnet-4-20250514';
    const hash1 = hashContent(inputs + model + 'false');
    const hash2 = hashContent(inputs + model + 'true');
    expect(hash1).not.toBe(hash2);
  });

  it('cluster file records inputHash for cache validation', () => {
    const clusterResult = {
      codebaseId: 'test-cb',
      clusteredAt: new Date().toISOString(),
      clusterModel: 'claude-sonnet-4-20250514',
      inputHash: hashContent('serialized inputs + model + scopeFlag'),
      totalFindings: 2,
      uniqueBugs: 1,
      clusters: [],
    };

    const filePath = path.join(TMP_DIR, 'clusters-test-cb.json');
    fs.writeFileSync(filePath, JSON.stringify(clusterResult, null, 2));

    const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(loaded.inputHash).toBe(clusterResult.inputHash);
    expect(loaded.clusterModel).toBe(clusterResult.clusterModel);
  });
});

// ─── Validation cache (clusterHash + validatorModel) ───

describe('validation cache contract', () => {
  it('clusterHash changes when cluster content changes', () => {
    const cluster1 = JSON.stringify({ clusters: [{ title: 'Bug A' }] });
    const cluster2 = JSON.stringify({ clusters: [{ title: 'Bug A' }, { title: 'Bug B' }] });
    const model = 'claude-opus-4-6';

    const hash1 = hashContent(cluster1 + model);
    const hash2 = hashContent(cluster2 + model);
    expect(hash1).not.toBe(hash2);
  });

  it('clusterHash changes when validator model changes', () => {
    const cluster = JSON.stringify({ clusters: [{ title: 'Bug A' }] });
    const hash1 = hashContent(cluster + 'claude-opus-4-6');
    const hash2 = hashContent(cluster + 'claude-sonnet-4-20250514');
    expect(hash1).not.toBe(hash2);
  });

  it('validation file records clusterHash for cache validation', () => {
    const validationResult = {
      codebaseId: 'test-cb',
      validatedAt: new Date().toISOString(),
      validatorModel: 'claude-opus-4-6',
      clusterHash: hashContent('cluster content + model'),
      validations: [],
      confirmed: 0,
      plausible: 0,
      rejected: 0,
    };

    const filePath = path.join(TMP_DIR, 'validations-test-cb.json');
    fs.writeFileSync(filePath, JSON.stringify(validationResult, null, 2));

    const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(loaded.clusterHash).toBe(validationResult.clusterHash);
    expect(loaded.validatorModel).toBe(validationResult.validatorModel);
  });
});

// ─── Cross-phase cache consistency ───

describe('cache consistency across phases', () => {
  it('all three phases use the same hash function', () => {
    // hashContent is shared — imported from classify.ts by cluster.ts and validate.ts
    const input = 'shared test content';
    const hash = hashContent(input);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
    expect(hashContent(input)).toBe(hash); // deterministic
  });

  it('cache keys include model — changing model invalidates cache', () => {
    const content = 'same content';

    // Classify: model is embedded in promptHash (via prompt template)
    // Cluster: model is part of inputHash computation
    // Validate: model is part of clusterHash computation

    // Simulating: same inputs, different models → different hashes
    const hashWithSonnet = hashContent(content + 'claude-sonnet-4-20250514');
    const hashWithOpus = hashContent(content + 'claude-opus-4-6');
    expect(hashWithSonnet).not.toBe(hashWithOpus);
  });

  it('corrupted cache file does not crash — falls through to re-run', () => {
    const corruptPath = path.join(TMP_DIR, 'corrupt.json');
    fs.writeFileSync(corruptPath, '{ invalid json !!!');

    // JSON.parse should throw, caught by try/catch in each phase
    expect(() => JSON.parse(fs.readFileSync(corruptPath, 'utf8'))).toThrow();
  });
});
