/**
 * CLI entrypoint for standalone report generation.
 *
 * Usage: npm run report
 *        npm run report -- --latest
 */

import * as path from 'node:path';
import { generateReport } from './report.js';
import * as log from '../shared/util/logger.js';

const args = process.argv.slice(2);

const resultsDir = path.resolve(process.cwd(), 'results');
const latest = args.includes('--latest');

log.info(`Generating report (latest: ${latest})`);

generateReport(resultsDir, { latest }).catch((err) => {
  log.error(`Report generation failed: ${err}`);
  process.exit(1);
});
