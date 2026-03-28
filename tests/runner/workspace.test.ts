import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { prepareWorkspace, resetWorkspaceCache } from '../../src/runner/workspace.js';
import { skillDirName } from '../../src/runner/skill.js';

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
const SKILL_VERSION = '_test_skill';
const SKILL_NAME = 'test-auditor';
const TMP_SKILL_DIR = path.join(PROJECT_ROOT, 'skills_versions', SKILL_VERSION, SKILL_NAME);

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
  fs.writeFileSync(path.join(TMP_SKILL_DIR, 'VERSION'), 'test1\n');
});

afterAll(() => {
  resetWorkspaceCache();
  // Clean up temp dataset and skill
  if (fs.existsSync(TMP_DATASET)) fs.rmSync(TMP_DATASET, { recursive: true, force: true });
  const skillParent = path.join(PROJECT_ROOT, 'skills_versions', SKILL_VERSION);
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
  let detectedDirName: string;

  beforeAll(async () => {
    resetWorkspaceCache();
    detectedDirName = skillDirName(SKILL_VERSION);
    wsDir = await prepareWorkspace(
      '_test_workspace_cb',
      'datasets/_test_workspace_cb',
      'skill_test',
      SKILL_VERSION,
      TMP_SKILL_DIR,
    );
  });

  it('auto-detects skill directory name', () => {
    expect(detectedDirName).toBe(SKILL_NAME);
  });

  it('installs skill in .claude/commands/', () => {
    const skillPath = path.join(wsDir, '.claude', 'commands', detectedDirName);
    expect(fs.existsSync(skillPath)).toBe(true);
  });

  it('skill SKILL.md is patched with scoped /tmp/ paths', () => {
    const skillMd = path.join(wsDir, '.claude', 'commands', detectedDirName, 'SKILL.md');
    const content = fs.readFileSync(skillMd, 'utf8');
    expect(content).toContain('/tmp/audit-_test_workspace_cb-skill_test-');
    expect(content).not.toMatch(/\/tmp\/audit-agent/);
  });

  it('skill SKILL.md contains canary string', () => {
    const skillMd = path.join(wsDir, '.claude', 'commands', detectedDirName, 'SKILL.md');
    const content = fs.readFileSync(skillMd, 'utf8');
    expect(content).toContain('BENCHMARK_CANARY_');
    expect(content).toContain('BENCHMARK_CONTROL');
  });

  it('VERSION file matches source', () => {
    const versionFile = path.join(wsDir, '.claude', 'commands', detectedDirName, 'VERSION');
    const version = fs.readFileSync(versionFile, 'utf8').trim();
    expect(version).toBe('test1');
  });
});

describe('skill version mismatch', () => {
  it('throws on version mismatch', async () => {
    resetWorkspaceCache();
    // Create a second skill dir with a different VERSION to force mismatch
    const wrongSkillDir = path.join(PROJECT_ROOT, 'skills_versions', SKILL_VERSION, 'wrong-auditor');
    fs.mkdirSync(wrongSkillDir, { recursive: true });
    fs.writeFileSync(path.join(wrongSkillDir, 'SKILL.md'), '# Wrong');
    fs.writeFileSync(path.join(wrongSkillDir, 'VERSION'), 'v99\n');

    // Pass the wrong skill src but the correct skillVersion — VERSION file won't match source
    await expect(
      prepareWorkspace('_test_workspace_cb', 'datasets/_test_workspace_cb', 'skill_wrong', SKILL_VERSION, wrongSkillDir),
    ).rejects.toThrow('version mismatch');

    // Clean up
    fs.rmSync(wrongSkillDir, { recursive: true, force: true });
  });
});
