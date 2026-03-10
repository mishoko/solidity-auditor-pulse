import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as log from './logger.js';

export interface SpawnClaudeOptions {
  cwd: string;
  prompt: string;
  model?: string;
  outputPath: string;
  dryRun?: boolean;
  /** When true, isolate claude from ALL user config (commands, memory, settings) */
  bare?: boolean;
}

export async function spawnClaude(opts: SpawnClaudeOptions): Promise<{ exitCode: number; durationMs: number }> {
  if (opts.dryRun) {
    const mode = opts.bare ? ' [BARE]' : '';
    log.dry(`cd ${opts.cwd} && claude -p "${opts.prompt.slice(0, 80)}..."${mode}`);
    return { exitCode: 0, durationMs: 0 };
  }

  const args = ['-p', opts.prompt, '--dangerously-skip-permissions'];
  if (opts.model) {
    args.push('--model', opts.model);
  }

  // Strip CLAUDE_CODE* and CLAUDECODE env vars to prevent spawned process
  // from hanging or erroring when launched from within Claude Code.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !key.startsWith('CLAUDE_CODE') && key !== 'CLAUDECODE'
    )
  );

  if (opts.bare) {
    // Disable all skills/commands so bare Claude can't invoke the auditor skill.
    // Also skip user-level settings (memory, CLAUDE.md, custom settings).
    args.push('--disable-slash-commands');
    args.push('--setting-sources', 'project,local');
    log.info('Bare mode: slash commands disabled, user settings skipped');
  }

  const start = Date.now();
  const outStream = fs.createWriteStream(opts.outputPath, { encoding: 'utf8' });

  const child = spawn('claude', args, {
    cwd: opts.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.pipe(outStream);

  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(`[claude stderr] ${chunk.toString()}`);
  });

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      outStream.end();
      resolve({ exitCode: code ?? -1, durationMs: Date.now() - start });
    });
  });
}

export async function execSimple(cmd: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Command failed (${code}): ${cmd}`));
      else resolve(out.trim());
    });
  });
}
