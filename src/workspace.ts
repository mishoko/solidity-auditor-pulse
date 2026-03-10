import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSimple } from './util/shell.js';
import * as log from './util/logger.js';

const ROOT = process.cwd();

/**
 * For skill runs: one workspace per (codebase, skillVersion).
 * Contains a symlinked codebase + .claude/commands/ with the skill.
 * Reused across iterations and conditions sharing the same skill version.
 *
 * For bare runs: no workspace needed — run directly from the dataset.
 */

/** Cache of already-prepared workspaces: "codebaseId::skillVersion" → cwdPath */
const preparedWorkspaces = new Map<string, string>();

function workspaceKey(codebaseId: string, skillVersion: string): string {
  return `${codebaseId}::${skillVersion}`;
}

function workspaceDir(codebaseId: string, skillVersion: string): string {
  return path.join(ROOT, 'workspaces', `${codebaseId}_${skillVersion}`);
}

/**
 * Returns the cwd to use for a run.
 * - Bare: returns the dataset path directly (no copy).
 * - Skill: returns symlinked workspace with .claude/commands/ set up.
 */
export function getRunCwd(
  codebaseId: string,
  codebasePath: string,
  skillVersion: string | null,
): string {
  if (skillVersion === null) {
    // Bare run — use dataset directly
    return path.resolve(ROOT, codebasePath);
  }

  const key = workspaceKey(codebaseId, skillVersion);
  const cached = preparedWorkspaces.get(key);
  if (cached) return cached;

  // Not yet prepared — will be set up by prepareSkillWorkspace
  throw new Error(`Workspace not prepared for ${key}. Call prepareSkillWorkspace first.`);
}

/**
 * Prepares a workspace for a (codebase, skillVersion) pair.
 * Symlinks the codebase and copies .claude/commands/ with the skill.
 * Idempotent — skips if already prepared.
 */
export async function prepareSkillWorkspace(
  codebaseId: string,
  codebasePath: string,
  skillVersion: string,
  skillSrcPath: string,
): Promise<string> {
  const key = workspaceKey(codebaseId, skillVersion);
  if (preparedWorkspaces.has(key)) {
    return preparedWorkspaces.get(key)!;
  }

  const src = path.resolve(ROOT, codebasePath);
  if (!fs.existsSync(src)) {
    throw new Error(`Codebase not found: ${src}`);
  }

  const wsDir = workspaceDir(codebaseId, skillVersion);
  const codeDest = path.join(wsDir, 'code');

  // Create workspace and symlink codebase
  fs.mkdirSync(wsDir, { recursive: true });
  if (!fs.existsSync(codeDest)) {
    fs.symlinkSync(src, codeDest);
  }

  // Install skill into .claude/commands/
  const commandsDir = path.join(wsDir, '.claude', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  const skillDest = path.join(commandsDir, 'solidity-auditor');
  if (!fs.existsSync(skillDest)) {
    await execSimple(`cp -R "${skillSrcPath}" "${skillDest}"`);
  }

  log.info(`Workspace: ${codebaseId}/${skillVersion} (symlinked + skill installed)`);

  preparedWorkspaces.set(key, codeDest);
  return codeDest;
}

export async function resolveGitCommit(dirPath: string): Promise<string | undefined> {
  const abs = path.resolve(ROOT, dirPath);
  try {
    return await execSimple('git rev-parse HEAD', abs);
  } catch {
    return undefined;
  }
}

/**
 * Cleans up all workspaces. Call after the full benchmark suite completes.
 */
export function cleanupWorkspaces(): void {
  const wsRoot = path.join(ROOT, 'workspaces');
  if (fs.existsSync(wsRoot)) {
    fs.rmSync(wsRoot, { recursive: true, force: true });
    log.info('Workspaces cleaned up');
  }
  preparedWorkspaces.clear();
}
