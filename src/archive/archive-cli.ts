/**
 * CLI entrypoint for archiving results.
 *
 * Usage:
 *   npm run archive             # archive current results
 *   npm run archive -- --dry-run  # preview without moving files
 */

import { archive } from './archive.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

archive(dryRun);
