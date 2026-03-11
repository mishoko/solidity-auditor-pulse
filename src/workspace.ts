import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSimple } from './util/shell.js';
import * as log from './util/logger.js';

const ROOT = process.cwd();

/**
 * For skill runs: one workspace per (codebase, conditionId).
 * Contains a REAL COPY of the codebase + .claude/commands/ with the skill.
 *
 * Why real copies, not symlinks:
 *   Claude Code resolves symlinked cwds to their real path, which bypasses
 *   workspace-local .claude/commands/ and falls back to user-level
 *   ~/.claude/commands/ (wrong skill version). Real copies avoid this entirely.
 *
 * Why per-condition, not per-skillVersion:
 *   V1 default and V1 deep share the same skill version but should NOT share
 *   a workspace. Two concurrent Claude processes in the same cwd can interfere.
 *
 * For bare runs: copies codebase to workspace too (keeps datasets/ untouched).
 */

/** Cache of already-prepared workspaces: "codebaseId::conditionId" → cwdPath */
const preparedWorkspaces = new Map<string, string>();

function workspaceKey(codebaseId: string, conditionId: string): string {
  return `${codebaseId}::${conditionId}`;
}

function workspaceDir(codebaseId: string, conditionId: string): string {
  return path.join(ROOT, 'workspaces', `${codebaseId}__${conditionId}`);
}

/**
 * Returns the cwd to use for a run.
 */
export function getRunCwd(
  codebaseId: string,
  conditionId: string,
): string {
  const key = workspaceKey(codebaseId, conditionId);
  const cached = preparedWorkspaces.get(key);
  if (cached) return cached;

  throw new Error(`Workspace not prepared for ${key}. Call prepareWorkspace first.`);
}

/**
 * Prepares a workspace for a (codebase, condition) pair.
 *
 * Structure:
 *   workspaces/<codebase>__<conditionId>/
 *   ├── .claude/commands/solidity-auditor/   ← skill copy (skill runs only)
 *   ├── Contract1.sol                        ← real copy from datasets/
 *   ├── Contract2.sol                        ← real copy
 *   └── subdir/                              ← real copy
 *
 * Datasets are NEVER used directly — always copied to workspace.
 * This keeps datasets/ as pristine reference material.
 */
export async function prepareWorkspace(
  codebaseId: string,
  codebasePath: string,
  conditionId: string,
  skillVersion: string | null,
  skillSrcPath: string | null,
): Promise<string> {
  const key = workspaceKey(codebaseId, conditionId);
  if (preparedWorkspaces.has(key)) {
    return preparedWorkspaces.get(key)!;
  }

  const src = path.resolve(ROOT, codebasePath);
  if (!fs.existsSync(src)) {
    throw new Error(`Codebase not found: ${src}`);
  }

  const wsDir = workspaceDir(codebaseId, conditionId);

  // Copy entire codebase to workspace (real files, no symlinks)
  const wsRoot = path.join(ROOT, 'workspaces');
  fs.mkdirSync(wsRoot, { recursive: true });
  await execSimple(`rm -rf "${wsDir}" && cp -R "${src}" "${wsDir}"`);

  // Install skill if this is a skill run
  if (skillVersion && skillSrcPath) {
    const commandsDir = path.join(wsDir, '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    const skillDest = path.join(commandsDir, 'solidity-auditor');
    await execSimple(`cp -R "${skillSrcPath}" "${skillDest}"`);

    verifySkillVersion(wsDir, skillVersion);
    log.info(`Workspace: ${codebaseId}/${conditionId} (copied + skill ${skillVersion} installed)`);
  } else {
    log.info(`Workspace: ${codebaseId}/${conditionId} (copied, no skill)`);
  }

  preparedWorkspaces.set(key, wsDir);
  return wsDir;
}

/**
 * Verifies that the skill installed in the workspace matches the expected version.
 * Throws if mismatched — never run with the wrong skill.
 */
function verifySkillVersion(wsDir: string, expectedVersion: string): void {
  const versionFile = path.join(wsDir, '.claude', 'commands', 'solidity-auditor', 'VERSION');
  if (!fs.existsSync(versionFile)) {
    throw new Error(
      `Skill verification failed: no VERSION file at ${versionFile}. ` +
      `Ensure skills_versions/${expectedVersion}/solidity-auditor/VERSION exists.`
    );
  }
  const installed = fs.readFileSync(versionFile, 'utf8').trim();
  // VERSION file may contain "1" or "v1" — normalize both to compare
  const normalize = (v: string) => v.replace(/^v/, '');
  if (normalize(installed) !== normalize(expectedVersion)) {
    throw new Error(
      `Skill version mismatch in workspace ${wsDir}: ` +
      `expected "${expectedVersion}", got "${installed}". ` +
      `This usually means Claude would resolve to the wrong .claude/commands/.`
    );
  }
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
