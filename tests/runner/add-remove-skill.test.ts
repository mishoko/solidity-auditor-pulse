import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Integration test for npm run add-skill / remove-skill.
 *
 * Creates a temporary local git repo with a mock skill,
 * adds it, verifies installation + bench.json, then removes it.
 */

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const TMP_REPO = path.join(PROJECT_ROOT, '.tmp-test-skill-repo');
const SKILL_NAME = 'test-skill-v1';
const CONDITION_ID = 'test_skill_v1';
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'bench.json');

let originalConfig: string;

beforeAll(() => {
  // Save original bench.json
  originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8');

  // Create a local git repo with a mock skill
  fs.mkdirSync(path.join(TMP_REPO, 'my-auditor'), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_REPO, 'my-auditor', 'SKILL.md'),
    '---\nname: my-auditor\n---\n# My Auditor\nAudit the code.\n',
  );
  fs.writeFileSync(path.join(TMP_REPO, 'my-auditor', 'VERSION'), '1\n');
  fs.writeFileSync(path.join(TMP_REPO, 'README.md'), '# Test repo\n');

  execSync('git init && git add -A && git commit -m "init"', {
    cwd: TMP_REPO,
    stdio: 'pipe',
  });
});

afterAll(() => {
  // Restore original bench.json
  fs.writeFileSync(CONFIG_PATH, originalConfig);

  // Clean up temp repo
  if (fs.existsSync(TMP_REPO)) fs.rmSync(TMP_REPO, { recursive: true, force: true });

  // Clean up installed skill (in case test failed mid-way)
  const skillDir = path.join(PROJECT_ROOT, 'skills_versions', SKILL_NAME);
  if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true, force: true });
});

describe('add-skill', () => {
  it('installs skill from local repo and adds condition', () => {
    const result = execSync(
      `node dist/runner/add-skill.js --name ${SKILL_NAME} --repo "${TMP_REPO}" --path my-auditor`,
      { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: 'pipe' },
    );

    expect(result).toContain('Skill installed');
    expect(result).toContain('Condition added');

    // Verify files on disk
    const skillDir = path.join(PROJECT_ROOT, 'skills_versions', SKILL_NAME);
    expect(fs.existsSync(skillDir)).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'my-auditor', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'my-auditor', 'VERSION'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'source.json'))).toBe(true);

    // Verify source.json
    const source = JSON.parse(fs.readFileSync(path.join(skillDir, 'source.json'), 'utf8'));
    expect(source.repo).toBe(TMP_REPO);
    expect(source.commit).toBeTruthy();
    expect(source.tag).toBe(SKILL_NAME);

    // Verify bench.json condition
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const condition = config.conditions.find((c: { id: string }) => c.id === CONDITION_ID);
    expect(condition).toBeTruthy();
    expect(condition.type).toBe('skill');
    expect(condition.skillVersion).toBe(SKILL_NAME);
    expect(condition.command).toBe('/my-auditor');
  });

  it('refuses duplicate skill name', () => {
    expect(() => {
      execSync(
        `node dist/runner/add-skill.js --name ${SKILL_NAME} --repo "${TMP_REPO}" --path my-auditor`,
        { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: 'pipe' },
      );
    }).toThrow();
  });
});

describe('remove-skill', () => {
  it('removes skill and condition', () => {
    const result = execSync(
      `node dist/runner/remove-skill.js --name ${SKILL_NAME}`,
      { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: 'pipe' },
    );

    expect(result).toContain('Removed condition');
    expect(result).toContain(`Removed skills_versions/${SKILL_NAME}/`);

    // Verify files removed
    const skillDir = path.join(PROJECT_ROOT, 'skills_versions', SKILL_NAME);
    expect(fs.existsSync(skillDir)).toBe(false);

    // Verify condition removed from bench.json
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const condition = config.conditions.find((c: { id: string }) => c.id === CONDITION_ID);
    expect(condition).toBeUndefined();
  });

  it('handles already-removed skill gracefully', () => {
    const result = execSync(
      `node dist/runner/remove-skill.js --name ${SKILL_NAME}`,
      { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: 'pipe' },
    );

    expect(result).toContain('No condition');
    expect(result).toContain('No directory');
  });
});
