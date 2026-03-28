import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Integration test for npm run add-codebase / remove-codebase.
 *
 * Uses --local flag to avoid git submodule side effects in tests.
 */

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'bench.json');
const CODEBASE_NAME = '_test_codebase';
const TMP_SRC = path.join(PROJECT_ROOT, '.tmp-test-codebase-src');

let originalConfig: string;

beforeAll(() => {
  originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8');

  // Create a mock codebase source directory
  fs.mkdirSync(path.join(TMP_SRC, 'contracts'), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_SRC, 'contracts', 'Token.sol'),
    '// SPDX-License-Identifier: MIT\ncontract Token {}',
  );
  fs.writeFileSync(path.join(TMP_SRC, 'scope.txt'), './contracts/Token.sol\n');
});

afterAll(() => {
  fs.writeFileSync(CONFIG_PATH, originalConfig);
  if (fs.existsSync(TMP_SRC)) fs.rmSync(TMP_SRC, { recursive: true, force: true });
  const dataset = path.join(PROJECT_ROOT, 'datasets', CODEBASE_NAME);
  if (fs.existsSync(dataset)) fs.rmSync(dataset, { recursive: true, force: true });
  const gt = path.join(PROJECT_ROOT, 'ground_truth', `${CODEBASE_NAME}.json`);
  if (fs.existsSync(gt)) fs.rmSync(gt);
});

describe('add-codebase', () => {
  it('adds local codebase and registers in bench.json', () => {
    const result = execSync(
      `node dist/runner/add-codebase.js --name ${CODEBASE_NAME} --local "${TMP_SRC}"`,
      { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: 'pipe' },
    );

    expect(result).toContain('Codebase added');
    expect(result).toContain(CODEBASE_NAME);

    // Verify files on disk
    const dataset = path.join(PROJECT_ROOT, 'datasets', CODEBASE_NAME);
    expect(fs.existsSync(dataset)).toBe(true);
    expect(fs.existsSync(path.join(dataset, 'contracts', 'Token.sol'))).toBe(true);
    expect(fs.existsSync(path.join(dataset, 'scope.txt'))).toBe(true);

    // Verify bench.json
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const entry = config.codebases.find((c: { id: string }) => c.id === CODEBASE_NAME);
    expect(entry).toBeTruthy();
    expect(entry.path).toBe(`datasets/${CODEBASE_NAME}`);
  });

  it('refuses duplicate codebase name', () => {
    expect(() => {
      execSync(
        `node dist/runner/add-codebase.js --name ${CODEBASE_NAME} --local "${TMP_SRC}"`,
        { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: 'pipe' },
      );
    }).toThrow();
  });
});

describe('remove-codebase', () => {
  it('removes codebase directory and bench.json entry', () => {
    // Create a fake ground truth to test cleanup
    const gtPath = path.join(PROJECT_ROOT, 'ground_truth', `${CODEBASE_NAME}.json`);
    fs.writeFileSync(gtPath, JSON.stringify({ codebaseId: CODEBASE_NAME, findings: [] }));

    const result = execSync(
      `node dist/runner/remove-codebase.js --name ${CODEBASE_NAME}`,
      { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: 'pipe' },
    );

    expect(result).toContain(`Removed "${CODEBASE_NAME}" from bench.json`);
    expect(result).toContain(`Removed directory`);
    expect(result).toContain(`Removed ground_truth/${CODEBASE_NAME}.json`);

    // Verify cleanup
    const dataset = path.join(PROJECT_ROOT, 'datasets', CODEBASE_NAME);
    expect(fs.existsSync(dataset)).toBe(false);
    expect(fs.existsSync(gtPath)).toBe(false);

    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    expect(config.codebases.find((c: { id: string }) => c.id === CODEBASE_NAME)).toBeUndefined();
  });

  it('handles already-removed codebase gracefully', () => {
    const result = execSync(
      `node dist/runner/remove-codebase.js --name ${CODEBASE_NAME}`,
      { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: 'pipe' },
    );

    expect(result).toContain('No codebase');
    expect(result).toContain('No directory');
  });
});
