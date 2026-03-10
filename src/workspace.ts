import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSimple } from './util/shell.js';
import * as log from './util/logger.js';

const ROOT = process.cwd();

export function workspacePath(runId: string): string {
  return path.join(ROOT, 'workspaces', runId);
}

export function codePath(runId: string): string {
  return path.join(workspacePath(runId), 'code');
}

export async function createWorkspace(runId: string, codebasePath: string): Promise<string> {
  const src = path.resolve(ROOT, codebasePath);
  if (!fs.existsSync(src)) {
    throw new Error(`Codebase not found: ${src}`);
  }

  const dest = codePath(runId);
  fs.mkdirSync(dest, { recursive: true });

  // Copy codebase into workspace. Use rsync for efficiency, fallback to cp.
  try {
    await execSimple(`rsync -a --exclude='.git' "${src}/" "${dest}/"`);
  } catch {
    await execSimple(`cp -R "${src}/." "${dest}/"`);
  }

  log.info(`Workspace created: workspaces/${runId}/code`);
  return dest;
}

export async function resolveGitCommit(dirPath: string): Promise<string | undefined> {
  const abs = path.resolve(ROOT, dirPath);
  try {
    return await execSimple('git rev-parse HEAD', abs);
  } catch {
    return undefined;
  }
}
