import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { prepareWorkspace, resetWorkspaceCache } from '../../src/runner/workspace.js';

/**
 * Workspace + isolation verification tests.
 *
 * Uses real workspaces/ dir under the project root (cleaned up after).
 * Creates a minimal temp "dataset" to copy from.
 *
 * Note: workspace.ts captures ROOT = process.cwd() at module load time,
 * so we use the real project root and create temp fixtures there.
 */

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const TMP_DATASET = path.join(PROJECT_ROOT, 'datasets', '_test_workspace_cb');
const TMP_SKILL_DIR = path.join(PROJECT_ROOT, 'skills_versions', '_test_v2', 'solidity-auditor');

beforeAll(() => {
  // Create temp dataset
  fs.mkdirSync(path.join(TMP_DATASET, 'contracts'), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_DATASET, 'contracts', 'Vault.sol'),
    '// SPDX-License-Identifier: MIT\ncontract Vault {}',
  );
  fs.writeFileSync(path.join(TMP_DATASET, 'scope.txt'), './contracts/Vault.sol\n');

  // Create temp skill with VERSION file
  fs.mkdirSync(TMP_SKILL_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TMP_SKILL_DIR, 'SKILL.md'),
    '# Skill\n\nAudit /tmp/audit-agent-1-bundle.md\n',
  );
  fs.writeFileSync(path.join(TMP_SKILL_DIR, 'VERSION'), 'v2\n');
});

afterAll(() => {
  resetWorkspaceCache();
  // Clean up temp dataset and skill
  if (fs.existsSync(TMP_DATASET)) fs.rmSync(TMP_DATASET, { recursive: true, force: true });
  const skillParent = path.join(PROJECT_ROOT, 'skills_versions', '_test_v2');
  if (fs.existsSync(skillParent)) fs.rmSync(skillParent, { recursive: true, force: true });
  // Clean up test workspaces
  for (const name of ['_test_workspace_cb__bare_test', '_test_workspace_cb__skill_test', '_test_workspace_cb__skill_wrong', '_test_workspace_cb__cleanup_test']) {
    const wsPath = path.join(PROJECT_ROOT, 'workspaces', name);
    if (fs.existsSync(wsPath)) fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

describe('bare workspace', () => {
  let wsDir: string;

  beforeAll(async () => {
    resetWorkspaceCache();
    wsDir = await prepareWorkspace(
      '_test_workspace_cb',
      'datasets/_test_workspace_cb',
      'bare_test',
      null,
      null,
    );
  });

  it('creates workspace at expected path', () => {
    expect(wsDir).toBe(path.join(PROJECT_ROOT, 'workspaces', '_test_workspace_cb__bare_test'));
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  it('copies codebase files', () => {
    expect(fs.existsSync(path.join(wsDir, 'contracts', 'Vault.sol'))).toBe(true);
  });

  it('creates CLAUDE.md (blocks parent walk-up)', () => {
    const claudeMd = path.join(wsDir, 'CLAUDE.md');
    expect(fs.existsSync(claudeMd)).toBe(true);
    const content = fs.readFileSync(claudeMd, 'utf8');
    expect(content).toContain('Benchmark Workspace');
    expect(content).toContain('Do not modify files outside this directory');
  });

  it('CLAUDE.md includes scope info from scope.txt', () => {
    const content = fs.readFileSync(path.join(wsDir, 'CLAUDE.md'), 'utf8');
    expect(content).toContain('Audit Scope');
    expect(content).toContain('Vault.sol');
  });

  it('does NOT have .claude/commands/ (bare run)', () => {
    const commandsDir = path.join(wsDir, '.claude', 'commands');
    expect(fs.existsSync(commandsDir)).toBe(false);
  });
});

describe('skill workspace', () => {
  let wsDir: string;

  beforeAll(async () => {
    resetWorkspaceCache();
    wsDir = await prepareWorkspace(
      '_test_workspace_cb',
      'datasets/_test_workspace_cb',
      'skill_test',
      'v2',
      TMP_SKILL_DIR,
    );
  });

  it('installs skill in .claude/commands/', () => {
    const skillPath = path.join(wsDir, '.claude', 'commands', 'solidity-auditor');
    expect(fs.existsSync(skillPath)).toBe(true);
  });

  it('skill SKILL.md is patched with scoped /tmp/ paths', () => {
    const skillMd = path.join(wsDir, '.claude', 'commands', 'solidity-auditor', 'SKILL.md');
    const content = fs.readFileSync(skillMd, 'utf8');
    expect(content).toContain('/tmp/audit-_test_workspace_cb-skill_test-');
    expect(content).not.toMatch(/\/tmp\/audit-agent/);
  });

  it('skill SKILL.md contains canary string', () => {
    const skillMd = path.join(wsDir, '.claude', 'commands', 'solidity-auditor', 'SKILL.md');
    const content = fs.readFileSync(skillMd, 'utf8');
    expect(content).toContain('BENCHMARK_CANARY_');
    expect(content).toContain('BENCHMARK_CONTROL');
  });

  it('VERSION file matches expected version', () => {
    const versionFile = path.join(wsDir, '.claude', 'commands', 'solidity-auditor', 'VERSION');
    const version = fs.readFileSync(versionFile, 'utf8').trim();
    expect(version).toBe('v2');
  });
});

describe('skill version mismatch', () => {
  it('throws on version mismatch', async () => {
    resetWorkspaceCache();
    const wrongSkillDir = path.join(PROJECT_ROOT, 'skills_versions', '_test_v2', 'solidity-auditor-wrong');
    fs.mkdirSync(wrongSkillDir, { recursive: true });
    fs.writeFileSync(path.join(wrongSkillDir, 'SKILL.md'), '# Wrong');
    fs.writeFileSync(path.join(wrongSkillDir, 'VERSION'), 'v99\n');

    await expect(
      prepareWorkspace('_test_workspace_cb', 'datasets/_test_workspace_cb', 'skill_wrong', 'v2', wrongSkillDir),
    ).rejects.toThrow('version mismatch');

    // Clean up
    fs.rmSync(wrongSkillDir, { recursive: true, force: true });
  });
});
