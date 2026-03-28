/**
 * Post-run verification: parses .events.jsonl (stream-json) to verify
 * that each run completed correctly — agents spawned, tools succeeded,
 * scope respected, bundles valid, etc.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunMeta } from '../shared/types.js';
import * as log from '../shared/util/logger.js';

const ROOT = process.cwd();

export interface VerifyResult {
  runId: string;
  conditionId: string;
  passed: boolean;
  checks: Record<string, { ok: boolean; detail: string }>;
  warnings: string[];
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface StreamEvent {
  type: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: {
    content?: ContentBlock[];
  };
  result?: string;
  stop_reason?: string;
  num_turns?: number;
  duration_ms?: number;
  is_error?: boolean;
  total_cost_usd?: number;
  slash_commands?: string[];
  tools?: string[];
  model?: string;
}

// ─── Scope file parsing ───

interface ScopeInfo {
  inScope: string[];      // normalized file paths from scope.txt
  outOfScope: string[];   // normalized file paths from out_of_scope.txt
  /** Contract names extracted from out_of_scope.txt for grep-style checking */
  outOfScopeContractNames: string[];
}

function loadScopeInfo(codebasePath: string): ScopeInfo | null {
  const datasetDir = path.resolve(ROOT, codebasePath);
  const scopeFile = path.join(datasetDir, 'scope.txt');

  if (!fs.existsSync(scopeFile)) return null;

  const normalize = (lines: string[]) =>
    lines.map(l => l.trim()).filter(Boolean).map(l => l.replace(/^\.\//, ''));

  const inScope = normalize(fs.readFileSync(scopeFile, 'utf8').split('\n'));

  let outOfScope: string[] = [];
  const outFile = path.join(datasetDir, 'out_of_scope.txt');
  if (fs.existsSync(outFile)) {
    outOfScope = normalize(fs.readFileSync(outFile, 'utf8').split('\n'));
  }

  // Extract contract names from out-of-scope file paths for grep checking
  // e.g. "./contracts/mock/MockToken.sol" → "MockToken"
  // Skip generic names that would false-positive in audit text (e.g. "Errors", "Utils", "Base")
  const GENERIC_NAMES = new Set([
    'Errors', 'Utils', 'Base', 'Common', 'Constants', 'Types', 'Events',
    'Helpers', 'Math', 'SafeMath', 'Context', 'Storage', 'Proxy', 'Test',
  ]);
  const outOfScopeContractNames = outOfScope
    .filter(f => f.endsWith('.sol'))
    .map(f => {
      const basename = f.split('/').pop()!.replace('.sol', '');
      return basename;
    })
    .filter(name => name.length > 4 && !GENERIC_NAMES.has(name));

  return { inScope, outOfScope, outOfScopeContractNames };
}

// ─── Event parsing ───

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

// ─── Agent tracking ───

interface AgentInfo {
  toolUseId: string;
  description: string;
  model: string;
  returned: boolean;
  returnedError: boolean;
  returnLineCount: number;
}

function trackAgents(events: StreamEvent[]): AgentInfo[] {
  const agents: AgentInfo[] = [];
  const agentMap = new Map<string, AgentInfo>();

  for (const event of events) {
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && block.name === 'Agent') {
          const id = block.id ?? 'unknown';
          const input = block.input ?? {};
          const info: AgentInfo = {
            toolUseId: id,
            description: (input.description as string) ?? '',
            model: (input.model as string) ?? 'default',
            returned: false,
            returnedError: false,
            returnLineCount: 0,
          };
          agents.push(info);
          agentMap.set(id, info);
        }
      }
    }

    // Match tool_results to agent spawns
    if (event.type === 'user' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const agent = agentMap.get(block.tool_use_id);
          if (agent) {
            agent.returned = true;
            agent.returnedError = !!block.is_error;

            // Count lines in agent response
            let text = '';
            if (typeof block.content === 'string') {
              text = block.content;
            } else if (Array.isArray(block.content)) {
              text = (block.content as ContentBlock[])
                .filter(c => c.type === 'text')
                .map(c => c.text ?? '')
                .join('\n');
            }
            agent.returnLineCount = text.split('\n').length;
          }
        }
      }
    }
  }

  return agents;
}

// ─── Tool error tracking ───

interface ToolError {
  toolName: string;
  errorText: string;
}

function collectToolErrors(events: StreamEvent[]): ToolError[] {
  const errors: ToolError[] = [];

  // Build map of tool_use_id → tool name
  const toolNames = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && block.id && block.name) {
          toolNames.set(block.id, block.name);
        }
      }
    }
  }

  // Find error results
  for (const event of events) {
    if (event.type !== 'user' || !event.message?.content) continue;
    for (const block of event.message.content) {
      if (block.type === 'tool_result' && block.is_error) {
        const toolName = block.tool_use_id ? (toolNames.get(block.tool_use_id) ?? 'unknown') : 'unknown';
        let errText = '';
        if (typeof block.content === 'string') errText = block.content;
        else if (Array.isArray(block.content)) {
          errText = (block.content as ContentBlock[])
            .map(c => c.text ?? '')
            .join(' ');
        }
        errors.push({ toolName, errorText: errText.slice(0, 200) });
      }
    }
  }

  return errors;
}

// ─── Bundle quality ───

interface BundleInfo {
  name: string;
  lineCount: number;
}

function checkBundleQuality(events: StreamEvent[]): BundleInfo[] {
  const bundles: BundleInfo[] = [];

  // Look for Bash tool results that contain bundle line count info
  for (const event of events) {
    if (event.type !== 'user' || !event.message?.content) continue;
    for (const block of event.message.content) {
      if (block.type !== 'tool_result') continue;
      let text = '';
      if (typeof block.content === 'string') text = block.content;
      else if (Array.isArray(block.content)) {
        text = (block.content as ContentBlock[])
          .map(c => c.text ?? '')
          .join('\n');
      }

      // Parse lines like "audit-skill_v2-agent-1-bundle.md:     1567 lines"
      // or "Agent 1 bundle:      398 lines"
      const lineMatches = text.matchAll(/(?:agent[- ]?(\d+)[- ]?bundle[^:]*:\s*(\d+)\s*lines)|(?:audit-\S+-agent-(\d+)-bundle\.md:\s*(\d+)\s*lines)/gi);
      for (const m of lineMatches) {
        const agentNum = m[1] ?? m[3] ?? '?';
        const lines = parseInt(m[2] ?? m[4] ?? '0', 10);
        bundles.push({ name: `agent-${agentNum}-bundle`, lineCount: lines });
      }
    }
  }

  return bundles;
}

// ─── Scope compliance ───

interface ScopeCheck {
  /** .sol files read via Read tool, relative to workspace */
  solFilesRead: string[];
  /** Out-of-scope contract names found in stdout text */
  outOfScopeInFindings: string[];
}

function checkScopeCompliance(
  events: StreamEvent[],
  stdoutPath: string,
  scope: ScopeInfo,
  conditionId: string,
): ScopeCheck {
  // 1. Collect all .sol files read via Read tool
  const solFilesRead: string[] = [];
  for (const event of events) {
    if (event.type !== 'assistant' || !event.message?.content) continue;
    for (const block of event.message.content) {
      if (block.type === 'tool_use' && block.name === 'Read') {
        const fp = (block.input?.file_path as string) ?? '';
        if (fp.endsWith('.sol')) {
          // Normalize: strip workspace prefix to get relative path
          // e.g. /Users/.../workspaces/merkl__bare_audit/contracts/Foo.sol → contracts/Foo.sol
          const wsMarker = `${conditionId}/`;
          const wsIdx = fp.indexOf(wsMarker);
          const relative = wsIdx >= 0 ? fp.slice(wsIdx + wsMarker.length) : fp.split('/').slice(-2).join('/');
          solFilesRead.push(relative);
        }
      }
    }
  }

  // 2. Check stdout for out-of-scope contract name mentions in findings
  const outOfScopeInFindings: string[] = [];
  if (scope.outOfScopeContractNames.length > 0 && fs.existsSync(stdoutPath)) {
    const stdout = fs.readFileSync(stdoutPath, 'utf8');
    for (const name of scope.outOfScopeContractNames) {
      // Match contract name as a word boundary (not as part of variable name like "accessControlManager")
      // Look for patterns like: "in ContractName", "ContractName.sol", "contract ContractName"
      const patterns = [
        new RegExp(`\\b${name}\\.sol\\b`, 'gi'),
        new RegExp(`\\bcontract\\s+${name}\\b`, 'gi'),
        new RegExp(`\\bfinding.*\\b${name}\\b`, 'gi'),
      ];
      for (const regex of patterns) {
        if (regex.test(stdout)) {
          outOfScopeInFindings.push(name);
          break;
        }
      }
    }
  }

  return {
    solFilesRead: [...new Set(solFilesRead)],
    outOfScopeInFindings: [...new Set(outOfScopeInFindings)],
  };
}

// ─── Session tracking ───

function countInitEvents(events: StreamEvent[]): number {
  return events.filter(e => e.type === 'system' && e.subtype === 'init').length;
}

// ─── Main verify ───

export function verifyRun(
  meta: RunMeta,
  resultsDir: string,
  codebasePath?: string,
): VerifyResult {
  const checks: VerifyResult['checks'] = {};
  const warnings: string[] = [];
  const eventsPath = path.join(resultsDir, `${meta.runId}.events.jsonl`);
  const stdoutPath = path.join(resultsDir, `${meta.runId}.stdout.txt`);
  const events = parseEvents(eventsPath);

  // Check if the result event exists (work completed even if process was killed)
  const resultEvent = events.find(e => e.type === 'result');
  const workCompleted = !!resultEvent;

  // ── Check 1: Exit code ──
  const exitOk = meta.exitCode === 0 || (meta.exitCode === 143 && workCompleted);
  checks['exit_code'] = {
    ok: exitOk,
    detail: meta.exitCode === 143 && workCompleted
      ? `exit code 143 (grace-killed after completion — OK)`
      : `exit code ${meta.exitCode}`,
  };

  // ── Check 2: Not timed out ──
  const realTimeout = meta.timedOut && !workCompleted;
  checks['not_timed_out'] = {
    ok: !realTimeout,
    detail: realTimeout
      ? `timed out after ${(meta.durationMs / 1000).toFixed(0)}s (work NOT completed)`
      : meta.timedOut
        ? `grace-killed at ${(meta.durationMs / 1000).toFixed(0)}s (work was completed)`
        : 'completed in time',
  };

  // ── Check 3: Has events ──
  checks['has_events'] = {
    ok: events.length > 0,
    detail: `${events.length} events captured`,
  };

  // ── Check 4: Has result event ──
  checks['has_result'] = {
    ok: !!resultEvent,
    detail: resultEvent ? `stop_reason: ${resultEvent.stop_reason}` : 'no result event',
  };

  // ── Check 5: Stop reason ──
  if (resultEvent) {
    checks['stop_reason'] = {
      ok: resultEvent.stop_reason === 'end_turn',
      detail: `${resultEvent.stop_reason}`,
    };
  }

  // ── Check 6: Agent spawn + return tracking (skill runs) ──
  const agents = trackAgents(events);

  if (meta.mode === 'skill') {
    const expectedMin = meta.expectedMinAgents ?? 4;

    // 6a: Spawn count
    checks['agents_spawned'] = {
      ok: agents.length >= expectedMin,
      detail: `${agents.length} agents spawned (expected ≥${expectedMin})`,
    };

    // 6b: All agents returned
    const returned = agents.filter(a => a.returned);
    const missing = agents.filter(a => !a.returned);
    checks['agents_all_returned'] = {
      ok: returned.length === agents.length,
      detail: returned.length === agents.length
        ? `${returned.length}/${agents.length} agents returned`
        : `${returned.length}/${agents.length} returned — MISSING: ${missing.map(a => a.description).join(', ')}`,
    };

    // 6c: No agent returned an error
    const errorAgents = agents.filter(a => a.returnedError);
    checks['agents_no_errors'] = {
      ok: errorAgents.length === 0,
      detail: errorAgents.length === 0
        ? 'no agent errors'
        : `${errorAgents.length} agent(s) returned errors: ${errorAgents.map(a => a.description).join(', ')}`,
    };

    // 6d: Agent result quality — each returned meaningful content
    const MIN_AGENT_LINES = 10;
    const thinAgents = agents.filter(a => a.returned && !a.returnedError && a.returnLineCount < MIN_AGENT_LINES);
    checks['agents_result_quality'] = {
      ok: thinAgents.length === 0,
      detail: thinAgents.length === 0
        ? `all agents returned ≥${MIN_AGENT_LINES} lines`
        : `${thinAgents.length} agent(s) returned <${MIN_AGENT_LINES} lines: ${thinAgents.map(a => `"${a.description}" (${a.returnLineCount}L)`).join(', ')}`,
    };
  } else {
    // Bare runs: no Skill tool calls
    const skillCalls = events.filter(e =>
      e.type === 'assistant' && e.message?.content?.some(
        (b) => b.type === 'tool_use' && b.name === 'Skill'
      )
    );
    checks['no_skill_calls'] = {
      ok: skillCalls.length === 0,
      detail: skillCalls.length === 0 ? 'no Skill tool calls' : `${skillCalls.length} Skill calls detected!`,
    };
  }

  // ── Check 7: Init event config (bare runs) ──
  const initEvent = events.find(e => e.type === 'system' && e.subtype === 'init');
  if (initEvent && meta.mode === 'bare') {
    const slashCommands: string[] = initEvent.slash_commands ?? [];
    const leakedSkill = slashCommands.find(cmd => cmd !== 'help' && cmd !== 'clear');
    checks['bare_no_skill_visible'] = {
      ok: !leakedSkill,
      detail: leakedSkill ? `${leakedSkill} visible in bare run!` : 'skill correctly hidden',
    };
  }

  // ── Check 8: Tool errors ──
  const toolErrors = collectToolErrors(events);
  // Tool errors are warnings, not hard fails — agents often recover from them
  if (toolErrors.length > 0) {
    const grouped = new Map<string, number>();
    for (const e of toolErrors) {
      const key = e.toolName;
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    const summary = [...grouped.entries()].map(([k, v]) => `${k}:${v}`).join(', ');
    warnings.push(`${toolErrors.length} tool error(s): ${summary}`);

    // Log individual errors for investigation
    for (const e of toolErrors) {
      warnings.push(`  ⚠ ${e.toolName}: ${e.errorText.slice(0, 120)}`);
    }
  }

  // ── Check 9: Bundle quality (skill runs) ──
  // Empty bundles are a skill bug but not a verification failure if the skill recovered.
  // We check this as a warning + report the bundle details.
  if (meta.mode === 'skill') {
    const bundles = checkBundleQuality(events);
    if (bundles.length > 0) {
      const zeroBundles = bundles.filter(b => b.lineCount === 0);
      // Get the final set of bundles (last occurrence per agent number, reflecting retries)
      const finalBundles = new Map<string, BundleInfo>();
      for (const b of bundles) {
        finalBundles.set(b.name, b);
      }
      const finalZero = [...finalBundles.values()].filter(b => b.lineCount === 0);

      if (zeroBundles.length > 0 && finalZero.length === 0) {
        // Had empty bundles but skill retried and fixed them
        warnings.push(`Bundle retry detected: ${zeroBundles.map(b => b.name).join(', ')} were initially empty, skill recreated them`);
      }
      checks['bundle_quality'] = {
        ok: finalZero.length === 0,
        detail: finalZero.length === 0
          ? `${finalBundles.size} bundles OK (${[...finalBundles.values()].map(b => `${b.name}:${b.lineCount}L`).join(', ')})`
          : `${finalZero.length} bundle(s) still empty after retries: ${finalZero.map(b => b.name).join(', ')}`,
      };
    }
  }

  // ── Check 10: Scope compliance ──
  if (codebasePath) {
    const scope = loadScopeInfo(codebasePath);
    if (scope) {
      const scopeCheck = checkScopeCompliance(events, stdoutPath, scope, meta.conditionId);

      // 10a: No findings about out-of-scope contracts
      checks['scope_no_oos_findings'] = {
        ok: scopeCheck.outOfScopeInFindings.length === 0,
        detail: scopeCheck.outOfScopeInFindings.length === 0
          ? 'no out-of-scope contracts in findings'
          : `OUT-OF-SCOPE contracts in findings: ${scopeCheck.outOfScopeInFindings.join(', ')}`,
      };

      // 10b: Verify files read are reasonable (in-scope + dependencies)
      // Dependencies (interfaces, structs, utils) are OK to read for context
      const solFilesRead = scopeCheck.solFilesRead;
      const inScopeSet = new Set(scope.inScope);
      const outOfScopeSet = new Set(scope.outOfScope);
      const outOfScopeFilesRead = solFilesRead.filter(f => outOfScopeSet.has(f));

      if (outOfScopeFilesRead.length > 0) {
        // Bare runs may read dependency files for context — warn but don't fail
        // Skill runs should be tighter
        if (meta.mode === 'skill') {
          warnings.push(`Skill read ${outOfScopeFilesRead.length} out-of-scope file(s): ${outOfScopeFilesRead.join(', ')}`);
        } else {
          warnings.push(`Bare read ${outOfScopeFilesRead.length} out-of-scope file(s) for context: ${outOfScopeFilesRead.join(', ')}`);
        }
      }

      const inScopeFilesRead = solFilesRead.filter(f => inScopeSet.has(f));
      checks['scope_in_scope_read'] = {
        ok: inScopeFilesRead.length > 0,
        detail: `${inScopeFilesRead.length}/${scope.inScope.length} in-scope files read, ${solFilesRead.length} total .sol files read`,
      };
    }
  }

  // ── Check 11: No duplicate sessions ──
  const initCount = countInitEvents(events);
  if (initCount > 1) {
    warnings.push(`${initCount} init events detected (CLI restarted after completion — known bug, grace-kill handled it)`);
  }

  // ── Check 12: Has output content (mode-aware threshold) ──
  // Skill runs always produce substantial output (multiple agents → long reports).
  // Bare runs may be shorter on small codebases.
  if (fs.existsSync(stdoutPath)) {
    const stdout = fs.readFileSync(stdoutPath, 'utf8');
    const lineCount = stdout.split('\n').length;
    const minLines = meta.mode === 'skill' ? 50 : 10;
    checks['has_output'] = {
      ok: lineCount >= minLines,
      detail: lineCount >= minLines
        ? `${lineCount} lines of output`
        : `${lineCount} lines of output (expected ≥${minLines} for ${meta.mode} run)`,
    };
  } else {
    checks['has_output'] = {
      ok: false,
      detail: 'no stdout file',
    };
  }

  const passed = Object.values(checks).every(c => c.ok);

  return { runId: meta.runId, conditionId: meta.conditionId, passed, checks, warnings };
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
    if (r.warnings.length > 0) {
      for (const w of r.warnings) {
        log.warn(`  ⚠ ${w}`);
      }
    }
  }

  const allPassed = results.every(r => r.passed);
  const totalWarnings = results.reduce((sum, r) => sum + r.warnings.length, 0);
  log.separator();
  if (allPassed) {
    const warnSuffix = totalWarnings > 0 ? ` (${totalWarnings} warning(s))` : '';
    log.success(`All ${results.length} runs verified successfully${warnSuffix}`);
  } else {
    const failed = results.filter(r => !r.passed).length;
    log.error(`${failed}/${results.length} runs failed verification`);
  }
}
