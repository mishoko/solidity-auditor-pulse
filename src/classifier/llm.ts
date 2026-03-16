/**
 * Shared LLM call utility for the classifier pipeline.
 *
 * Single place to spawn `claude -p`, parse JSON responses,
 * and validate with Zod. All LLM calls in the classifier
 * go through this module.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';

// ─── Config ───

/** Delay between retries in ms. Helps with rate limits and transient CLI failures. */
const RETRY_DELAY_MS = parseInt(process.env.LLM_RETRY_DELAY_MS || '') || 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Error types ───

export type LLMErrorCode = 'timeout' | 'exit' | 'parse' | 'validation' | 'spawn';

export class LLMError extends Error {
  constructor(
    public readonly code: LLMErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

// ─── Options ───

export interface LLMCallOptions<T> {
  model: string;
  timeout: number;
  /** Zod schema to validate the parsed JSON response. */
  schema: z.ZodType<T>;
  /** Expected JSON shape: 'object' matches first {...}, 'array' matches first [...]. Default: 'object'. */
  jsonShape?: 'object' | 'array';
  /** Max retry attempts on transient failures (empty response, parse errors). Default: 2. */
  retries?: number;
}

// ─── Environment ───

/** Build a clean env object with CLAUDE_CODE* and CLAUDECODE vars stripped. */
function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('CLAUDE_CODE') && key !== 'CLAUDECODE',
    ),
  ) as Record<string, string>;
}

// ─── Core ───

/**
 * Call `claude -p` with a prompt and parse the JSON response.
 *
 * @returns Validated response of type T.
 * @throws LLMError on timeout, non-zero exit, JSON parse failure, or schema validation failure.
 */
export async function callLLM<T>(prompt: string, opts: LLMCallOptions<T>): Promise<T> {
  const maxRetries = opts.retries ?? 2;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const raw = await spawnClaude(prompt, opts.model, opts.timeout);
      return parseAndValidate(raw, opts);
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        const code = err instanceof LLMError ? err.code : 'unknown';
        // Only retry on transient failures (empty response, parse errors), not on validation errors
        if (code === 'exit' || code === 'parse' || code === 'timeout') {
          await delay(RETRY_DELAY_MS);
          continue;
        }
      }
      throw err;
    }
  }
  throw lastError!;
}

/**
 * Call `claude -p` and return raw text (no JSON parsing).
 * Used for narrative generation where the output is markdown, not JSON.
 */
export async function callLLMRaw(prompt: string, model: string, timeout: number): Promise<string> {
  // Retry once on empty response
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await spawnClaude(prompt, model, timeout);
    } catch (err) {
      if (attempt < 2 && err instanceof LLMError && err.code === 'exit') {
        await delay(RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
  throw new LLMError('exit', 'All retry attempts failed');
}

/**
 * Spawn `claude -p` and return raw stdout text.
 */
function spawnClaude(prompt: string, model: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'text', '--model', model, '--max-turns', '1'];

    const child = spawn('claude', args, {
      env: cleanEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new LLMError('timeout', `LLM call timed out (${timeout / 1000}s)`));
    }, timeout);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new LLMError('spawn', `Failed to spawn claude: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new LLMError('exit', `claude exited with code ${code}: ${stderr.slice(0, 300)}`),
        );
      } else {
        const trimmed = stdout.trim();
        if (trimmed.length === 0) {
          reject(
            new LLMError('exit', `claude returned empty stdout (exit=0, stderr=${stderr.length}B). CLI flaky response — will retry.`),
          );
        } else {
          resolve(trimmed);
        }
      }
    });
  });
}

/**
 * Extract JSON from raw LLM output and validate against schema.
 */
function parseAndValidate<T>(raw: string, opts: LLMCallOptions<T>): T {
  const pattern = opts.jsonShape === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const match = raw.match(pattern);
  if (!match) {
    throw new LLMError('parse', `No JSON ${opts.jsonShape ?? 'object'} found in response (${raw.length} chars)`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch (e) {
    throw new LLMError('parse', `Invalid JSON: ${(e as Error).message}`);
  }

  const result = opts.schema.safeParse(parsed);
  if (!result.success) {
    throw new LLMError(
      'validation',
      `Schema validation failed: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }

  return result.data;
}

// ─── Concurrency utility ───

/**
 * Run async tasks with bounded concurrency.
 * Returns results in the same order as inputs.
 */
export async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]!, idx);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
