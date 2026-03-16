import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BenchConfig, CliOptions, CodebaseConfig, ConditionConfig, RunMeta } from '../shared/types.js';
import { getRunCwd, prepareWorkspace, resolveGitCommit, cleanupWorkspaces, resetWorkspaceCache } from './workspace.js';
import { skillSrcPath, resolveSkillGitCommit } from './skill.js';
import { spawnClaude } from '../shared/util/shell.js';
import { verifyRun, printVerifyResults, type VerifyResult } from './verify.js';
import * as log from '../shared/util/logger.js';

const ROOT = process.cwd();

function makeRunId(codebaseId: string, conditionId: string, iteration: number): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${ts}_${codebaseId}_${conditionId}_run${iteration}`;
}

function ensureResultsDir(): void {
  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
}

function extractModelFromEvents(runId: string): string | undefined {
  const eventsPath = path.join(ROOT, 'results', `${runId}.events.jsonl`);
  if (!fs.existsSync(eventsPath)) return undefined;
  try {
    const lines = fs.readFileSync(eventsPath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line);
      if (evt.type === 'assistant' && evt.message?.model) {
        return evt.message.model as string;
      }
    }
  } catch { /* ignore parse errors */ }
  return undefined;
}

async function getClaudeVersion(): Promise<string | undefined> {
  try {
    const { execSimple } = await import('../shared/util/shell.js');
    return await execSimple('claude --version');
  } catch {
    return undefined;
  }
}

async function runSingle(
  codebase: CodebaseConfig,
  condition: ConditionConfig,
  iteration: number,
  opts: CliOptions,
): Promise<RunMeta> {
  const runId = makeRunId(codebase.id, condition.id, iteration);
  log.separator();
  log.info(`Run: ${runId}`);

  // Resolve the cwd for this run
  const cwd = opts.dryRun
    ? `/workspaces/${codebase.id}__${condition.id}`
    : getRunCwd(codebase.id, condition.id);

  // Build the prompt
  let prompt: string;
  if (condition.type === 'bare') {
    prompt = condition.prompt;
  } else {
    prompt = condition.command;
    if (condition.fileOutput) {
      prompt += ' --file-output';
    }
  }

  // Spawn claude
  const outputPath = path.join(ROOT, 'results', `${runId}.stdout.txt`);
  const { exitCode, durationMs, timedOut } = await spawnClaude({
    cwd,
    prompt,
    model: opts.model,
    outputPath,
    dryRun: opts.dryRun,
    bare: condition.type === 'bare',
    label: condition.id,
  });

  // Build metadata
  const codebaseGitCommit = codebase.gitCommit ?? await resolveGitCommit(codebase.path);
  const skillGitCommit = condition.type === 'skill'
    ? await resolveSkillGitCommit(condition.skillVersion)
    : undefined;
  const claudeCliVersion = await getClaudeVersion();

  const meta: RunMeta = {
    runId,
    codebaseId: codebase.id,
    conditionId: condition.id,
    iteration,
    timestampUtc: new Date().toISOString(),
    codebaseGitCommit,
    skillVersion: condition.type === 'skill' ? condition.skillVersion : undefined,
    skillGitCommit,
    mode: condition.type,
    deep: condition.type === 'skill' ? condition.deep : undefined,
    fileOutput: condition.type === 'skill' ? condition.fileOutput : undefined,
    claudeModel: opts.model ?? extractModelFromEvents(runId),
    claudeCliVersion,
    exitCode,
    durationMs,
    timedOut,
  };

  // Write metadata (skip for dry runs — no real output to pair with)
  if (!opts.dryRun) {
    const metaPath = path.join(ROOT, 'results', `${runId}.meta.json`);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  if (timedOut) {
    log.error(`TIMED OUT after ${(durationMs / 1000).toFixed(1)}s`);
  } else if (exitCode === 0) {
    log.success(`Completed in ${(durationMs / 1000).toFixed(1)}s → results/${runId}.stdout.txt`);
  } else {
    log.error(`Exit code ${exitCode} after ${(durationMs / 1000).toFixed(1)}s`);
  }

  return meta;
}

export async function runBench(config: BenchConfig, opts: CliOptions): Promise<RunMeta[]> {
  ensureResultsDir();

  const codebases = opts.codebaseFilter
    ? config.codebases.filter(c => opts.codebaseFilter!.includes(c.id))
    : config.codebases;

  const conditions = opts.conditionFilter
    ? config.conditions.filter(c => opts.conditionFilter!.includes(c.id))
    : config.conditions;

  if (codebases.length === 0) throw new Error('No codebases matched filter');
  if (conditions.length === 0) throw new Error('No conditions matched filter');

  const runs = opts.runsOverride ?? config.defaultRunsPerCondition;
  const total = codebases.length * conditions.length * runs;

  // Prepare fresh workspaces for all (codebase, condition) pairs.
  // Called before each iteration to ensure clean state — no leftover
  // files from a previous run can leak into the next.
  async function prepareAllWorkspaces(): Promise<void> {
    if (opts.dryRun) return;
    resetWorkspaceCache();
    for (const codebase of codebases) {
      for (const condition of conditions) {
        const skillVersion = condition.type === 'skill' ? condition.skillVersion : null;
        const skillSrc = skillVersion ? skillSrcPath(skillVersion) : null;
        await prepareWorkspace(
          codebase.id, codebase.path, condition.id, skillVersion, skillSrc,
        );
      }
    }
  }

  log.info(
    `Benchmark: ${codebases.length} codebases × ${conditions.length} conditions × ${runs} runs = ${total} total`
  );

  const results: RunMeta[] = [];

  if (opts.parallel && (conditions.length > 1 || codebases.length > 1)) {
    log.info(`Parallel mode: ${codebases.length} codebase(s) × ${conditions.length} conditions concurrently per iteration`);

    for (let i = 1; i <= runs; i++) {
      await prepareAllWorkspaces();
      log.separator();
      log.info(`[PARALLEL] Starting iteration ${i} — ${codebases.length * conditions.length} runs`);
      let completed = 0;
      const totalParallel = codebases.length * conditions.length;

      const promises: Promise<RunMeta>[] = [];
      for (const codebase of codebases) {
        for (const condition of conditions) {
          promises.push(
            runSingle(codebase, condition, i, opts).then(meta => {
              completed++;
              log.info(`[PARALLEL] ${codebase.id}/${condition.id} done (${completed}/${totalParallel})`);
              return meta;
            })
          );
        }
      }

      const iterResults = await Promise.all(promises);
      results.push(...iterResults);
    }
  } else {
    for (const codebase of codebases) {
      for (const condition of conditions) {
        for (let i = 1; i <= runs; i++) {
          await prepareAllWorkspaces();
          const meta = await runSingle(codebase, condition, i, opts);
          results.push(meta);
        }
      }
    }
  }

  // Cleanup workspaces after all runs
  if (!opts.dryRun) {
    cleanupWorkspaces();
  }

  log.separator();
  const passed = results.filter(r => r.exitCode === 0).length;
  log.info(`Done: ${passed}/${total} runs succeeded`);

  // Post-run verification (skip for dry runs)
  if (!opts.dryRun) {
    // Build codebase path lookup for scope checking
    const codebasePathMap = new Map<string, string>();
    for (const cb of codebases) {
      codebasePathMap.set(cb.id, cb.path);
    }

    const verifyResults: VerifyResult[] = results.map(meta =>
      verifyRun(meta, path.join(ROOT, 'results'), codebasePathMap.get(meta.codebaseId))
    );
    printVerifyResults(verifyResults);
  }

  return results;
}
