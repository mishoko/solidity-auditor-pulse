#!/usr/bin/env node

/**
 * npm run add-codebase -- --name <id> --repo <github-url> [--commit <sha>]
 *
 * Adds a codebase as a git submodule and registers it in bench.json.
 *
 * For local (non-submodule) codebases, use --local <path> instead of --repo.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'config', 'bench.json');

function printUsage(): void {
  console.log(`
add-codebase — Add a Solidity codebase for benchmarking

Usage:
  npm run add-codebase -- --name <id> --repo <github-url> [options]
  npm run add-codebase -- --name <id> --local <path> [options]

Required:
  --name <id>         Codebase identifier (e.g. "my-protocol")

Source (one required):
  --repo <url>        GitHub repository URL (added as git submodule)
  --local <path>      Path to existing local directory (no submodule)

Options:
  --commit <sha>      Pin submodule to specific commit
  --help              Show this help
`);
}

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    repo: { type: 'string' },
    local: { type: 'string' },
    commit: { type: 'string' },
    help: { type: 'boolean' },
  },
  strict: true,
});

if (values.help) {
  printUsage();
  process.exit(0);
}

if (!values.name) {
  console.error('Error: --name is required');
  printUsage();
  process.exit(1);
}

if (!values.repo && !values.local) {
  console.error('Error: --repo or --local is required');
  printUsage();
  process.exit(1);
}

const name = values.name;
const datasetPath = `datasets/${name}`;
const fullPath = path.join(ROOT, datasetPath);

// Check for duplicate
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
if (config.codebases.some((c: { id: string }) => c.id === name)) {
  console.error(`Error: codebase "${name}" already exists in bench.json`);
  process.exit(1);
}

if (fs.existsSync(fullPath)) {
  console.error(`Error: ${datasetPath} already exists on disk`);
  process.exit(1);
}

let gitCommit: string | undefined;

if (values.repo) {
  // Add as git submodule
  console.log(`Adding submodule: ${values.repo} → ${datasetPath}`);
  execSync(`git submodule add "${values.repo}" "${datasetPath}"`, { cwd: ROOT, stdio: 'inherit' });

  if (values.commit) {
    console.log(`Checking out commit: ${values.commit}`);
    execSync(`git checkout ${values.commit}`, { cwd: fullPath, stdio: 'pipe' });
    gitCommit = values.commit;
  } else {
    gitCommit = execSync('git rev-parse HEAD', { cwd: fullPath, encoding: 'utf8' }).trim();
  }
} else if (values.local) {
  // Copy local directory
  const src = path.resolve(values.local);
  if (!fs.existsSync(src)) {
    console.error(`Error: local path not found: ${src}`);
    process.exit(1);
  }
  console.log(`Copying local codebase: ${src} → ${datasetPath}`);
  execSync(`cp -R "${src}" "${fullPath}"`, { stdio: 'pipe' });
}

// Add to bench.json
const entry: Record<string, unknown> = {
  id: name,
  path: datasetPath,
};
if (gitCommit) {
  entry.gitCommit = gitCommit;
}

config.codebases.push(entry);
fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

// Check for scope.txt
const hasScope = fs.existsSync(path.join(fullPath, 'scope.txt'));
const hasGt = fs.existsSync(path.join(ROOT, 'ground_truth', `${name}.json`));

console.log(`\nCodebase added: "${name}"`);
console.log(`  Path:        ${datasetPath}`);
if (gitCommit) console.log(`  Commit:      ${gitCommit.slice(0, 12)}`);
console.log(`  scope.txt:   ${hasScope ? '✓' : '✗ (optional — add for focused audits)'}`);
console.log(`  Ground truth: ${hasGt ? '✓' : '✗ (optional — add ground_truth/' + name + '.json for recall scoring)'}`);
console.log(`\nDone. Run: npm run bench:dry -- --codebases ${name}`);
