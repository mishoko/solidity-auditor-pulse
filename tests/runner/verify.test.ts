import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { verifyRun, type VerifyResult } from '../../src/runner/verify.js';
import type { RunMeta } from '../../src/shared/types.js';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/verify-input');

function baseMeta(overrides: Partial<RunMeta> & { runId: string }): RunMeta {
  return {
    codebaseId: 'test-codebase',
    conditionId: 'bare_audit',
    iteration: 1,
    timestampUtc: '2026-01-01T10:00:00.000Z',
    mode: 'bare',
    exitCode: 0,
    durationMs: 60000,
    ...overrides,
  };
}

// ─── Good bare run ───

describe('verifyRun — good bare run', () => {
  const meta = baseMeta({ runId: 'good-bare' });
  let result: VerifyResult;

  it('passes verification', () => {
    result = verifyRun(meta, FIXTURES);
    expect(result.passed).toBe(true);
  });

  it('exit code check passes', () => {
    expect(result.checks['exit_code']?.ok).toBe(true);
  });

  it('has events check passes', () => {
    expect(result.checks['has_events']?.ok).toBe(true);
  });

  it('has result event', () => {
    expect(result.checks['has_result']?.ok).toBe(true);
  });

  it('no skill calls (bare)', () => {
    expect(result.checks['no_skill_calls']?.ok).toBe(true);
  });

  it('skill not visible in init (bare)', () => {
    expect(result.checks['bare_no_skill_visible']?.ok).toBe(true);
  });

  it('has output content', () => {
    expect(result.checks['has_output']?.ok).toBe(true);
  });
});

// ─── Contaminated bare run ───

describe('verifyRun — contaminated bare run', () => {
  const meta = baseMeta({ runId: 'contaminated-bare' });

  it('fails verification due to skill visibility', () => {
    const result = verifyRun(meta, FIXTURES);
    expect(result.passed).toBe(false);
    expect(result.checks['bare_no_skill_visible']?.ok).toBe(false);
  });
});

// ─── Good skill run (V2 — 5 agents) ───

describe('verifyRun — good skill V2 run', () => {
  const meta = baseMeta({
    runId: 'good-skill',
    conditionId: 'skill_v2',
    mode: 'skill',
    durationMs: 180000,
  });
  let result: VerifyResult;

  it('passes verification', () => {
    result = verifyRun(meta, FIXTURES);
    expect(result.passed).toBe(true);
  });

  it('detects 5 agents spawned', () => {
    expect(result.checks['agents_spawned']?.ok).toBe(true);
    expect(result.checks['agents_spawned']?.detail).toContain('5 agents');
  });

  it('all agents returned', () => {
    expect(result.checks['agents_all_returned']?.ok).toBe(true);
  });

  it('no agent errors', () => {
    expect(result.checks['agents_no_errors']?.ok).toBe(true);
  });
});

// ─── Non-zero exit code ───

describe('verifyRun — non-zero exit without result', () => {
  const meta = baseMeta({ runId: 'good-bare', exitCode: 1 });

  it('fails exit code check', () => {
    const result = verifyRun(meta, FIXTURES);
    expect(result.checks['exit_code']?.ok).toBe(false);
  });
});

// ─── Exit 143 with result event (grace-kill) ───

describe('verifyRun — exit 143 with result (grace-kill)', () => {
  const meta = baseMeta({
    runId: 'good-bare',
    exitCode: 143,
    timedOut: true,
  });

  it('passes — work was completed before kill', () => {
    const result = verifyRun(meta, FIXTURES);
    expect(result.checks['exit_code']?.ok).toBe(true);
    expect(result.checks['not_timed_out']?.ok).toBe(true);
  });
});

// ─── Missing events file ───

describe('verifyRun — missing events file', () => {
  const meta = baseMeta({ runId: 'nonexistent' });

  it('fails has_events check', () => {
    const result = verifyRun(meta, FIXTURES);
    expect(result.checks['has_events']?.ok).toBe(false);
    expect(result.checks['has_result']?.ok).toBe(false);
  });
});

// ─── Skill run with too few agents (V1 needs 4) ───

describe('verifyRun — skill V1 with insufficient agents', () => {
  // good-bare has 0 agents — using it as a skill run should fail agent check
  const meta = baseMeta({
    runId: 'good-bare',
    conditionId: 'skill_v1_default',
    mode: 'skill',
  });

  it('fails agents_spawned check', () => {
    const result = verifyRun(meta, FIXTURES);
    expect(result.checks['agents_spawned']?.ok).toBe(false);
  });
});
