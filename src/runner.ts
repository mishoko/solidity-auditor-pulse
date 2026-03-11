import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BenchConfig, CliOptions, CodebaseConfig, ConditionConfig, RunMeta } from './types.js';
import { getRunCwd, prepareSkillWorkspace, resolveGitCommit, cleanupWorkspaces } from './workspace.js';
import { skillSrcPath, resolveSkillGitCommit } from './skill.js';
import { spawnClaude } from './util/shell.js';
import * as log from './util/logger.js';

const ROOT = process.cwd();

function makeRunId(codebaseId: string, conditionId: string, iteration: number): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${ts}_${codebaseId}_${conditionId}_run${iteration}`;
}

function ensureResultsDir(): void {
  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
}

async function getClaudeVersion(): Promise<string | undefined> {
  try {
    const { execSimple } = await import('./util/shell.js');
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
  const skillVersion = condition.type === 'skill' ? condition.skillVersion : null;
  const cwd = opts.dryRun
    ? `/workspaces/${codebase.id}_${skillVersion ?? 'bare'}/code`
    : getRunCwd(codebase.id, codebase.path, skillVersion);

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
  const { exitCode, durationMs } = await spawnClaude({
    cwd,
    prompt,
    model: opts.model,
    outputPath,
    dryRun: opts.dryRun,
    bare: condition.type === 'bare',
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
    claudeModel: opts.model,
    claudeCliVersion,
    exitCode,
    durationMs,
  };

  // Write metadata (skip for dry runs — no real output to pair with)
  if (!opts.dryRun) {
    const metaPath = path.join(ROOT, 'results', `${runId}.meta.json`);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  if (exitCode === 0) {
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

  // Prepare all skill workspaces upfront (one per codebase × skillVersion)
  if (!opts.dryRun) {
    const skillVersions = new Set(
      conditions
        .filter((c): c is Extract<ConditionConfig, { type: 'skill' }> => c.type === 'skill')
        .map(c => c.skillVersion)
    );

    for (const codebase of codebases) {
      for (const sv of skillVersions) {
        const src = skillSrcPath(sv);
        await prepareSkillWorkspace(codebase.id, codebase.path, sv, src);
      }
    }
  }

  const bareCount = conditions.filter(c => c.type === 'bare').length * codebases.length * runs;
  const skillCount = total - bareCount;
  log.info(
    `Benchmark: ${codebases.length} codebases × ${conditions.length} conditions × ${runs} runs = ${total} total`
  );
  log.info(
    `Workspaces: ${bareCount > 0 ? `${bareCount} bare (no copy)` : ''}` +
    `${bareCount > 0 && skillCount > 0 ? ' + ' : ''}` +
    `${skillCount > 0 ? `${skillCount} skill (shared symlinked workspaces)` : ''}`
  );

  const results: RunMeta[] = [];

  if (opts.parallel && conditions.length > 1) {
    log.info(`Parallel mode: ${conditions.length} conditions will run concurrently per iteration`);

    for (const codebase of codebases) {
      for (let i = 1; i <= runs; i++) {
        log.separator();
        log.info(`[PARALLEL] Starting iteration ${i} for ${codebase.id} — ${conditions.length} conditions`);
        let completed = 0;

        const promises = conditions.map(async (condition) => {
          const meta = await runSingle(codebase, condition, i, opts);
          completed++;
          log.info(`[PARALLEL] ${condition.id} done (${completed}/${conditions.length})`);
          return meta;
        });

        const iterResults = await Promise.all(promises);
        results.push(...iterResults);
      }
    }
  } else {
    for (const codebase of codebases) {
      for (const condition of conditions) {
        for (let i = 1; i <= runs; i++) {
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

  return results;
}
