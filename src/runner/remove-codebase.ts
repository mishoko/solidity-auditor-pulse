#!/usr/bin/env node

/**
 * npm run remove-codebase -- --name <id>
 *
 * Removes a codebase: git submodule (if applicable), dataset directory,
 * bench.json entry, and optionally ground truth.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'config', 'bench.json');

function printUsage(): void {
  console.log(`
remove-codebase — Remove a codebase from the benchmark

Usage:
  npm run remove-codebase -- --name <id>

Arguments:
  --name <id>     Codebase identifier to remove (e.g. "my-protocol")
  --keep-gt       Keep ground truth file (default: remove it)
  --help          Show this help
`);
}

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    'keep-gt': { type: 'boolean' },
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

const name = values.name;
const datasetPath = `datasets/${name}`;
const fullPath = path.join(ROOT, datasetPath);

// Check if it's a submodule
function isSubmodule(name: string): boolean {
  const gitmodules = path.join(ROOT, '.gitmodules');
  if (!fs.existsSync(gitmodules)) return false;
  const content = fs.readFileSync(gitmodules, 'utf8');
  return content.includes(`path = datasets/${name}`);
}

// Remove from bench.json
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const before = config.codebases.length;
config.codebases = config.codebases.filter((c: { id: string }) => c.id !== name);
const removed = before - config.codebases.length;

if (removed > 0) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`Removed "${name}" from bench.json`);
} else {
  console.log(`No codebase "${name}" found in bench.json — skipping`);
}

// Remove submodule or directory
if (isSubmodule(name)) {
  console.log(`Removing git submodule: ${datasetPath}`);
  try {
    execSync(`git submodule deinit -f "${datasetPath}"`, { cwd: ROOT, stdio: 'pipe' });
  } catch { /* may already be deinited */ }
  try {
    execSync(`git rm -f "${datasetPath}"`, { cwd: ROOT, stdio: 'pipe' });
  } catch { /* may already be removed */ }
  // Clean up .git/modules entry
  const modulePath = path.join(ROOT, '.git', 'modules', datasetPath);
  if (fs.existsSync(modulePath)) {
    fs.rmSync(modulePath, { recursive: true, force: true });
  }
  console.log(`Submodule removed: ${datasetPath}`);
} else if (fs.existsSync(fullPath)) {
  fs.rmSync(fullPath, { recursive: true, force: true });
  console.log(`Removed directory: ${datasetPath}`);
} else {
  console.log(`No directory ${datasetPath} found — skipping`);
}

// Remove ground truth (unless --keep-gt)
if (!values['keep-gt']) {
  const gtFile = path.join(ROOT, 'ground_truth', `${name}.json`);
  if (fs.existsSync(gtFile)) {
    fs.rmSync(gtFile);
    console.log(`Removed ground_truth/${name}.json`);
  }
}

console.log('Done.');
