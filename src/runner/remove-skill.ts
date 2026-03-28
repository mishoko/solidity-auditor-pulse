#!/usr/bin/env node

/**
 * npm run remove-skill -- --name <name>
 *
 * Removes a skill from skills_versions/ and its condition from bench.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = process.cwd();
const SKILLS_DIR = path.join(ROOT, 'skills_versions');
const CONFIG_PATH = path.join(ROOT, 'config', 'bench.json');

function printUsage(): void {
  console.log(`
remove-skill — Remove a skill from the benchmark

Usage:
  npm run remove-skill -- --name <name>

Arguments:
  --name <name>   Skill version name to remove (e.g. "darknavy-v1")
  --help          Show this help
`);
}

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
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
const conditionId = name.replace(/-/g, '_');
const skillDir = path.join(SKILLS_DIR, name);

// Remove from bench.json
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const before = config.conditions.length;
config.conditions = config.conditions.filter((c: { id: string }) => c.id !== conditionId);
const removed = before - config.conditions.length;

if (removed > 0) {
  // Also remove any deep variant (e.g. pashov_v1 → pashov_v1_deep)
  const deepId = `${conditionId}_deep`;
  config.conditions = config.conditions.filter((c: { id: string }) => c.id !== deepId);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`Removed condition "${conditionId}" from bench.json`);
} else {
  console.log(`No condition "${conditionId}" found in bench.json — skipping`);
}

// Remove skill directory
if (fs.existsSync(skillDir)) {
  fs.rmSync(skillDir, { recursive: true, force: true });
  console.log(`Removed skills_versions/${name}/`);
} else {
  console.log(`No directory skills_versions/${name}/ found — skipping`);
}

console.log('Done.');
