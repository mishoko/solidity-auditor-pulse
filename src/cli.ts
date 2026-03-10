#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { runBench } from './runner.js';
import type { CliOptions } from './types.js';
import * as log from './util/logger.js';

function printUsage(): void {
  console.log(`
benchmark-runner — Benchmark solidity-auditor skill vs bare Claude

Usage:
  node dist/cli.js [options]

Options:
  --config <path>       Config file (default: config/bench.json)
  --runs <n>            Override runs per condition
  --codebases <a,b>     Filter codebases (comma-separated ids)
  --conditions <a,b>    Filter conditions (comma-separated ids)
  --model <model>       Claude model (e.g. opus, sonnet)
  --dry-run             Print commands without executing
  --help                Show this help
`);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'config/bench.json' },
      runs: { type: 'string' },
      codebases: { type: 'string' },
      conditions: { type: 'string' },
      model: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const opts: CliOptions = {
    configPath: values.config!,
    runsOverride: values.runs ? parseInt(values.runs, 10) : undefined,
    codebaseFilter: values.codebases?.split(','),
    conditionFilter: values.conditions?.split(','),
    model: values.model,
    dryRun: values['dry-run']!,
  };

  if (opts.runsOverride !== undefined && (isNaN(opts.runsOverride) || opts.runsOverride < 1)) {
    log.error('--runs must be a positive integer');
    process.exit(1);
  }

  const config = loadConfig(opts.configPath);

  log.info(`Config loaded: ${opts.configPath}`);
  if (opts.dryRun) log.warn('Dry run mode — no claude processes will be spawned');

  runBench(config, opts).catch((err) => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

main();
