/**
 * Post-run verification: parses .events.jsonl (stream-json) to verify
 * that each run completed correctly — agents spawned, tools succeeded, etc.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunMeta } from './types.js';
import * as log from './util/logger.js';

export interface VerifyResult {
  runId: string;
  conditionId: string;
  passed: boolean;
  checks: Record<string, { ok: boolean; detail: string }>;
}

interface StreamEvent {
  type: string;
  subtype?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string;       // tool_use name
      input?: unknown;     // tool_use input
      tool_use_id?: string;
      content?: unknown;   // tool_result content
    }>;
  };
  result?: string;
  stop_reason?: string;
  num_turns?: number;
  duration_ms?: number;
  is_error?: boolean;
  slash_commands?: string[];
  tools?: string[];
}

function parseEvents(eventsPath: string): StreamEvent[] {
  if (!fs.existsSync(eventsPath)) return [];
  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
  const events: StreamEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch { /* skip */ }
  }
  return events;
}

export function verifyRun(meta: RunMeta, resultsDir: string): VerifyResult {
  const checks: VerifyResult['checks'] = {};
  const eventsPath = path.join(resultsDir, `${meta.runId}.events.jsonl`);
  const events = parseEvents(eventsPath);

  // Check if the result event exists (work completed even if process was killed)
  const resultEvent = events.find(e => e.type === 'result');
  const workCompleted = !!resultEvent;

  // Check 1: Exit code (143 = SIGTERM from grace kill is OK if result was received)
  const exitOk = meta.exitCode === 0 || (meta.exitCode === 143 && workCompleted);
  checks['exit_code'] = {
    ok: exitOk,
    detail: meta.exitCode === 143 && workCompleted
      ? `exit code 143 (grace-killed after completion — OK)`
      : `exit code ${meta.exitCode}`,
  };

  // Check 2: Not timed out (grace kills after result are NOT timeouts)
  const realTimeout = meta.timedOut && !workCompleted;
  checks['not_timed_out'] = {
    ok: !realTimeout,
    detail: realTimeout
      ? `timed out after ${(meta.durationMs / 1000).toFixed(0)}s (work NOT completed)`
      : meta.timedOut
        ? `grace-killed at ${(meta.durationMs / 1000).toFixed(0)}s (work was completed)`
        : 'completed in time',
  };

  // Check 3: Has events (stream-json captured)
  checks['has_events'] = {
    ok: events.length > 0,
    detail: `${events.length} events captured`,
  };

  // Check 4: Has result event
  checks['has_result'] = {
    ok: !!resultEvent,
    detail: resultEvent ? `stop_reason: ${resultEvent.stop_reason}` : 'no result event',
  };

  // Check 5: Stop reason is end_turn (not error/timeout)
  if (resultEvent) {
    checks['stop_reason'] = {
      ok: resultEvent.stop_reason === 'end_turn',
      detail: `${resultEvent.stop_reason}`,
    };
  }

  // Check 6: Count Agent tool calls and results
  const agentCalls: string[] = [];
  const agentResults: string[] = [];
  for (const event of events) {
    if (event.type !== 'assistant' || !event.message?.content) continue;
    for (const block of event.message.content) {
      if (block.type === 'tool_use' && block.name === 'Agent') {
        agentCalls.push(block.tool_use_id ?? 'unknown');
      }
      if (block.type === 'tool_result' && block.tool_use_id) {
        agentResults.push(block.tool_use_id);
      }
    }
  }

  if (meta.mode === 'skill') {
    // Skill runs should spawn agents
    const expectedMin = meta.conditionId.includes('v2') ? 5 : 4;
    checks['agents_spawned'] = {
      ok: agentCalls.length >= expectedMin,
      detail: `${agentCalls.length} agents spawned (expected ≥${expectedMin})`,
    };
  } else {
    // Bare runs should NOT spawn agents via Skill tool
    const skillCalls = events.filter(e =>
      e.type === 'assistant' && e.message?.content?.some(
        (b: { type: string; name?: string }) => b.type === 'tool_use' && b.name === 'Skill'
      )
    );
    checks['no_skill_calls'] = {
      ok: skillCalls.length === 0,
      detail: skillCalls.length === 0 ? 'no Skill tool calls' : `${skillCalls.length} Skill calls detected!`,
    };
  }

  // Check 7: Init event shows correct configuration
  const initEvent = events.find(e => e.type === 'system' && e.subtype === 'init') as StreamEvent & {
    slash_commands?: string[];
    tools?: string[];
  } | undefined;
  if (initEvent && meta.mode === 'bare') {
    const hasSkillCommand = (initEvent.slash_commands ?? []).includes('solidity-auditor');
    checks['bare_no_skill_visible'] = {
      ok: !hasSkillCommand,
      detail: hasSkillCommand ? 'solidity-auditor visible in bare run!' : 'skill correctly hidden',
    };
  }

  const passed = Object.values(checks).every(c => c.ok);

  return { runId: meta.runId, conditionId: meta.conditionId, passed, checks };
}

export function printVerifyResults(results: VerifyResult[]): void {
  log.separator();
  log.info('Run Verification Results');
  log.separator();

  for (const r of results) {
    const status = r.passed ? '✓ PASS' : '✗ FAIL';
    log.info(`${status} ${r.conditionId} (${r.runId})`);
    for (const [name, check] of Object.entries(r.checks)) {
      const icon = check.ok ? '  ✓' : '  ✗';
      log.info(`${icon} ${name}: ${check.detail}`);
    }
  }

  const allPassed = results.every(r => r.passed);
  log.separator();
  if (allPassed) {
    log.success(`All ${results.length} runs verified successfully`);
  } else {
    const failed = results.filter(r => !r.passed).length;
    log.error(`${failed}/${results.length} runs failed verification`);
  }
}
