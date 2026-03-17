import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  setLLMProvider,
  resetLLMProvider,
  callLLM,
  type LLMProvider,
} from '../../src/classifier/llm.js';
import { clusterFindings } from '../../src/classifier/cluster.js';
import type { NovelCluster, ClusterResult } from '../../src/shared/types.js';

/**
 * Tests for incremental clustering: prompt construction, Zod schema,
 * and assignment logic.
 *
 * Tests written BEFORE implementation (Step 2 of incremental plan).
 */

// ─── Zod schema for incremental assignment response ───

// This is the schema we expect to implement in cluster.ts
const IncrementalAssignmentSchema = z.array(
  z.object({
    findingIndex: z.number(),
    assignTo: z.string(), // existing clusterId or "new"
    newTitle: z.string().optional(),
    newReasoning: z.string().optional(),
    newSeverity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  }),
);

type IncrementalAssignment = z.infer<typeof IncrementalAssignmentSchema>;

// ─── FakeLLMProvider for testing ───

class FakeLLMProvider implements LLMProvider {
  response = '[]';

  async call(_prompt: string, _model: string, _timeout: number): Promise<string> {
    return this.response;
  }
}

// ─── Test helpers ───

function makeCluster(id: string, title: string, reasoning: string, memberCount: number): NovelCluster {
  return {
    clusterId: id,
    title,
    reasoning,
    severity: 'medium',
    foundIn: Array.from({ length: memberCount }, (_, i) => ({
      runId: `run-${i}`,
      conditionId: 'skill_v2',
      findingIndex: i + 1,
      findingTitle: `Finding ${i + 1}`,
    })),
    conditionsCaught: ['skill_v2'],
  };
}

interface ClusterInput {
  runId: string;
  conditionId: string;
  findingIndex: number;
  findingTitle: string;
  reasoning: string;
}

// ─── Schema validation tests ───

describe('IncrementalAssignmentSchema', () => {
  it('validates assignment to existing cluster', () => {
    const data = [{ findingIndex: 1, assignTo: 'novel-abc123' }];
    const result = IncrementalAssignmentSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('validates assignment as new cluster', () => {
    const data = [{
      findingIndex: 1,
      assignTo: 'new',
      newTitle: 'New vulnerability found',
      newReasoning: 'This is a new root cause',
      newSeverity: 'high',
    }];
    const result = IncrementalAssignmentSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('validates batch of mixed assignments', () => {
    const data = [
      { findingIndex: 1, assignTo: 'novel-abc123' },
      { findingIndex: 2, assignTo: 'new', newTitle: 'New bug', newReasoning: 'reason', newSeverity: 'medium' as const },
      { findingIndex: 3, assignTo: 'novel-def456' },
    ];
    const result = IncrementalAssignmentSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects invalid severity', () => {
    const data = [{ findingIndex: 1, assignTo: 'new', newSeverity: 'extreme' }];
    const result = IncrementalAssignmentSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('accepts empty array (no findings to assign)', () => {
    const result = IncrementalAssignmentSchema.safeParse([]);
    expect(result.success).toBe(true);
  });
});

// ─── Prompt construction tests ───
// These test buildIncrementalPrompt which we'll implement next

describe('buildIncrementalPrompt', () => {
  // Import dynamically after implementation exists
  let buildIncrementalPrompt: (
    newFindings: ClusterInput[],
    existingClusters: NovelCluster[],
    codebaseId: string,
  ) => string;

  beforeAll(async () => {
    try {
      const mod = await import('../../src/classifier/cluster.js');
      buildIncrementalPrompt = (mod as any).buildIncrementalPrompt;
    } catch {
      // Function not yet implemented — tests will skip
    }
  });

  it('includes existing cluster summaries', () => {
    if (!buildIncrementalPrompt) return; // skip until implemented

    const clusters = [
      makeCluster('novel-abc', 'Reentrancy in withdraw', 'CEI pattern violated', 3),
      makeCluster('novel-def', 'Access control missing', 'No onlyOwner modifier', 2),
    ];
    const findings: ClusterInput[] = [
      { runId: 'run-new', conditionId: 'bare_audit', findingIndex: 1, findingTitle: 'Test finding', reasoning: 'test' },
    ];

    const prompt = buildIncrementalPrompt(findings, clusters, 'test-cb');

    expect(prompt).toContain('novel-abc');
    expect(prompt).toContain('Reentrancy in withdraw');
    expect(prompt).toContain('CEI pattern violated');
    expect(prompt).toContain('novel-def');
    expect(prompt).toContain('Access control missing');
  });

  it('includes member count per cluster', () => {
    if (!buildIncrementalPrompt) return;

    const clusters = [makeCluster('novel-abc', 'Bug A', 'reason', 5)];
    const findings: ClusterInput[] = [
      { runId: 'r', conditionId: 'c', findingIndex: 1, findingTitle: 'F', reasoning: 'r' },
    ];

    const prompt = buildIncrementalPrompt(findings, clusters, 'test-cb');
    expect(prompt).toContain('5'); // member count should appear
  });

  it('includes full finding context', () => {
    if (!buildIncrementalPrompt) return;

    const findings: ClusterInput[] = [
      {
        runId: 'run-1',
        conditionId: 'skill_v2',
        findingIndex: 1,
        findingTitle: 'Flash loan oracle manipulation',
        reasoning: 'The oracle can be manipulated via flash loan. Location: PriceOracle.getPrice. Type: oracle-manipulation.',
      },
    ];

    const prompt = buildIncrementalPrompt(findings, [], 'test-cb');
    expect(prompt).toContain('Flash loan oracle manipulation');
    expect(prompt).toContain('oracle can be manipulated');
  });

  it('does NOT include foundIn arrays in cluster summaries', () => {
    if (!buildIncrementalPrompt) return;

    const clusters = [makeCluster('novel-abc', 'Bug', 'reason', 3)];
    const findings: ClusterInput[] = [
      { runId: 'r', conditionId: 'c', findingIndex: 1, findingTitle: 'F', reasoning: 'r' },
    ];

    const prompt = buildIncrementalPrompt(findings, clusters, 'test-cb');
    // Should not contain run IDs from cluster members
    expect(prompt).not.toContain('run-0');
    expect(prompt).not.toContain('run-1');
    expect(prompt).not.toContain('run-2');
  });

  it('handles zero existing clusters (first-run case)', () => {
    if (!buildIncrementalPrompt) return;

    const findings: ClusterInput[] = [
      { runId: 'r', conditionId: 'c', findingIndex: 1, findingTitle: 'Bug A', reasoning: 'reason A' },
      { runId: 'r', conditionId: 'c', findingIndex: 2, findingTitle: 'Bug B', reasoning: 'reason B' },
    ];

    const prompt = buildIncrementalPrompt(findings, [], 'test-cb');
    expect(prompt).toContain('Bug A');
    expect(prompt).toContain('Bug B');
    // Should instruct to create new clusters for all
    expect(prompt).toContain('new');
  });
});

// ─── Incremental LLM call integration ───

describe('incremental assignment via LLM', () => {
  let fake: FakeLLMProvider;

  beforeAll(() => {
    fake = new FakeLLMProvider();
    setLLMProvider(fake);
  });

  afterAll(() => {
    resetLLMProvider();
  });

  it('parses assignment to existing cluster', async () => {
    fake.response = JSON.stringify([
      { findingIndex: 1, assignTo: 'novel-abc123' },
    ]);

    const result = await callLLM('test prompt', {
      model: 'test',
      timeout: 5000,
      schema: IncrementalAssignmentSchema,
      jsonShape: 'array',
      retries: 1,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.assignTo).toBe('novel-abc123');
  });

  it('parses new cluster creation', async () => {
    fake.response = JSON.stringify([
      {
        findingIndex: 1,
        assignTo: 'new',
        newTitle: 'Flash loan oracle attack',
        newReasoning: 'TWAP window too short',
        newSeverity: 'high',
      },
    ]);

    const result = await callLLM('test prompt', {
      model: 'test',
      timeout: 5000,
      schema: IncrementalAssignmentSchema,
      jsonShape: 'array',
      retries: 1,
    });

    expect(result[0]!.assignTo).toBe('new');
    expect(result[0]!.newTitle).toBe('Flash loan oracle attack');
    expect(result[0]!.newSeverity).toBe('high');
  });

  it('parses mixed batch', async () => {
    fake.response = JSON.stringify([
      { findingIndex: 1, assignTo: 'novel-abc' },
      { findingIndex: 2, assignTo: 'new', newTitle: 'New bug', newReasoning: 'reason', newSeverity: 'medium' },
      { findingIndex: 3, assignTo: 'novel-abc' },
    ]);

    const result = await callLLM('test prompt', {
      model: 'test',
      timeout: 5000,
      schema: IncrementalAssignmentSchema,
      jsonShape: 'array',
      retries: 1,
    });

    expect(result).toHaveLength(3);
    expect(result.filter((r) => r.assignTo === 'novel-abc')).toHaveLength(2);
    expect(result.filter((r) => r.assignTo === 'new')).toHaveLength(1);
  });
});

// ─── clusterFindings integration (incremental + full paths) ───

describe('clusterFindings orchestration', () => {
  const TMP_DIR = path.resolve(import.meta.dirname, 'tmp-cluster-test');
  let fake: FakeLLMProvider;

  beforeAll(() => {
    fake = new FakeLLMProvider();
    setLLMProvider(fake);
  });

  beforeEach(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  });

  afterAll(() => {
    resetLLMProvider();
    if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  function inputsForRun(runId: string, conditionId: string, titles: string[]): ClusterInput[] {
    return titles.map((t, i) => ({
      runId,
      conditionId,
      findingIndex: i + 1,
      findingTitle: t,
      reasoning: `Description of ${t}`,
    }));
  }

  it('full path: clusters all findings when no existing file', async () => {
    // LLM returns 2 clusters from 3 findings
    fake.response = JSON.stringify([
      { clusterId: 'c1', title: 'Bug A', reasoning: 'reason A', severity: 'high', memberIndices: [1, 3] },
      { clusterId: 'c2', title: 'Bug B', reasoning: 'reason B', severity: 'medium', memberIndices: [2] },
    ]);

    const inputs = inputsForRun('run-1', 'skill_v2', ['Finding A1', 'Finding B', 'Finding A2']);
    const result = await clusterFindings(inputs, 'test-full', TMP_DIR, {});

    expect(result).not.toBeNull();
    expect(result!.clusters).toHaveLength(2);
    expect(result!.uniqueBugs).toBe(2);
    expect(result!.totalFindings).toBe(3);
    // Cluster A has 2 findings
    const clusterA = result!.clusters.find((c) => c.title === 'Bug A')!;
    expect(clusterA.foundIn).toHaveLength(2);
  });

  it('incremental path: assigns new findings to existing clusters', async () => {
    // First: create an existing cluster file
    const existing: ClusterResult = {
      codebaseId: 'test-inc',
      clusteredAt: new Date().toISOString(),
      clusterModel: 'claude-sonnet-4-20250514',
      inputHash: 'old-hash',
      totalFindings: 2,
      uniqueBugs: 1,
      clusters: [{
        clusterId: 'novel-existing',
        title: 'Reentrancy in withdraw',
        reasoning: 'CEI pattern violated',
        severity: 'high',
        foundIn: [
          { runId: 'run-1', conditionId: 'skill_v2', findingIndex: 1, findingTitle: 'Reentrancy bug' },
          { runId: 'run-1', conditionId: 'skill_v2', findingIndex: 2, findingTitle: 'Withdraw drain' },
        ],
        conditionsCaught: ['skill_v2'],
      }],
    };
    fs.writeFileSync(
      path.join(TMP_DIR, 'clusters-test-inc.json'),
      JSON.stringify(existing, null, 2),
    );

    // LLM assigns new finding to existing cluster
    fake.response = JSON.stringify([
      { findingIndex: 1, assignTo: 'novel-existing' },
    ]);

    // Inputs include old findings (already clustered) + 1 new finding
    const inputs = [
      ...inputsForRun('run-1', 'skill_v2', ['Reentrancy bug', 'Withdraw drain']),
      ...inputsForRun('run-2', 'bare_audit', ['Reentrant withdraw call']),
    ];

    const result = await clusterFindings(inputs, 'test-inc', TMP_DIR, {});

    expect(result).not.toBeNull();
    // Still 1 cluster, but now with 3 findings
    expect(result!.clusters).toHaveLength(1);
    expect(result!.clusters[0]!.foundIn).toHaveLength(3);
    // conditionsCaught updated
    expect(result!.clusters[0]!.conditionsCaught).toContain('bare_audit');
    expect(result!.clusters[0]!.conditionsCaught).toContain('skill_v2');
  });

  it('incremental path: creates new cluster for unmatched finding', async () => {
    const existing: ClusterResult = {
      codebaseId: 'test-new',
      clusteredAt: new Date().toISOString(),
      clusterModel: 'claude-sonnet-4-20250514',
      inputHash: 'old-hash',
      totalFindings: 1,
      uniqueBugs: 1,
      clusters: [{
        clusterId: 'novel-existing',
        title: 'Reentrancy in withdraw',
        reasoning: 'CEI pattern violated',
        severity: 'high',
        foundIn: [{ runId: 'run-1', conditionId: 'skill_v2', findingIndex: 1, findingTitle: 'Reentrancy' }],
        conditionsCaught: ['skill_v2'],
      }],
    };
    fs.writeFileSync(
      path.join(TMP_DIR, 'clusters-test-new.json'),
      JSON.stringify(existing, null, 2),
    );

    // LLM says the new finding is a NEW cluster
    fake.response = JSON.stringify([
      { findingIndex: 1, assignTo: 'new', newTitle: 'Oracle manipulation', newReasoning: 'TWAP too short', newSeverity: 'medium' },
    ]);

    const inputs = [
      ...inputsForRun('run-1', 'skill_v2', ['Reentrancy']),
      ...inputsForRun('run-2', 'bare_audit', ['Flash loan oracle attack']),
    ];

    const result = await clusterFindings(inputs, 'test-new', TMP_DIR, {});

    expect(result).not.toBeNull();
    expect(result!.clusters).toHaveLength(2);
    const newCluster = result!.clusters.find((c) => c.title === 'Oracle manipulation')!;
    expect(newCluster).toBeDefined();
    expect(newCluster.severity).toBe('medium');
    expect(newCluster.foundIn).toHaveLength(1);
    expect(newCluster.foundIn[0]!.findingTitle).toBe('Flash loan oracle attack');
  });

  it('force flag: uses full path even with existing clusters', async () => {
    const existing: ClusterResult = {
      codebaseId: 'test-force',
      clusteredAt: new Date().toISOString(),
      clusterModel: 'claude-sonnet-4-20250514',
      inputHash: 'old-hash',
      totalFindings: 1,
      uniqueBugs: 1,
      clusters: [{
        clusterId: 'novel-old',
        title: 'Old cluster',
        reasoning: 'old',
        severity: 'low',
        foundIn: [{ runId: 'run-1', conditionId: 'skill_v2', findingIndex: 1, findingTitle: 'Old finding' }],
        conditionsCaught: ['skill_v2'],
      }],
    };
    fs.writeFileSync(
      path.join(TMP_DIR, 'clusters-test-force.json'),
      JSON.stringify(existing, null, 2),
    );

    // Full clustering response — completely new clusters
    fake.response = JSON.stringify([
      { clusterId: 'c1', title: 'Fresh cluster', reasoning: 'fresh', severity: 'high', memberIndices: [1, 2] },
    ]);

    const inputs = inputsForRun('run-1', 'skill_v2', ['Finding A', 'Finding B']);
    const result = await clusterFindings(inputs, 'test-force', TMP_DIR, { force: true });

    expect(result).not.toBeNull();
    // Should use full path — old cluster replaced
    expect(result!.clusters[0]!.title).toBe('Fresh cluster');
    expect(result!.clusters[0]!.clusterId).not.toBe('novel-old');
  });

  it('cache hit: returns existing when inputHash matches', async () => {
    const inputs = inputsForRun('run-1', 'skill_v2', ['Bug X']);
    const inputHash = (await import('../../src/shared/util/hash.js')).hashContent(
      JSON.stringify(inputs) + 'claude-sonnet-4-20250514' + 'false',
    );

    const existing: ClusterResult = {
      codebaseId: 'test-cache',
      clusteredAt: new Date().toISOString(),
      clusterModel: 'claude-sonnet-4-20250514',
      inputHash,
      totalFindings: 1,
      uniqueBugs: 1,
      clusters: [{
        clusterId: 'novel-cached',
        title: 'Cached cluster',
        reasoning: 'cached',
        severity: 'medium',
        foundIn: [{ runId: 'run-1', conditionId: 'skill_v2', findingIndex: 1, findingTitle: 'Bug X' }],
        conditionsCaught: ['skill_v2'],
      }],
    };
    fs.writeFileSync(
      path.join(TMP_DIR, 'clusters-test-cache.json'),
      JSON.stringify(existing, null, 2),
    );

    // Should not call LLM at all — cache hit
    fake.response = 'SHOULD NOT BE CALLED';
    const result = await clusterFindings(inputs, 'test-cache', TMP_DIR, {});

    expect(result).not.toBeNull();
    expect(result!.clusters[0]!.title).toBe('Cached cluster');
  });

  it('no new findings: skips LLM when all findings already clustered', async () => {
    const inputs = inputsForRun('run-1', 'skill_v2', ['Already clustered']);
    const existing: ClusterResult = {
      codebaseId: 'test-nonew',
      clusteredAt: new Date().toISOString(),
      clusterModel: 'claude-sonnet-4-20250514',
      inputHash: 'different-old-hash', // different hash to avoid cache hit
      totalFindings: 1,
      uniqueBugs: 1,
      clusters: [{
        clusterId: 'novel-x',
        title: 'Existing',
        reasoning: 'existing',
        severity: 'medium',
        foundIn: [{ runId: 'run-1', conditionId: 'skill_v2', findingIndex: 1, findingTitle: 'Already clustered' }],
        conditionsCaught: ['skill_v2'],
      }],
    };
    fs.writeFileSync(
      path.join(TMP_DIR, 'clusters-test-nonew.json'),
      JSON.stringify(existing, null, 2),
    );

    fake.response = 'SHOULD NOT BE CALLED';
    const result = await clusterFindings(inputs, 'test-nonew', TMP_DIR, {});

    expect(result).not.toBeNull();
    expect(result!.clusters).toHaveLength(1);
  });

  it('empty inputs: returns null', async () => {
    const result = await clusterFindings([], 'test-empty', TMP_DIR, {});
    expect(result).toBeNull();
  });

  it('single finding: creates cluster without LLM call', async () => {
    fake.response = 'SHOULD NOT BE CALLED';
    const inputs = inputsForRun('run-1', 'skill_v2', ['Solo finding']);
    const result = await clusterFindings(inputs, 'test-single', TMP_DIR, {});

    expect(result).not.toBeNull();
    expect(result!.clusters).toHaveLength(1);
    expect(result!.clusters[0]!.title).toBe('Solo finding');
  });

  it('incremental path: prunes stale findings when input changes', async () => {
    // Cluster has 2 findings from run-1 (finding 1 and 2)
    const existing: ClusterResult = {
      codebaseId: 'test-prune',
      clusteredAt: new Date().toISOString(),
      clusterModel: 'claude-sonnet-4-20250514',
      inputHash: 'old-hash',
      totalFindings: 2,
      uniqueBugs: 1,
      clusters: [{
        clusterId: 'novel-existing',
        title: 'Bug A',
        reasoning: 'reason',
        severity: 'high',
        foundIn: [
          { runId: 'run-1', conditionId: 'skill_v2', findingIndex: 1, findingTitle: 'Finding 1' },
          { runId: 'run-1', conditionId: 'skill_v2', findingIndex: 2, findingTitle: 'Finding 2' },
        ],
        conditionsCaught: ['skill_v2'],
      }],
    };
    fs.writeFileSync(
      path.join(TMP_DIR, 'clusters-test-prune.json'),
      JSON.stringify(existing, null, 2),
    );

    // Now inputs only have finding 1 (finding 2 was reclassified as matched)
    fake.response = 'SHOULD NOT BE CALLED'; // no new findings
    const inputs = inputsForRun('run-1', 'skill_v2', ['Finding 1']);

    const result = await clusterFindings(inputs, 'test-prune', TMP_DIR, {});

    expect(result).not.toBeNull();
    // Finding 2 should be pruned from the cluster
    expect(result!.clusters[0]!.foundIn).toHaveLength(1);
    expect(result!.clusters[0]!.foundIn[0]!.findingTitle).toBe('Finding 1');
    expect(result!.totalFindings).toBe(1);
  });

  it('incremental path: drops empty clusters after pruning', async () => {
    // Two clusters, one will become empty after pruning
    const existing: ClusterResult = {
      codebaseId: 'test-drop',
      clusteredAt: new Date().toISOString(),
      clusterModel: 'claude-sonnet-4-20250514',
      inputHash: 'old-hash',
      totalFindings: 2,
      uniqueBugs: 2,
      clusters: [
        {
          clusterId: 'novel-keep',
          title: 'Keeps findings',
          reasoning: 'reason',
          severity: 'high',
          foundIn: [{ runId: 'run-1', conditionId: 'skill_v2', findingIndex: 1, findingTitle: 'Finding 1' }],
          conditionsCaught: ['skill_v2'],
        },
        {
          clusterId: 'novel-drop',
          title: 'Will be empty',
          reasoning: 'reason',
          severity: 'low',
          foundIn: [{ runId: 'run-1', conditionId: 'skill_v2', findingIndex: 2, findingTitle: 'Finding 2' }],
          conditionsCaught: ['skill_v2'],
        },
      ],
    };
    fs.writeFileSync(
      path.join(TMP_DIR, 'clusters-test-drop.json'),
      JSON.stringify(existing, null, 2),
    );

    // Only finding 1 in inputs — finding 2 is gone
    fake.response = 'SHOULD NOT BE CALLED';
    const inputs = inputsForRun('run-1', 'skill_v2', ['Finding 1']);

    const result = await clusterFindings(inputs, 'test-drop', TMP_DIR, {});

    expect(result).not.toBeNull();
    // novel-drop should be removed entirely
    expect(result!.clusters).toHaveLength(1);
    expect(result!.clusters[0]!.clusterId).toBe('novel-keep');
    expect(result!.uniqueBugs).toBe(1);
  });

  it('incremental path: no duplicate foundIn entries', async () => {
    // Existing cluster already has run-1/finding-1
    const existing: ClusterResult = {
      codebaseId: 'test-dedup',
      clusteredAt: new Date().toISOString(),
      clusterModel: 'claude-sonnet-4-20250514',
      inputHash: 'old-hash',
      totalFindings: 1,
      uniqueBugs: 1,
      clusters: [{
        clusterId: 'novel-existing',
        title: 'Bug A',
        reasoning: 'reason',
        severity: 'medium',
        foundIn: [
          { runId: 'run-1', conditionId: 'skill_v2', findingIndex: 1, findingTitle: 'Bug A v1' },
        ],
        conditionsCaught: ['skill_v2'],
      }],
    };
    fs.writeFileSync(
      path.join(TMP_DIR, 'clusters-test-dedup.json'),
      JSON.stringify(existing, null, 2),
    );

    // LLM assigns new finding to existing cluster
    // But the new finding happens to have same runId/findingIndex as existing
    // (simulating a re-processing edge case)
    fake.response = JSON.stringify([
      { findingIndex: 1, assignTo: 'novel-existing' },
    ]);

    // findNewFindings should filter this out, but if it doesn't, the guard in
    // the incremental path should prevent duplicate foundIn
    const inputs: ClusterInput[] = [
      // This one is already in the cluster
      { runId: 'run-1', conditionId: 'skill_v2', findingIndex: 1, findingTitle: 'Bug A v1', reasoning: 'reason' },
      // This one is genuinely new
      { runId: 'run-2', conditionId: 'bare_audit', findingIndex: 1, findingTitle: 'Bug A v2', reasoning: 'reason' },
    ];

    const result = await clusterFindings(inputs, 'test-dedup', TMP_DIR, {});

    expect(result).not.toBeNull();
    // Should have exactly 2 foundIn entries, not 3 (no duplicate)
    expect(result!.clusters[0]!.foundIn).toHaveLength(2);
    // Verify no duplicates
    const keys = result!.clusters[0]!.foundIn.map((f) => `${f.runId}::${f.findingIndex}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('incremental path: does not duplicate conditionsCaught', async () => {
    const existing: ClusterResult = {
      codebaseId: 'test-conddup',
      clusteredAt: new Date().toISOString(),
      clusterModel: 'claude-sonnet-4-20250514',
      inputHash: 'old-hash',
      totalFindings: 1,
      uniqueBugs: 1,
      clusters: [{
        clusterId: 'novel-existing',
        title: 'Bug',
        reasoning: 'reason',
        severity: 'medium',
        foundIn: [
          { runId: 'run-1', conditionId: 'skill_v2', findingIndex: 1, findingTitle: 'Bug' },
        ],
        conditionsCaught: ['skill_v2'],
      }],
    };
    fs.writeFileSync(
      path.join(TMP_DIR, 'clusters-test-conddup.json'),
      JSON.stringify(existing, null, 2),
    );

    // New finding from same condition
    fake.response = JSON.stringify([
      { findingIndex: 1, assignTo: 'novel-existing' },
    ]);

    const inputs: ClusterInput[] = [
      { runId: 'run-1', conditionId: 'skill_v2', findingIndex: 1, findingTitle: 'Bug', reasoning: 'r' },
      { runId: 'run-2', conditionId: 'skill_v2', findingIndex: 1, findingTitle: 'Bug again', reasoning: 'r' },
    ];

    const result = await clusterFindings(inputs, 'test-conddup', TMP_DIR, {});
    expect(result).not.toBeNull();
    // skill_v2 should appear only once in conditionsCaught
    const conditions = result!.clusters[0]!.conditionsCaught;
    expect(conditions.filter((c) => c === 'skill_v2')).toHaveLength(1);
  });
});
