#!/usr/bin/env node

/**
 * npm run add-skill -- --name <name> --repo <github-url> [--commit <sha>] [--command <slash-cmd>]
 *
 * Clones a skill from a GitHub repo into skills_versions/<name>/ and adds
 * a condition to config/bench.json.
 *
 * Examples:
 *   npm run add-skill -- --name darknavy-v1 --repo https://github.com/DarkNavySecurity/web3-skills --path contract-auditor
 *   npm run add-skill -- --name pashov-v3 --repo https://github.com/pashov/skills --path solidity-auditor --commit abc123
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const SKILLS_DIR = path.join(ROOT, 'skills_versions');
const CONFIG_PATH = path.join(ROOT, 'config', 'bench.json');

interface AddSkillOpts {
  name: string;
  repo: string;
  path?: string;
  commit?: string;
  command?: string;
  expectedMinAgents?: number;
}

function printUsage(): void {
  console.log(`
add-skill — Install a Claude Code skill for benchmarking

Usage:
  npm run add-skill -- --name <name> --repo <github-url> [options]

Required:
  --name <name>       Skill version name (e.g. "darknavy-v1", "pashov-v3")
  --repo <url>        GitHub repository URL

Options:
  --path <subdir>     Subdirectory in repo containing the skill (default: auto-detect)
  --commit <sha>      Pin to specific commit (default: HEAD of default branch)
  --command <cmd>     Slash command override (default: derived from skill dir name)
  --expected-agents <n>  Expected minimum agents for verification (default: 4)
  --help              Show this help
`);
}

function parseCliArgs(): AddSkillOpts {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      repo: { type: 'string' },
      path: { type: 'string' },
      commit: { type: 'string' },
      command: { type: 'string' },
      'expected-agents': { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  if (!values.name || !values.repo) {
    console.error('Error: --name and --repo are required');
    printUsage();
    process.exit(1);
  }

  return {
    name: values.name,
    repo: values.repo,
    path: values.path,
    commit: values.commit,
    command: values.command,
    expectedMinAgents: values['expected-agents'] ? parseInt(values['expected-agents'], 10) : undefined,
  };
}

function cloneSkill(opts: AddSkillOpts): string {
  const destDir = path.join(SKILLS_DIR, opts.name);

  if (fs.existsSync(destDir)) {
    console.error(`Error: skills_versions/${opts.name}/ already exists. Remove it first or use a different name.`);
    process.exit(1);
  }

  // Clone to temp dir first, then extract what we need
  const tmpDir = path.join(ROOT, '.tmp-skill-clone');
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`Cloning ${opts.repo}...`);
  const cloneArgs = ['git', 'clone', '--depth', '1'];
  if (opts.commit) {
    // For specific commits, we need full clone
    execSync(`git clone "${opts.repo}" "${tmpDir}"`, { stdio: 'pipe' });
    execSync(`git checkout ${opts.commit}`, { cwd: tmpDir, stdio: 'pipe' });
  } else {
    execSync(`${cloneArgs.join(' ')} "${opts.repo}" "${tmpDir}"`, { stdio: 'pipe' });
  }

  // Get the actual commit hash
  const commit = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

  // Find the skill directory
  let skillSubdir: string;
  if (opts.path) {
    skillSubdir = opts.path;
    const fullPath = path.join(tmpDir, skillSubdir, 'SKILL.md');
    if (!fs.existsSync(fullPath)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      console.error(`Error: No SKILL.md found at ${opts.path}/SKILL.md in the repo`);
      process.exit(1);
    }
  } else {
    // Auto-detect: find directory with SKILL.md
    skillSubdir = findSkillDir(tmpDir);
    if (!skillSubdir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      console.error('Error: Could not find a directory containing SKILL.md. Use --path to specify.');
      process.exit(1);
    }
  }

  const skillSrc = path.join(tmpDir, skillSubdir);
  const skillDirName = path.basename(skillSubdir);

  // Create destination and copy skill
  fs.mkdirSync(destDir, { recursive: true });
  execSync(`cp -R "${skillSrc}" "${path.join(destDir, skillDirName)}"`, { stdio: 'pipe' });

  // Create source.json
  const sourceJson = {
    repo: opts.repo,
    commit,
    tag: opts.name,
    snapshotDate: new Date().toISOString().split('T')[0],
  };
  fs.writeFileSync(path.join(destDir, 'source.json'), JSON.stringify(sourceJson, null, 2) + '\n');

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`Skill installed: skills_versions/${opts.name}/${skillDirName}/`);
  console.log(`Source: ${opts.repo} @ ${commit.slice(0, 12)}`);

  return skillDirName;
}

function findSkillDir(repoDir: string, maxDepth = 2): string {
  // BFS for SKILL.md up to maxDepth
  const queue: { dir: string; rel: string; depth: number }[] = [{ dir: repoDir, rel: '', depth: 0 }];

  while (queue.length > 0) {
    const { dir, rel, depth } = queue.shift()!;
    if (depth > maxDepth) continue;

    const skillMd = path.join(dir, 'SKILL.md');
    if (fs.existsSync(skillMd) && rel !== '') {
      return rel;
    }

    if (depth < maxDepth) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            queue.push({
              dir: path.join(dir, entry.name),
              rel: rel ? `${rel}/${entry.name}` : entry.name,
              depth: depth + 1,
            });
          }
        }
      } catch { /* skip unreadable dirs */ }
    }
  }

  return '';
}

function addCondition(name: string, skillDirName: string, opts: AddSkillOpts): void {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  // Derive condition ID: replace hyphens with underscores
  const conditionId = name.replace(/-/g, '_');

  // Check for duplicate
  if (config.conditions.some((c: { id: string }) => c.id === conditionId)) {
    console.log(`Condition "${conditionId}" already exists in bench.json — skipping`);
    return;
  }

  // Derive command from skill dir name or use override
  const command = opts.command ?? `/${skillDirName}`;

  const condition: Record<string, unknown> = {
    id: conditionId,
    type: 'skill',
    skillVersion: name,
    command,
  };

  if (opts.expectedMinAgents) {
    condition.expectedMinAgents = opts.expectedMinAgents;
  }

  config.conditions.push(condition);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

  console.log(`Condition added to bench.json: "${conditionId}" → /${skillDirName}`);
}

function verify(name: string): void {
  const destDir = path.join(SKILLS_DIR, name);
  const entries = fs.readdirSync(destDir, { withFileTypes: true });

  let skillDir: string | null = null;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillMd = path.join(destDir, entry.name, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        skillDir = entry.name;
        break;
      }
    }
  }

  if (!skillDir) {
    console.error('FAIL: No SKILL.md found in installed skill');
    process.exit(1);
  }

  const versionFile = path.join(destDir, skillDir, 'VERSION');
  const hasVersion = fs.existsSync(versionFile);
  const sourceFile = path.join(destDir, 'source.json');
  const hasSource = fs.existsSync(sourceFile);

  console.log(`\nVerification:`);
  console.log(`  SKILL.md:    ✓ (${skillDir}/SKILL.md)`);
  console.log(`  VERSION:     ${hasVersion ? '✓' : '✗ (missing — verification checks will use source comparison)'}`);
  console.log(`  source.json: ${hasSource ? '✓' : '✗'}`);
  console.log(`  Skill name:  ${skillDir}`);

  if (hasSource) {
    const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    console.log(`  Commit:      ${source.commit?.slice(0, 12) ?? 'unknown'}`);
  }
}

// ── Main ──

const opts = parseCliArgs();
const skillDirName = cloneSkill(opts);
addCondition(opts.name, skillDirName, opts);
verify(opts.name);

console.log(`\nDone. Run: npm run bench:dry -- --conditions ${opts.name.replace(/-/g, '_')} --codebases canary`);
