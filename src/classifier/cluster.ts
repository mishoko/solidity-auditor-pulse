/**
 * Semantic clustering of findings across runs.
 *
 * Groups findings by root cause using a single LLM call per codebase.
 * Transforms "42 findings" into "7 unique bugs found N times each."
 *
 * Two modes:
 *   - With GT: clusters only novel + uncertain findings (matched/FP already categorized)
 *   - Without GT: clusters ALL findings (no classification step)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { parseOutput } from '../shared/parser.js';
import type {
  RunMeta,
  RunClassification,
  NovelCluster,
  ClusterResult,
} from '../shared/types.js';
import { callLLM, LLMError } from './llm.js';
import { hashContent } from '../shared/util/hash.js';
import * as log from '../shared/util/logger.js';

// ─── Config ───

const CLUSTER_MODEL = process.env.CLUSTER_MODEL || 'claude-sonnet-4-20250514';
const CLUSTER_TIMEOUT = parseInt(process.env.CLUSTER_TIMEOUT_MS || '') || 180_000;

// ─── Zod schemas ───

const ClusterResponseSchema = z.array(
  z.object({
    clusterId: z.string(),
    title: z.string(),
    reasoning: z.string(),
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    memberIndices: z.array(z.number()),
  }),
);

const ClusterWithScopingResponseSchema = z.array(
  z.object({
    clusterId: z.string(),
    title: z.string(),
    reasoning: z.string(),
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    memberIndices: z.array(z.number()),
    relevantFiles: z.array(z.string()),
  }),
);

// ─── Options ───

export interface ClusterOptions {
  force?: boolean;
  /** When true, include file list in prompt and ask Sonnet to map clusters to files. */
  scopeFiles?: boolean;
}

// ─── Types ───

interface ClusterInput {
  runId: string;
  conditionId: string;
  findingIndex: number;
  findingTitle: string;
  reasoning: string;
}

// ─── File discovery ───

/**
 * Find .sol files recursively, excluding test/node_modules dirs.
 * Returns paths relative to the dataset directory.
 */
function findSolFilesRelative(datasetDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
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
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.sol')) {
        results.push(path.relative(datasetDir, full));
      }
    }
  }

  walk(datasetDir);
  return results;
}

/**
 * Get the list of in-scope .sol files for a codebase.
 * Uses scope.txt if available, otherwise all non-test .sol files.
 */
function getSolFileList(codebaseId: string): string[] {
  const datasetDir = path.resolve(process.cwd(), 'datasets', codebaseId);
  if (!fs.existsSync(datasetDir)) return [];

  // Prefer scope.txt
  const scopePath = path.join(datasetDir, 'scope.txt');
  if (fs.existsSync(scopePath)) {
    const lines = fs
      .readFileSync(scopePath, 'utf8')
      .split('\n')
      .map((l) => l.trim().replace(/^\.\//, ''))
      .filter((l) => l.length > 0 && l.endsWith('.sol'));
    if (lines.length > 0) return lines;
  }

  return findSolFilesRelative(datasetDir);
}

// ─── Prompt ───

function buildClusterPrompt(findings: ClusterInput[], codebaseId: string, solFiles?: string[]): string {
  const findingsList = findings
    .map(
      (f, i) =>
        `[${i + 1}] (run: ${f.runId.slice(-20)}, condition: ${f.conditionId})\n` +
        `  Title: ${f.findingTitle}\n` +
        `  Reasoning: ${f.reasoning}`,
    )
    .join('\n\n');

  const fileListSection = solFiles && solFiles.length > 0
    ? `\n## Source Files in This Codebase\n\n${solFiles.map((f) => `- ${f}`).join('\n')}\n`
    : '';

  const scopingField = solFiles && solFiles.length > 0
    ? `\n    "relevantFiles": ["contracts/Foo.sol", "contracts/Bar.sol"]`
    : '';

  const scopingInstruction = solFiles && solFiles.length > 0
    ? `\n\nFor each cluster, identify which source files from the list above contain the vulnerable code. Use the "relevantFiles" field. Pick only the files where the root cause lives — typically 1-3 files per cluster. Use the exact file paths from the source files list.`
    : '';

  return `You are a smart contract security expert. Below are ${findings.length} audit findings from multiple independent runs against the "${codebaseId}" codebase. Many describe the SAME underlying bug found independently. Group them by ROOT CAUSE into unique bugs.

## Findings

${findingsList}
${fileListSection}
## Task

Group these findings by ROOT CAUSE into unique bugs. Findings describing the same vulnerability (even if worded differently) should be in the same cluster.

Severity guide:
- critical: direct fund loss, protocol takeover
- high: significant fund loss, major DoS, access control bypass
- medium: conditional fund loss, limited DoS, minor access control issue
- low: informational, gas optimization, edge case${scopingInstruction}

Respond with ONLY this JSON array:
[
  {
    "clusterId": "novel-1",
    "title": "<concise bug title>",
    "reasoning": "<1-2 sentences explaining the root cause>",
    "severity": "critical" | "high" | "medium" | "low",
    "memberIndices": [1, 5, 12]${scopingField}
  }
]

Where memberIndices are 1-based indices from the findings list above.
IMPORTANT: Every finding must appear in exactly one cluster. Do not skip any.`;
}

// ─── Core ───

/**
 * Cluster findings for a single codebase.
 *
 * @param inputs - Findings to cluster (novel+uncertain for GT mode, all for no-GT mode)
 * @param codebaseId - Codebase identifier
 * @param resultsDir - Results directory for output
 * @param options - Cluster options
 */
export async function clusterFindings(
  inputs: ClusterInput[],
  codebaseId: string,
  resultsDir: string,
  options: ClusterOptions = {},
): Promise<ClusterResult | null> {
  const outPath = path.join(resultsDir, `clusters-${codebaseId}.json`);

  if (inputs.length === 0) return null;

  // Content-based cache key: hash of inputs + model + scoping option
  const inputHash = hashContent(
    JSON.stringify(inputs) + CLUSTER_MODEL + String(!!options.scopeFiles),
  );

  // Cache check: content hash + model must match
  if (!options.force && fs.existsSync(outPath)) {
    try {
      const existing: ClusterResult = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (existing.inputHash === inputHash && existing.clusterModel === CLUSTER_MODEL) {
        log.info(`  ${codebaseId}: clusters up to date — skipping`);
        return existing;
      }
    } catch {
      // Corrupted file — re-cluster
    }
  }

  // Resolve file list for scoping (if enabled)
  const solFiles = options.scopeFiles ? getSolFileList(codebaseId) : undefined;
  if (solFiles) {
    log.info(`  File scoping enabled: ${solFiles.length} source file(s) for ${codebaseId}`);
  }

  // Single finding = single cluster (no LLM needed)
  if (inputs.length === 1) {
    const f = inputs[0]!;
    const result: ClusterResult = {
      codebaseId,
      clusteredAt: new Date().toISOString(),
      clusterModel: CLUSTER_MODEL,
      inputHash,
      totalFindings: 1,
      uniqueBugs: 1,
      clusters: [
        {
          clusterId: 'novel-1',
          title: f.findingTitle,
          reasoning: f.reasoning,
          severity: 'unknown',
          foundIn: [
            {
              runId: f.runId,
              conditionId: f.conditionId,
              findingIndex: f.findingIndex,
              findingTitle: f.findingTitle,
            },
          ],
          conditionsCaught: [f.conditionId],
          // Don't assign all files — validator falls back to scope.txt if relevantFiles absent
        },
      ],
    };
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    log.info(`  ${codebaseId}: 1 finding → 1 cluster (no LLM needed)`);
    return result;
  }

  const scopeLabel = solFiles ? ` + file scoping` : '';
  log.info(`  Clustering ${inputs.length} findings for ${codebaseId}${scopeLabel}...`);

  const useScoping = !!(solFiles && solFiles.length > 0);

  // Common shape for both schemas — relevantFiles may or may not be present
  interface RawClusterEntry {
    clusterId: string;
    title: string;
    reasoning: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    memberIndices: number[];
    relevantFiles?: string[];
  }

  let rawClusters: RawClusterEntry[];
  try {
    if (useScoping) {
      rawClusters = await callLLM(buildClusterPrompt(inputs, codebaseId, solFiles), {
        model: CLUSTER_MODEL,
        timeout: CLUSTER_TIMEOUT,
        schema: ClusterWithScopingResponseSchema,
        jsonShape: 'array',
        retries: 3,
      });
    } else {
      rawClusters = await callLLM(buildClusterPrompt(inputs, codebaseId), {
        model: CLUSTER_MODEL,
        timeout: CLUSTER_TIMEOUT,
        schema: ClusterResponseSchema,
        jsonShape: 'array',
        retries: 3,
      });
    }
  } catch (err) {
    const msg = err instanceof LLMError ? err.message : String(err);
    log.warn(`  Clustering failed for ${codebaseId}: ${msg}`);
    return null;
  }

  // Build typed clusters with content-based IDs for stability
  const clusters: NovelCluster[] = rawClusters.map((rc) => {
    const members = rc.memberIndices
      .filter((i) => i >= 1 && i <= inputs.length)
      .map((i) => inputs[i - 1]!);

    const conditionsCaught = [...new Set(members.map((m) => m.conditionId))];

    // Content-based ID: SHA-256(title + reasoning) truncated to 8 chars
    const hash = crypto
      .createHash('sha256')
      .update(rc.title + rc.reasoning)
      .digest('hex')
      .slice(0, 8);

    return {
      clusterId: `novel-${hash}`,
      title: rc.title,
      reasoning: rc.reasoning,
      severity: rc.severity,
      foundIn: members.map((m) => ({
        runId: m.runId,
        conditionId: m.conditionId,
        findingIndex: m.findingIndex,
        findingTitle: m.findingTitle,
      })),
      conditionsCaught,
      relevantFiles: rc.relevantFiles,
    };
  });

  // Verify all findings were assigned
  const assigned = new Set(rawClusters.flatMap((rc) => rc.memberIndices));
  const unassigned = inputs.filter((_, i) => !assigned.has(i + 1));
  if (unassigned.length > 0) {
    log.warn(
      `  ${unassigned.length} finding(s) not assigned to any cluster — adding as individual clusters`,
    );
    for (const f of unassigned) {
      clusters.push({
        clusterId: `novel-orphan-${f.findingIndex}`,
        title: f.findingTitle,
        reasoning: f.reasoning,
        severity: 'unknown',
        foundIn: [
          {
            runId: f.runId,
            conditionId: f.conditionId,
            findingIndex: f.findingIndex,
            findingTitle: f.findingTitle,
          },
        ],
        conditionsCaught: [f.conditionId],
      });
    }
  }

  const result: ClusterResult = {
    codebaseId,
    clusteredAt: new Date().toISOString(),
    clusterModel: CLUSTER_MODEL,
    inputHash,
    totalFindings: inputs.length,
    uniqueBugs: clusters.length,
    clusters,
  };

  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  log.success(`  Clustered ${inputs.length} findings into ${clusters.length} unique bugs`);

  return result;
}

// ─── Collect cluster inputs from classification results ───

/**
 * Collect novel + uncertain findings from classification results (GT mode).
 */
export function collectNovelFindings(
  classifications: RunClassification[],
): ClusterInput[] {
  const inputs: ClusterInput[] = [];
  for (const cls of classifications) {
    for (const c of cls.classifications) {
      if (c.category === 'novel' || c.category === 'uncertain') {
        // Use the majority vote reasoning
        inputs.push({
          runId: cls.runId,
          conditionId: cls.conditionId,
          findingIndex: c.findingIndex,
          findingTitle: c.findingTitle,
          reasoning: c.reasoning,
        });
      }
    }
  }
  return inputs;
}

/**
 * Collect ALL findings from parsed output (no-GT mode).
 */
export function collectAllFindings(
  resultsDir: string,
  codebaseId: string,
): ClusterInput[] {
  const metaFiles = fs.readdirSync(resultsDir).filter((f) => f.endsWith('.meta.json'));
  const inputs: ClusterInput[] = [];

  for (const file of metaFiles) {
    const metaPath = path.join(resultsDir, file);
    let meta: RunMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      continue;
    }
    if (meta.codebaseId !== codebaseId) continue;
    if (meta.exitCode !== 0 && meta.exitCode !== 143) continue;

    const stdoutPath = path.join(resultsDir, `${meta.runId}.stdout.txt`);
    if (!fs.existsSync(stdoutPath)) continue;

    const text = fs.readFileSync(stdoutPath, 'utf8');
    const parseResult = parseOutput(text);

    for (const finding of parseResult.findings) {
      // Use description for richer context (critical for no-GT clustering quality)
      const reasoning = finding.description
        ? `${finding.description} Location: ${finding.location ?? 'unknown'}. Type: ${finding.vulnType}.`
        : `Location: ${finding.location ?? 'unknown'}. Type: ${finding.vulnType}.`;
      inputs.push({
        runId: meta.runId,
        conditionId: meta.conditionId,
        findingIndex: finding.index,
        findingTitle: finding.title,
        reasoning,
      });
    }
  }

  return inputs;
}

/**
 * Cluster all codebases: GT-codebases use novel+uncertain findings,
 * no-GT codebases use all findings.
 */
export async function clusterAllCodebases(
  resultsDir: string,
  classifications: RunClassification[],
  options: ClusterOptions = {},
): Promise<Map<string, ClusterResult>> {
  const results = new Map<string, ClusterResult>();

  // Discover all codebases from meta files
  const metaFiles = fs.readdirSync(resultsDir).filter((f) => f.endsWith('.meta.json'));
  const allCodebases = new Set<string>();
  for (const file of metaFiles) {
    try {
      const meta: RunMeta = JSON.parse(
        fs.readFileSync(path.join(resultsDir, file), 'utf8'),
      );
      if (meta.exitCode === 0 || meta.exitCode === 143) {
        allCodebases.add(meta.codebaseId);
      }
    } catch {
      continue;
    }
  }

  // Cache is now handled inside clusterFindings() via content hashing.
  // No mtime checks needed here — clusterFindings compares inputHash + model.

  for (const codebaseId of allCodebases) {
    // Check if GT exists
    const gtPath = path.resolve(process.cwd(), 'ground_truth', `${codebaseId}.json`);
    const hasGt = fs.existsSync(gtPath);

    let inputs: ClusterInput[];
    if (hasGt) {
      // GT mode: cluster novel + uncertain from classification results
      const codebaseClassifications = classifications.filter(
        (c) => c.codebaseId === codebaseId,
      );
      if (codebaseClassifications.length === 0) {
        log.info(`  ${codebaseId}: no classifications — skipping clustering`);
        continue;
      }
      inputs = collectNovelFindings(codebaseClassifications);
    } else {
      // No-GT mode: cluster all findings
      inputs = collectAllFindings(resultsDir, codebaseId);
    }

    if (inputs.length === 0) {
      log.info(`  ${codebaseId}: no findings to cluster`);
      continue;
    }

    const result = await clusterFindings(inputs, codebaseId, resultsDir, options);
    if (result) results.set(codebaseId, result);
  }

  return results;
}
