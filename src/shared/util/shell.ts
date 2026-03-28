import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as log from './logger.js';

/** Default run timeout: 10 minutes */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Grace period after result event before killing the process */
const POST_RESULT_GRACE_MS = 15_000;

export interface SpawnClaudeOptions {
  cwd: string;
  prompt: string;
  model?: string;
  outputPath: string;
  dryRun?: boolean;
  /** When true, isolate claude from ALL user config (commands, memory, settings) */
  bare?: boolean;
  /** Timeout in ms (default: 10 minutes). Process is killed after this. */
  timeoutMs?: number;
  /** Label for live status (e.g. condition ID). If set, enables live logging. */
  label?: string;
}

export interface SpawnClaudeResult {
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Extract human-readable text from stream-json JSONL output.
 * Parses each line as JSON, pulls text content from assistant messages.
 */
function extractTextFromStreamJson(jsonlPath: string, textPath: string): void {
  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
  const textParts: string[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  fs.writeFileSync(textPath, textParts.join('\n'));
}

/** Truncate string to maxLen, add ellipsis if truncated */
function trunc(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 3) + '...' : s;
}

/**
 * Live stream-json event parser. Watches stdout chunks, extracts JSON lines,
 * and prints human-readable status updates per condition.
 */
class LiveMonitor {
  private label: string;
  private startMs: number;
  private buffer = '';
  private turnCount = 0;
  private agentSpawns = 0;
  private agentReturns = 0;
  private toolCalls: Map<string, number> = new Map();
  private activeAgentIds: Map<string, string> = new Map(); // tool_use_id → description
  private resultReceived = false;

  /** Called when the `result` event arrives — signals the work is done */
  onResultReceived: (() => void) | null = null;

  constructor(label: string, startMs: number) {
    this.label = label;
    this.startMs = startMs;
  }

  private elapsed(): string {
    const sec = Math.round((Date.now() - this.startMs) / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
  }

  private tag(): string {
    return `[${this.label}|${this.elapsed()}]`;
  }

  private out(msg: string): void {
    log.live(`${this.tag()} ${msg}`);
  }

  onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.processEvent(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }
  }

  private processEvent(event: Record<string, unknown>): void {
    const type = event.type as string;

    // ── Session init ──
    if (type === 'system' && event.subtype === 'init') {
      if (this.resultReceived) {
        // Second init after result = CLI restart, we already have our data
        this.out('CLI re-initialized after completion (known issue, will be killed)');
        return;
      }
      const model = event.model as string ?? '?';
      const tools = (event.tools as string[])?.length ?? 0;
      const skills = (event.slash_commands as string[]) ?? [];
      const skillList = skills.filter((s: string) => s !== 'help' && s !== 'clear');
      this.out(`Session started — model: ${model}, tools: ${tools}, skills: ${skillList.length > 0 ? skillList.join(', ') : 'none'}`);
      return;
    }

    // ── Rate limit events ──
    if (type === 'rate_limit_event') {
      const info = event.rate_limit_info as Record<string, unknown> | undefined;
      if (info && info.status !== 'allowed') {
        this.out(`RATE LIMITED: status=${info.status}`);
      }
      return;
    }

    // ── Assistant messages (tool calls, text output) ──
    if (type === 'assistant' && event.message) {
      const msg = event.message as Record<string, unknown>;
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (!content) return;

      const isSubAgent = event.parent_tool_use_id !== null && event.parent_tool_use_id !== undefined;
      if (!isSubAgent) this.turnCount++;

      for (const block of content) {
        if (block.type === 'tool_use') {
          this.handleToolUse(block, isSubAgent);
        }

        if (block.type === 'text') {
          const text = (block.text as string) ?? '';
          if (text.includes('██████')) {
            this.out('Banner printed (skill activated)');
          }
          // Show short text snippets from orchestrator (not sub-agents)
          if (!isSubAgent && text.length > 10 && !text.includes('██')) {
            const firstLine = text.split('\n').find(l => l.trim().length > 5)?.trim() ?? '';
            if (firstLine.length > 5) {
              this.out(`Text: ${trunc(firstLine, 120)}`);
            }
          }
        }
      }
      return;
    }

    // ── Tool results (including agent returns) ──
    if (type === 'user' && event.message) {
      const msg = event.message as Record<string, unknown>;
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (!content) return;
      for (const block of content) {
        if (block.type === 'tool_result') {
          this.handleToolResult(block);
        }
      }
      return;
    }

    // ── Final result ──
    if (type === 'result') {
      this.resultReceived = true;
      const stopReason = event.stop_reason as string ?? '?';
      const cost = event.total_cost_usd as number ?? 0;
      const turns = event.num_turns as number ?? this.turnCount;
      const toolSummary = [...this.toolCalls.entries()]
        .map(([name, count]) => `${name}:${count}`)
        .join(', ');
      this.out(`DONE — ${turns} turns, ${this.agentSpawns} agents (${this.agentReturns} returned), stop: ${stopReason}, cost: $${cost.toFixed(2)}`);
      this.out(`Tools: ${toolSummary || 'none'}`);

      // Signal that result is received
      if (this.onResultReceived) this.onResultReceived();
    }
  }

  private handleToolUse(block: Record<string, unknown>, isSubAgent: boolean): void {
    const toolName = block.name as string;
    this.toolCalls.set(toolName, (this.toolCalls.get(toolName) ?? 0) + 1);

    const input = block.input as Record<string, unknown> | undefined;
    const prefix = isSubAgent ? '  [sub] ' : '';

    if (toolName === 'Agent') {
      this.agentSpawns++;
      const desc = (input?.description as string) ?? '';
      const model = (input?.model as string) ?? 'default';
      const bg = (input?.run_in_background as boolean) ? ' (background)' : '';
      const id = (block.id as string) ?? '';
      this.activeAgentIds.set(id, desc);
      this.out(`${prefix}Agent #${this.agentSpawns} spawned: "${desc}" [${model}]${bg}`);
    } else if (toolName === 'Skill') {
      const skill = (input?.skill as string) ?? '?';
      this.out(`${prefix}Skill invoked: /${skill}`);
    } else if (toolName === 'Bash') {
      const cmd = (input?.command as string) ?? '';
      const desc = (input?.description as string);
      const display = desc || (cmd.split('\n')[0] ?? '');
      this.out(`${prefix}Bash: ${trunc(display, 120)}`);
    } else if (toolName === 'Read') {
      const fp = (input?.file_path as string) ?? '';
      const basename = fp.split('/').pop() ?? fp;
      this.out(`${prefix}Read: ${basename}`);
    } else if (toolName === 'Glob') {
      const pattern = (input?.pattern as string) ?? '';
      this.out(`${prefix}Glob: ${pattern}`);
    } else if (toolName === 'Grep') {
      const pattern = (input?.pattern as string) ?? '';
      const path = (input?.path as string)?.split('/').pop() ?? '';
      this.out(`${prefix}Grep: "${pattern}" ${path ? `in ${path}` : ''}`);
    } else if (toolName === 'ToolSearch') {
      const query = (input?.query as string) ?? '';
      this.out(`${prefix}ToolSearch: ${query}`);
    } else if (toolName === 'Write') {
      const fp = (input?.file_path as string) ?? '';
      const basename = fp.split('/').pop() ?? fp;
      this.out(`${prefix}Write: ${basename}`);
    } else if (toolName === 'Edit') {
      const fp = (input?.file_path as string) ?? '';
      const basename = fp.split('/').pop() ?? fp;
      this.out(`${prefix}Edit: ${basename}`);
    } else {
      this.out(`${prefix}${toolName}`);
    }
  }

  private handleToolResult(block: Record<string, unknown>): void {
    const toolUseId = block.tool_use_id as string;
    const isError = block.is_error as boolean;

    // Check if this is an agent returning
    if (this.activeAgentIds.has(toolUseId)) {
      this.agentReturns++;
      const agentDesc = this.activeAgentIds.get(toolUseId)!;
      this.activeAgentIds.delete(toolUseId);

      // Extract a brief preview of what the agent returned
      let preview = '';
      const content = block.content;
      if (typeof content === 'string') {
        preview = content;
      } else if (Array.isArray(content)) {
        preview = (content as Array<Record<string, unknown>>)
          .filter(c => c.type === 'text')
          .map(c => (c.text as string) ?? '')
          .join(' ');
      }

      // Try to extract finding count or key info from preview
      const findingMatch = preview.match(/(\d+)\s*(?:finding|vulnerabilit|issue)/i);
      const findingInfo = findingMatch ? ` — ${findingMatch[0]}` : '';

      const lineCount = preview.split('\n').length;
      const errTag = isError ? ' ERROR!' : '';
      this.out(`Agent returned (${this.agentReturns}/${this.agentSpawns}): "${agentDesc}" [${lineCount} lines${findingInfo}]${errTag}`);

      // Show first meaningful line of agent output
      const firstLine = preview.split('\n').find(l => l.trim().length > 10 && !l.startsWith('agentId'))?.trim();
      if (firstLine) {
        this.out(`  → ${trunc(firstLine, 140)}`);
      }
      return;
    }

    // Non-agent tool results: show errors and interesting Bash results
    if (isError) {
      let errText = '';
      const content = block.content;
      if (typeof content === 'string') errText = content;
      else if (Array.isArray(content)) {
        errText = (content as Array<Record<string, unknown>>)
          .map(c => (c.text as string) ?? '')
          .join(' ');
      }
      this.out(`Tool ERROR: ${trunc(errText, 150)}`);
    }

    // Show bundle creation results (line counts)
    if (typeof block.content === 'string') {
      const text = block.content as string;
      if (text.includes('bundle') && text.includes('lines')) {
        for (const line of text.split('\n')) {
          if (line.includes('lines') || line.includes('Bundle')) {
            this.out(`  ${line.trim()}`);
          }
        }
      }
      // Show background command notifications
      if (text.includes('Command running in background')) {
        this.out('  Bash running in background...');
      }
    }
  }
}

export async function spawnClaude(opts: SpawnClaudeOptions): Promise<SpawnClaudeResult> {
  if (opts.dryRun) {
    const mode = opts.bare ? ' [BARE]' : '';
    log.dry(`cd ${opts.cwd} && claude -p "${opts.prompt.slice(0, 80)}..."${mode}`);
    return { exitCode: 0, durationMs: 0, timedOut: false };
  }

  const args = ['-p', opts.prompt, '--dangerously-skip-permissions'];
  if (opts.model) {
    args.push('--model', opts.model);
  }

  // Use stream-json for full observability (tool calls, agent spawns, etc.)
  args.push('--output-format', 'stream-json', '--verbose');

  // Strip CLAUDE_CODE* and CLAUDECODE env vars to prevent spawned process
  // from hanging or erroring when launched from within Claude Code.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !key.startsWith('CLAUDE_CODE') && key !== 'CLAUDECODE'
    )
  );

  // Block user-level settings/commands for ALL runs to prevent ~/.claude/commands/
  // from leaking in (wrong skill version) or user CLAUDE.md from influencing results.
  args.push('--setting-sources', 'project,local');

  if (opts.bare) {
    // Disable all skills/commands AND block the Skill tool itself
    args.push('--disable-slash-commands');
    args.push('--disallowedTools', 'Skill');
    log.info('Bare mode: slash commands disabled, Skill tool blocked, user settings skipped');
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  // Stream-json goes to .events.jsonl, we extract text to .stdout.txt after
  const eventsPath = opts.outputPath.replace(/\.stdout\.txt$/, '.events.jsonl');
  const outStream = fs.createWriteStream(eventsPath, { encoding: 'utf8' });

  const child = spawn('claude', args, {
    cwd: opts.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Live monitoring: parse stream-json events as they arrive
  const monitor = opts.label ? new LiveMonitor(opts.label, start) : null;

  // Grace-period kill: once the `result` event arrives, the work is done.
  // The CLI sometimes hangs after completion (starts a new session, etc.).
  // Give it a short grace period then kill it.
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  if (monitor) {
    monitor.onResultReceived = () => {
      graceTimer = setTimeout(() => {
        if (!child.killed) {
          log.live(`[${opts.label}] Result received but CLI still running — terminating (grace period expired)`);
          child.kill('SIGTERM');
        }
      }, POST_RESULT_GRACE_MS);
    };
  }

  child.stdout.on('data', (chunk: Buffer) => {
    outStream.write(chunk);
    if (monitor) monitor.onData(chunk);
  });

  // Capture stderr
  const stderrPath = opts.outputPath.replace(/\.stdout\.txt$/, '.stderr.txt');
  const stderrStream = fs.createWriteStream(stderrPath, { encoding: 'utf8' });
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderrStream.write(text);
    process.stderr.write(`[claude stderr] ${text}`);
  });

  // Timeout handling
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    log.warn(`[${opts.label ?? '?'}] Timeout (${timeoutMs / 1000}s) reached — killing process`);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 5000);
  }, timeoutMs);

  return new Promise((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);

      // Wait for the write stream to fully flush before reading it back.
      outStream.end(() => {
        stderrStream.end();

        // Extract human-readable text from stream-json events
        try {
          extractTextFromStreamJson(eventsPath, opts.outputPath);
        } catch (err) {
          log.warn(`Failed to extract text from stream-json: ${err}`);
          fs.writeFileSync(opts.outputPath, '');
        }

        resolve({
          exitCode: code ?? -1,
          durationMs: Date.now() - start,
          timedOut,
        });
      });
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
