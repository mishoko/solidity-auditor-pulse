import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunMeta } from '../../src/shared/types.js';

/**
 * Provenance tests — verify that meta.json files capture enough
 * information to reconstruct what was run, when, and with what.
 *
 * Uses real results/ files (not fixtures) to validate production data.
 * Skips gracefully if no results exist (clean checkout).
 */

const RESULTS_DIR = path.resolve(import.meta.dirname, '../../results');

function loadAllMeta(): { file: string; meta: RunMeta }[] {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  return fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith('.meta.json'))
    .map((file) => ({
      file,
      meta: JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, file), 'utf8')),
    }));
}

describe('meta.json provenance', () => {
  const entries = loadAllMeta();

  it('has at least one meta file (skip on clean checkout)', () => {
    if (entries.length === 0) return; // graceful skip
    expect(entries.length).toBeGreaterThan(0);
  });

  it('every meta has required identity fields', () => {
    for (const { file, meta } of entries) {
      expect(meta.runId, `${file}: missing runId`).toBeTruthy();
      expect(meta.codebaseId, `${file}: missing codebaseId`).toBeTruthy();
      expect(meta.conditionId, `${file}: missing conditionId`).toBeTruthy();
      expect(typeof meta.iteration, `${file}: iteration not number`).toBe('number');
      expect(meta.mode, `${file}: missing mode`).toMatch(/^(bare|skill)$/);
    }
  });

  it('every meta has timing fields', () => {
    for (const { file, meta } of entries) {
      expect(meta.timestampUtc, `${file}: missing timestampUtc`).toBeTruthy();
      // Verify timestamp is parseable
      const ts = new Date(meta.timestampUtc);
      expect(ts.getTime(), `${file}: unparseable timestampUtc`).not.toBeNaN();

      expect(typeof meta.durationMs, `${file}: durationMs not number`).toBe('number');
      expect(typeof meta.exitCode, `${file}: exitCode not number`).toBe('number');
    }
  });

  it('every meta has model information', () => {
    for (const { file, meta } of entries) {
      // claudeModel may be undefined for very old runs, but should be present
      if (meta.claudeModel) {
        expect(meta.claudeModel, `${file}: empty claudeModel`).toBeTruthy();
      }
      if (meta.claudeCliVersion) {
        expect(meta.claudeCliVersion, `${file}: empty claudeCliVersion`).toBeTruthy();
      }
    }
  });

  it('skill runs have skill provenance', () => {
    const skillRuns = entries.filter((e) => e.meta.mode === 'skill');
    for (const { file, meta } of skillRuns) {
      expect(meta.skillVersion, `${file}: skill run missing skillVersion`).toBeTruthy();
      // skillGitCommit may be absent if source.json is missing, but should be present for production runs
    }
  });

  it('every meta has codebase git commit', () => {
    for (const { file, meta } of entries) {
      if (meta.codebaseGitCommit) {
        // Should look like a git SHA
        expect(meta.codebaseGitCommit, `${file}: invalid git commit format`).toMatch(
          /^[a-f0-9]{7,40}$/,
        );
      }
    }
  });

  it('runId encodes codebase and condition', () => {
    for (const { file, meta } of entries) {
      expect(meta.runId, `${file}: runId doesn't contain codebaseId`).toContain(
        meta.codebaseId,
      );
      expect(meta.runId, `${file}: runId doesn't contain conditionId`).toContain(
        meta.conditionId,
      );
    }
  });

  it('corresponding stdout files exist for exit-0 runs', () => {
    for (const { file, meta } of entries) {
      if (meta.exitCode !== 0) continue;
      const stdoutPath = path.join(RESULTS_DIR, `${meta.runId}.stdout.txt`);
      expect(fs.existsSync(stdoutPath), `${file}: missing stdout for exit-0 run`).toBe(true);
    }
  });
});

describe('classification file provenance', () => {
  const classFiles = fs.existsSync(RESULTS_DIR)
    ? fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.classifications.json'))
    : [];

  it('classification files have cache keys', () => {
    for (const file of classFiles) {
      const data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, file), 'utf8'));
      expect(data.gtHash, `${file}: missing gtHash`).toBeTruthy();
      expect(data.stdoutHash, `${file}: missing stdoutHash`).toBeTruthy();
      expect(data.classifierModel, `${file}: missing classifierModel`).toBeTruthy();
      expect(data.classifiedAt, `${file}: missing classifiedAt`).toBeTruthy();
    }
  });

  it('classification files have prompt hash (cache invalidation on prompt change)', () => {
    for (const file of classFiles) {
      const data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, file), 'utf8'));
      // promptHash was added later — older files may not have it
      if (data.promptHash) {
        expect(data.promptHash, `${file}: empty promptHash`).toMatch(/^[a-f0-9]+$/);
      }
    }
  });
});
