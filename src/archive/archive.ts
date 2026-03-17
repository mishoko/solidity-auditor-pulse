/**
 * Archive current results into a timestamped, self-contained snapshot.
 *
 * Moves all result files + copies summary.md, dashboard.html, report-data.json,
 * bench config, ground truth, and skill version provenance into a single
 * archive folder under archive-results/.
 *
 * Writes MANIFEST.json with full provenance (git SHA, prompt hashes, etc).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { hashContent } from '../shared/util/hash.js';
import * as log from '../shared/util/logger.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RESULTS_DIR = path.join(ROOT, 'results');
const ARCHIVE_ROOT = path.join(ROOT, 'archive-results');

interface Manifest {
  archivedAt: string;
  pipeline: {
    gitSha: string;
    gitBranch: string;
    dirty: boolean;
  };
  codebases: string[];
  conditions: string[];
  runs: {
    total: number;
    perCodebase: Record<string, number>;
  };
  benchConfig: unknown;
  skillVersions: Record<string, unknown>;
  groundTruth: Record<string, string>; // codebaseId → content hash
  promptHashes: Record<string, string>;
  files: string[];
}

/** Extract unique codebase IDs from meta.json filenames. */
function discoverCodebases(metaFiles: string[]): string[] {
  const codebases = new Set<string>();
  for (const f of metaFiles) {
    // Format: <timestamp>_<codebaseId>_<conditionId>_<runN>.meta.json
    try {
      const meta = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (meta.codebaseId) codebases.add(meta.codebaseId);
    } catch {
      // Skip corrupt files
    }
  }
  return [...codebases].sort();
}

/** Extract unique condition IDs from meta.json files. */
function discoverConditions(metaFiles: string[]): string[] {
  const conditions = new Set<string>();
  for (const f of metaFiles) {
    try {
      const meta = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (meta.conditionId) conditions.add(meta.conditionId);
    } catch {
      // Skip corrupt files
    }
  }
  return [...conditions].sort();
}

/** Get git info for provenance. */
function getGitInfo(): { sha: string; branch: string; dirty: boolean } {
  try {
    const sha = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim();
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf-8' }).trim();
    return { sha, branch, dirty: status.length > 0 };
  } catch {
    return { sha: 'unknown', branch: 'unknown', dirty: false };
  }
}

/** Read and hash prompt templates from classifier source files. */
function getPromptHashes(): Record<string, string> {
  const hashes: Record<string, string> = {};
  const classifyPath = path.join(ROOT, 'src', 'classifier', 'classify.ts');
  const clusterPath = path.join(ROOT, 'src', 'classifier', 'cluster.ts');
  const validatePath = path.join(ROOT, 'src', 'classifier', 'validate.ts');

  for (const [name, filePath] of [['classify', classifyPath], ['cluster', clusterPath], ['validate', validatePath]] as const) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      hashes[name] = hashContent(content);
    } catch {
      hashes[name] = 'unknown';
    }
  }
  return hashes;
}

/** Load skill version source.json files. */
function getSkillVersions(): Record<string, unknown> {
  const versions: Record<string, unknown> = {};
  const skillsDir = path.join(ROOT, 'skills_versions');
  if (!fs.existsSync(skillsDir)) return versions;

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceFile = path.join(skillsDir, entry.name, 'source.json');
    try {
      versions[entry.name] = JSON.parse(fs.readFileSync(sourceFile, 'utf-8'));
    } catch {
      // No source.json for this version
    }
  }
  return versions;
}

/** Hash ground truth files. */
function getGroundTruthHashes(): Record<string, string> {
  const hashes: Record<string, string> = {};
  const gtDir = path.join(ROOT, 'ground_truth');
  if (!fs.existsSync(gtDir)) return hashes;

  for (const f of fs.readdirSync(gtDir)) {
    if (!f.endsWith('.json')) continue;
    const codebaseId = f.replace('.json', '');
    try {
      const content = fs.readFileSync(path.join(gtDir, f), 'utf-8');
      hashes[codebaseId] = hashContent(content);
    } catch {
      // Skip
    }
  }
  return hashes;
}

/** Load bench config. */
function getBenchConfig(): unknown {
  const configPath = path.join(ROOT, 'config', 'bench.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function archive(dryRun = false): string {
  // Validate results dir exists and has content
  if (!fs.existsSync(RESULTS_DIR)) {
    log.error('No results/ directory found. Nothing to archive.');
    process.exit(1);
  }

  const allFiles = fs.readdirSync(RESULTS_DIR);
  const metaFiles = allFiles
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => path.join(RESULTS_DIR, f));

  if (metaFiles.length === 0) {
    log.error('No .meta.json files in results/. Nothing to archive.');
    process.exit(1);
  }

  // Discover what we have
  const codebases = discoverCodebases(metaFiles);
  const conditions = discoverConditions(metaFiles);
  const gitInfo = getGitInfo();

  // Build folder name: <date>_<codebases>
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const codebaseStr = codebases.join('+');
  const folderName = `${dateStr}_${codebaseStr}`;
  const archiveDir = path.join(ARCHIVE_ROOT, folderName);

  log.info('Archive');
  log.info(`  Codebases: ${codebases.join(', ')}`);
  log.info(`  Conditions: ${conditions.join(', ')}`);
  log.info(`  Runs: ${metaFiles.length}`);
  log.info(`  Git: ${gitInfo.sha.slice(0, 8)} (${gitInfo.branch})${gitInfo.dirty ? ' [dirty]' : ''}`);
  log.info(`  Target: archive-results/${folderName}/`);
  log.separator();

  if (dryRun) {
    log.dry('Would archive the above. Re-run without --dry-run to proceed.');
    return archiveDir;
  }

  // Create archive directory
  if (fs.existsSync(archiveDir)) {
    // Append counter for uniqueness
    let counter = 2;
    let uniqueDir = `${archiveDir}_${counter}`;
    while (fs.existsSync(uniqueDir)) {
      counter++;
      uniqueDir = `${archiveDir}_${counter}`;
    }
    log.warn(`Archive folder exists, using: ${path.basename(uniqueDir)}`);
    fs.mkdirSync(uniqueDir, { recursive: true });
    return archiveToDir(uniqueDir, allFiles, metaFiles, codebases, conditions, gitInfo);
  }

  fs.mkdirSync(archiveDir, { recursive: true });
  return archiveToDir(archiveDir, allFiles, metaFiles, codebases, conditions, gitInfo);
}

function archiveToDir(
  archiveDir: string,
  allResultFiles: string[],
  metaFiles: string[],
  codebases: string[],
  conditions: string[],
  gitInfo: { sha: string; branch: string; dirty: boolean },
): string {
  const archivedFiles: string[] = [];

  // 1. Move all files from results/ (except .nosync and archive-3vote/)
  log.info('Moving result files...');
  for (const f of allResultFiles) {
    if (f === '.nosync' || f === '.gitkeep') continue;
    const src = path.join(RESULTS_DIR, f);
    const stat = fs.statSync(src);

    if (stat.isDirectory()) {
      // Skip directories (like archive-3vote/) — they're legacy
      log.warn(`  Skipping directory: ${f}`);
      continue;
    }

    const dest = path.join(archiveDir, f);
    fs.renameSync(src, dest);
    archivedFiles.push(f);
  }
  log.success(`  Moved ${archivedFiles.length} files`);

  // 2. Copy project-level artifacts (these stay in place, copy to archive)
  const artifacts: Array<{ src: string; destName: string; required: boolean }> = [
    { src: path.join(ROOT, 'summary.md'), destName: 'summary.md', required: false },
    { src: path.join(ROOT, 'dashboard.html'), destName: 'dashboard.html', required: false },
    { src: path.join(ROOT, 'config', 'bench.json'), destName: 'bench.json', required: false },
  ];

  for (const { src, destName, required } of artifacts) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(archiveDir, destName));
      archivedFiles.push(destName);
      log.info(`  Copied ${destName}`);
    } else if (required) {
      log.warn(`  Missing expected artifact: ${destName}`);
    }
  }

  // 3. Copy ground truth files used
  const gtDir = path.join(ROOT, 'ground_truth');
  if (fs.existsSync(gtDir)) {
    const gtArchiveDir = path.join(archiveDir, 'ground_truth');
    fs.mkdirSync(gtArchiveDir, { recursive: true });
    for (const codebase of codebases) {
      const gtFile = path.join(gtDir, `${codebase}.json`);
      if (fs.existsSync(gtFile)) {
        fs.copyFileSync(gtFile, path.join(gtArchiveDir, `${codebase}.json`));
        archivedFiles.push(`ground_truth/${codebase}.json`);
      }
    }
  }

  // 4. Build and write manifest
  const runsPerCodebase: Record<string, number> = {};
  for (const f of metaFiles) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(archiveDir, path.basename(f)), 'utf-8'));
      const cb = meta.codebaseId || 'unknown';
      runsPerCodebase[cb] = (runsPerCodebase[cb] || 0) + 1;
    } catch {
      // File already moved, read from archive
    }
  }

  const manifest: Manifest = {
    archivedAt: new Date().toISOString(),
    pipeline: {
      gitSha: gitInfo.sha,
      gitBranch: gitInfo.branch,
      dirty: gitInfo.dirty,
    },
    codebases,
    conditions,
    runs: {
      total: metaFiles.length,
      perCodebase: runsPerCodebase,
    },
    benchConfig: getBenchConfig(),
    skillVersions: getSkillVersions(),
    groundTruth: getGroundTruthHashes(),
    promptHashes: getPromptHashes(),
    files: archivedFiles.sort(),
  };

  const manifestPath = path.join(archiveDir, 'MANIFEST.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  log.success(`  Wrote MANIFEST.json`);

  // 5. Clean up root-level generated files (copies are in the archive)
  const rootArtifacts = ['summary.md', 'dashboard.html'];
  for (const artifact of rootArtifacts) {
    const p = path.join(ROOT, artifact);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      log.info(`  Removed ${artifact} from project root`);
    }
  }

  // 6. Recreate empty results/ with .nosync
  fs.writeFileSync(path.join(RESULTS_DIR, '.nosync'), '');
  log.success(`  Restored results/.nosync`);

  log.separator();
  log.success(`Archived ${archivedFiles.length} files to archive-results/${path.basename(archiveDir)}/`);
  log.info('results/ is now clean — ready for new benchmark runs.');

  return archiveDir;
}
