/**
 * Novel cluster validation against actual source code.
 *
 * Per cluster, Opus examines SCOPED source code (only files referenced
 * by the finding's location) to determine if the vulnerability is real.
 *
 * Three verdicts:
 *   - confirmed:  concrete exploit path verified against the code
 *   - plausible:  reasonable concern, exploit depends on assumptions
 *   - rejected:   not a real vulnerability
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type {
  ClusterResult,
  NovelCluster,
  ValidationResult,
} from '../shared/types.js';
import { callLLM, parallelMap, LLMError } from './llm.js';
import * as log from '../shared/util/logger.js';

// ─── Config ───

const VALIDATOR_MODEL = process.env.VALIDATOR_MODEL || 'claude-opus-4-6';
const VALIDATE_CONCURRENCY =
  parseInt(process.env.VALIDATE_CONCURRENCY || '') || 3;
const VALIDATE_TIMEOUT =
  parseInt(process.env.VALIDATOR_TIMEOUT_MS || '') || 180_000;

// ─── Zod schema ───

const ValidationResponseSchema = z.object({
  verdict: z.enum(['confirmed', 'plausible', 'rejected']),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  reasoning: z.string(),
  codeEvidence: z.string().optional(),
});

// ─── Options ───

export interface ValidateOptions {
  force?: boolean;
}

// ─── Source code loading ───

/**
 * Find .sol files recursively, excluding test/node_modules dirs.
 */
function findSolFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (
      entry.isDirectory() &&
      !entry.name.startsWith('.') &&
      entry.name !== 'node_modules' &&
      entry.name !== 'test' &&
      entry.name !== 'tests'
    ) {
      results.push(...findSolFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.sol')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Load source code for Opus validation.
 *
 * Scoping strategy:
 *   1. Use cluster.relevantFiles if populated (from Sonnet during clustering)
 *   2. Fall back to scope.txt
 *   3. Fall back to all non-test .sol files (with size warning)
 */
function loadScopedSource(
  codebaseId: string,
  cluster: NovelCluster,
): { source: string; description: string } {
  const datasetDir = path.resolve(process.cwd(), 'datasets', codebaseId);

  // Step 1: Use relevantFiles from clustering (Sonnet-assigned scoping)
  if (cluster.relevantFiles && cluster.relevantFiles.length > 0) {
    const sections: string[] = [];
    const loaded: string[] = [];
    for (const relPath of cluster.relevantFiles) {
      const fp = path.join(datasetDir, relPath);
      if (!fs.existsSync(fp)) {
        log.warn(`    Scoped file not found: ${relPath}`);
        continue;
      }
      const content = fs.readFileSync(fp, 'utf8');
      sections.push(`// ═══ ${relPath} ═══\n\n${content}`);
      loaded.push(relPath);
    }
    if (sections.length > 0) {
      return {
        source: sections.join('\n\n'),
        description: `${loaded.length} scoped file(s): ${loaded.join(', ')}`,
      };
    }
    // All scoped files missing — fall through to fallbacks
    log.warn(`    All ${cluster.relevantFiles.length} scoped file(s) missing — falling back`);
  }

  // Step 2: Fall back to scope.txt
  const scopePath = path.join(datasetDir, 'scope.txt');
  if (fs.existsSync(scopePath)) {
    const scopeLines = fs
      .readFileSync(scopePath, 'utf8')
      .split('\n')
      .map((l) => l.trim().replace(/^\.\//, ''))
      .filter((l) => l.length > 0 && l.endsWith('.sol'));
    const sections: string[] = [];
    for (const line of scopeLines) {
      const fp = path.join(datasetDir, line);
      if (!fs.existsSync(fp)) continue;
      const content = fs.readFileSync(fp, 'utf8');
      sections.push(`// ═══ ${line} ═══\n\n${content}`);
    }
    if (sections.length > 0) {
      return {
        source: sections.join('\n\n'),
        description: `${sections.length} file(s) from scope.txt (no cluster scoping available)`,
      };
    }
  }

  // Step 3: Fall back to all .sol files
  const allFiles = findSolFiles(datasetDir);
  const sections = allFiles.map((fp) => {
    const content = fs.readFileSync(fp, 'utf8');
    const rel = path.relative(datasetDir, fp);
    return `// ═══ ${rel} ═══\n\n${content}`;
  });
  const source = sections.join('\n\n');
  if (source.length > 200_000) {
    log.warn(
      `    Source for ${codebaseId} is ${Math.round(source.length / 1024)}KB — consider adding scope.txt`,
    );
  }
  return {
    source,
    description: `${allFiles.length} file(s) (all .sol, no scope filter)`,
  };
}

// ─── Prompt ───

function buildValidationPrompt(
  cluster: NovelCluster,
  sourceCode: string,
): string {
  return `You are an elite smart contract security researcher. Validate whether a reported vulnerability is real by examining the actual Solidity source code.

## Reported Vulnerability

Title: ${cluster.title}
Claimed Severity: ${cluster.severity}
Reasoning: ${cluster.reasoning}

## Source Code

${sourceCode}

## Task

Examine the source code. Is this vulnerability REAL and EXPLOITABLE?

Be rigorous:
- Find the specific function(s) and line(s) where the vulnerability would manifest
- Trace the exploit path — can an attacker actually trigger it?
- Consider access controls, modifiers, and guards that might prevent exploitation
- Check if the contract's design intentionally allows the described behavior

VERDICTS:
1. **confirmed** — Vulnerable code found, concrete exploit path verified, no guard prevents it.
2. **plausible** — Reasonable but exploitation depends on assumptions (specific token implementations, governance misconfiguration, rare conditions).
3. **rejected** — Vulnerability doesn't exist in code, is prevented by access controls, describes intended behavior, or exploit path is impossible.

Reassess severity based on YOUR analysis:
- critical: direct, unconditional fund loss or protocol takeover
- high: significant fund loss or major access control bypass under realistic conditions
- medium: conditional fund loss, limited DoS, or minor access control issue
- low: edge case, gas issue, or requires highly unlikely preconditions

Respond with ONLY this JSON:
{
  "verdict": "confirmed" | "plausible" | "rejected",
  "severity": "critical" | "high" | "medium" | "low",
  "reasoning": "<3-5 sentences: what you found, exploit path or why there isn't one, severity justification>",
  "codeEvidence": "<specific function name and key lines supporting your verdict>"
}`;
}

// ─── Core ───

/**
 * Validate all clusters for a codebase.
 */
export async function validateClusters(
  resultsDir: string,
  codebaseId: string,
  options: ValidateOptions = {},
): Promise<ValidationResult | null> {
  const clusterPath = path.join(resultsDir, `clusters-${codebaseId}.json`);
  if (!fs.existsSync(clusterPath)) return null;

  const clusters: ClusterResult = JSON.parse(
    fs.readFileSync(clusterPath, 'utf8'),
  );
  if (clusters.clusters.length === 0) return null;

  // Check staleness
  const valPath = path.join(resultsDir, `validations-${codebaseId}.json`);
  if (!options.force && fs.existsSync(valPath)) {
    const valMtime = fs.statSync(valPath).mtimeMs;
    const clusterMtime = fs.statSync(clusterPath).mtimeMs;
    if (valMtime > clusterMtime) {
      log.info(`  ${codebaseId}: validations up to date — skipping`);
      return JSON.parse(fs.readFileSync(valPath, 'utf8'));
    }
  }

  log.info(
    `  Validating ${clusters.clusters.length} cluster(s) for ${codebaseId} (${VALIDATOR_MODEL}, max ${VALIDATE_CONCURRENCY})`,
  );

  const validations = await parallelMap(
    clusters.clusters,
    async (cluster) => {
      const { source, description } = loadScopedSource(codebaseId, cluster);
      if (source.length === 0) {
        log.warn(`    No source code for "${cluster.title}" — defaulting to plausible`);
        return {
          clusterId: cluster.clusterId,
          title: cluster.title,
          verdict: 'plausible' as const,
          severity: (cluster.severity === 'unknown' ? 'medium' : cluster.severity) as
            | 'critical'
            | 'high'
            | 'medium'
            | 'low',
          reasoning: 'No source code available for validation',
        };
      }

      log.live(`    Validating "${cluster.title.slice(0, 40)}" (${description})`);

      try {
        const response = await callLLM(
          buildValidationPrompt(cluster, source),
          {
            model: VALIDATOR_MODEL,
            timeout: VALIDATE_TIMEOUT,
            schema: ValidationResponseSchema,
          },
        );

        const icon =
          response.verdict === 'confirmed'
            ? '+'
            : response.verdict === 'rejected'
              ? 'x'
              : '?';
        log.live(
          `    ${icon} ${cluster.title.slice(0, 50)} -> ${response.verdict} (${response.severity})`,
        );

        return {
          clusterId: cluster.clusterId,
          title: cluster.title,
          ...response,
        };
      } catch (err) {
        const msg = err instanceof LLMError ? err.message : String(err);
        log.warn(
          `    Validation failed for "${cluster.title}": ${msg} — defaulting to plausible`,
        );
        return {
          clusterId: cluster.clusterId,
          title: cluster.title,
          verdict: 'plausible' as const,
          severity: (cluster.severity === 'unknown' ? 'medium' : cluster.severity) as
            | 'critical'
            | 'high'
            | 'medium'
            | 'low',
          reasoning: `Validation failed: ${msg}`,
        };
      }
    },
    VALIDATE_CONCURRENCY,
  );

  const result: ValidationResult = {
    codebaseId,
    validatedAt: new Date().toISOString(),
    validatorModel: VALIDATOR_MODEL,
    validations,
    confirmed: validations.filter((v) => v.verdict === 'confirmed').length,
    plausible: validations.filter((v) => v.verdict === 'plausible').length,
    rejected: validations.filter((v) => v.verdict === 'rejected').length,
  };

  fs.writeFileSync(valPath, JSON.stringify(result, null, 2));
  log.success(
    `  ${codebaseId}: ${result.confirmed} confirmed, ${result.plausible} plausible, ${result.rejected} rejected`,
  );

  return result;
}

/**
 * Validate clusters for all codebases that have cluster results.
 */
export async function validateAllClusters(
  resultsDir: string,
  options: ValidateOptions = {},
): Promise<Map<string, ValidationResult>> {
  const results = new Map<string, ValidationResult>();
  const clusterFiles = fs
    .readdirSync(resultsDir)
    .filter((f) => f.startsWith('clusters-') && f.endsWith('.json'));

  for (const file of clusterFiles) {
    const codebaseId = file.replace('clusters-', '').replace('.json', '');
    const result = await validateClusters(resultsDir, codebaseId, options);
    if (result) results.set(codebaseId, result);
  }

  return results;
}
