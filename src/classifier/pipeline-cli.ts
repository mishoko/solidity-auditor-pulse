/**
 * CLI entrypoint for the analysis pipeline.
 *
 * Usage:
 *   npm run analyze                   # full pipeline
 *   npm run analyze -- --no-validate  # skip Opus validation
 *   npm run analyze -- --no-report    # skip report generation
 *   npm run analyze -- --force        # force re-run everything
 *   npm run analyze -- --latest       # only latest run per condition
 */

import * as path from 'node:path';
import { runPipeline, type PipelineOptions } from './pipeline.js';
import * as log from '../shared/util/logger.js';

const args = process.argv.slice(2);

const options: PipelineOptions = {
  force: args.includes('--force'),
  validate: !args.includes('--no-validate'),
  report: !args.includes('--no-report'),
  latest: args.includes('--latest'),
};

const resultsDir = path.resolve(process.cwd(), 'results');

log.info('Analysis Pipeline');
log.info(`  Results: ${resultsDir}`);
log.info(`  Validate: ${options.validate}`);
log.info(`  Report: ${options.report}`);
log.info(`  Force: ${options.force}`);
log.info(`  Latest only: ${options.latest}`);
log.separator();

runPipeline(resultsDir, options).catch((err) => {
  log.error(`Pipeline failed: ${err}`);
  process.exit(1);
});
