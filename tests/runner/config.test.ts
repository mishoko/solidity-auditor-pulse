import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../../src/runner/config.js';

const TMP_DIR = path.resolve(import.meta.dirname, 'tmp-config-test');

afterAll(() => {
  if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

function writeConfig(name: string, content: unknown): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, JSON.stringify(content, null, 2));
  return p;
}

describe('loadConfig', () => {
  it('loads valid config', () => {
    const p = writeConfig('valid.json', {
      codebases: [{ id: 'test', path: 'datasets/test' }],
      conditions: [
        { id: 'bare_audit', type: 'bare', prompt: 'Audit this' },
        { id: 'skill_v2', type: 'skill', skillVersion: 'v2', command: '/solidity-auditor' },
      ],
      defaultRunsPerCondition: 3,
    });

    const config = loadConfig(p);
    expect(config.codebases).toHaveLength(1);
    expect(config.conditions).toHaveLength(2);
    expect(config.defaultRunsPerCondition).toBe(3);
  });

  it('throws on missing file', () => {
    expect(() => loadConfig('/nonexistent/path.json')).toThrow('not found');
  });

  it('throws on empty codebases', () => {
    const p = writeConfig('no-codebases.json', {
      codebases: [],
      conditions: [{ id: 'bare', type: 'bare', prompt: 'test' }],
      defaultRunsPerCondition: 1,
    });
    expect(() => loadConfig(p)).toThrow();
  });

  it('throws on empty conditions', () => {
    const p = writeConfig('no-conditions.json', {
      codebases: [{ id: 'test', path: 'test' }],
      conditions: [],
      defaultRunsPerCondition: 1,
    });
    expect(() => loadConfig(p)).toThrow();
  });

  it('throws on invalid condition type', () => {
    const p = writeConfig('bad-type.json', {
      codebases: [{ id: 'test', path: 'test' }],
      conditions: [{ id: 'bad', type: 'invalid', prompt: 'test' }],
      defaultRunsPerCondition: 1,
    });
    expect(() => loadConfig(p)).toThrow();
  });

  it('skill condition requires skillVersion and command', () => {
    const p = writeConfig('missing-skill-fields.json', {
      codebases: [{ id: 'test', path: 'test' }],
      conditions: [{ id: 'skill', type: 'skill' }],
      defaultRunsPerCondition: 1,
    });
    expect(() => loadConfig(p)).toThrow();
  });

  it('accepts optional deep and fileOutput on skill conditions', () => {
    const p = writeConfig('skill-opts.json', {
      codebases: [{ id: 'test', path: 'test' }],
      conditions: [{
        id: 'skill_v1_deep',
        type: 'skill',
        skillVersion: 'v1',
        command: '/solidity-auditor --deep',
        deep: true,
        fileOutput: true,
      }],
      defaultRunsPerCondition: 1,
    });

    const config = loadConfig(p);
    const cond = config.conditions[0]!;
    expect(cond.type).toBe('skill');
    if (cond.type === 'skill') {
      expect(cond.deep).toBe(true);
      expect(cond.fileOutput).toBe(true);
    }
  });
});
