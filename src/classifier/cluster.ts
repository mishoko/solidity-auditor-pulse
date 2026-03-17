/**
 * Semantic clustering of findings across runs.
 *
 * Transforms "42 findings" into "7 unique bugs found N times each."
 *
 * Two clustering paths:
 *   - Incremental (default): new findings matched against existing clusters (batches of 5)
 *   - Full (--force or first run): all findings clustered from scratch (chunks of 15)
 *
 * Two input modes:
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

const IncrementalAssignmentSchema = z.array(
  z.object({
    findingIndex: z.number(),
    assignTo: z.string(), // existing clusterId or "new"
    newTitle: z.string().optional(),
    newReasoning: z.string().optional(),
    newSeverity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
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

// ─── Incremental prompt ───

/**
 * Build a prompt for assigning new findings to existing clusters.
 *
 * Compact cluster context: title + reasoning + severity + member count.
 * Full finding context: title + reasoning (includes description for no-GT).
 *
 * Exported for testing.
 */
export function buildIncrementalPrompt(
  newFindings: ClusterInput[],
  existingClusters: NovelCluster[],
  codebaseId: string,
): string {
  const clusterSection = existingClusters.length > 0
    ? existingClusters.map((c) =>
        `- **${c.clusterId}** (${c.severity}, ${c.foundIn.length} finding(s)): ${c.title}\n  ${c.reasoning}`,
      ).join('\n')
    : '(No existing clusters — all findings should be assigned to "new")';

  const findingsList = newFindings.map((f, i) =>
    `[${i + 1}] Title: ${f.findingTitle}\n  Context: ${f.reasoning}`,
  ).join('\n\n');

  return `You are a smart contract security expert. Below are NEW audit findings from the "${codebaseId}" codebase that need to be assigned to existing vulnerability clusters or flagged as new unique bugs.

## Existing Clusters

${clusterSection}

## New Findings to Assign

${findingsList}

## Task

For each new finding, decide:
1. If it describes the SAME root cause as an existing cluster → assign to that cluster's ID
2. If it's a genuinely NEW vulnerability not covered by any existing cluster → assign to "new"

Be strict about root cause matching — same contract + same function + same bug mechanism = same cluster.
Different bugs in the same function = different clusters.

Respond with ONLY this JSON array:
[
  {
    "findingIndex": 1,
    "assignTo": "<existing clusterId>" | "new",
    "newTitle": "<title for new cluster, only if assignTo=new>",
    "newReasoning": "<1-2 sentences, only if assignTo=new>",
    "newSeverity": "critical" | "high" | "medium" | "low" <only if assignTo=new>
  }
]

IMPORTANT: Every finding must appear exactly once. Do not skip any.`;
}

// ─── Helpers ───

const MAX_FINDINGS_PER_FULL_CHUNK = 15;
const INCREMENTAL_BATCH_SIZE = 5;

/** Identify findings not already in any cluster's foundIn. */
function findNewFindings(inputs: ClusterInput[], existing: ClusterResult): ClusterInput[] {
  const known = new Set<string>();
  for (const cluster of existing.clusters) {
    for (const f of cluster.foundIn) {
      known.add(`${f.runId}::${f.findingIndex}`);
    }
  }
  return inputs.filter((f) => !known.has(`${f.runId}::${f.findingIndex}`));
}

/**
 * Remove foundIn entries that are no longer in the current inputs.
 * This handles reclassification (novel→matched) and deleted runs.
 * Also updates conditionsCaught and removes empty clusters.
 */
function pruneStaleFindings(clusters: NovelCluster[], inputs: ClusterInput[]): NovelCluster[] {
  const validKeys = new Set(inputs.map((f) => `${f.runId}::${f.findingIndex}`));

  const pruned: NovelCluster[] = [];
  for (const cluster of clusters) {
    const liveFoundIn = cluster.foundIn.filter(
      (f) => validKeys.has(`${f.runId}::${f.findingIndex}`),
    );
    if (liveFoundIn.length === 0) continue; // Drop empty clusters entirely
    pruned.push({
      ...cluster,
      foundIn: liveFoundIn,
      conditionsCaught: [...new Set(liveFoundIn.map((f) => f.conditionId))],
    });
  }
  return pruned;
}

/** Generate content-based cluster ID from title + reasoning. */
function makeClusterId(title: string, reasoning: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(title + reasoning)
    .digest('hex')
    .slice(0, 8);
  return `novel-${hash}`;
}

// ─── Incremental clustering ───

/**
 * Assign new findings to existing clusters or create new ones.
 * Processes in batches of INCREMENTAL_BATCH_SIZE for reliable LLM responses.
 */
async function clusterFindingsIncremental(
  newFindings: ClusterInput[],
  existing: ClusterResult,
  codebaseId: string,
): Promise<ClusterResult> {
  // Deep copy clusters to avoid mutating the input
  const clusters: NovelCluster[] = existing.clusters.map((c) => ({
    ...c,
    foundIn: [...c.foundIn],
    conditionsCaught: [...c.conditionsCaught],
  }));

  // Process in batches
  for (let i = 0; i < newFindings.length; i += INCREMENTAL_BATCH_SIZE) {
    const batch = newFindings.slice(i, i + INCREMENTAL_BATCH_SIZE);
    const prompt = buildIncrementalPrompt(batch, clusters, codebaseId);

    try {
      const assignments = await callLLM(prompt, {
        model: CLUSTER_MODEL,
        timeout: CLUSTER_TIMEOUT,
        schema: IncrementalAssignmentSchema,
        jsonShape: 'array',
        retries: 3,
      });

      for (const assignment of assignments) {
        const findingIdx = assignment.findingIndex;
        if (findingIdx < 1 || findingIdx > batch.length) continue;
        const finding = batch[findingIdx - 1]!;

        const findingEntry = {
          runId: finding.runId,
          conditionId: finding.conditionId,
          findingIndex: finding.findingIndex,
          findingTitle: finding.findingTitle,
        };

        if (assignment.assignTo === 'new') {
          // Create new cluster
          const title = assignment.newTitle ?? finding.findingTitle;
          const reasoning = assignment.newReasoning ?? finding.reasoning;
          clusters.push({
            clusterId: makeClusterId(title, reasoning),
            title,
            reasoning,
            severity: assignment.newSeverity ?? 'unknown',
            foundIn: [findingEntry],
            conditionsCaught: [finding.conditionId],
            // relevantFiles left undefined — validator falls back to scope.txt
          });
        } else {
          // Assign to existing cluster
          const cluster = clusters.find((c) => c.clusterId === assignment.assignTo);
          if (cluster) {
            // Guard against duplicate foundIn entries
            const alreadyIn = cluster.foundIn.some(
              (f) => f.runId === finding.runId && f.findingIndex === finding.findingIndex,
            );
            if (!alreadyIn) {
              cluster.foundIn.push(findingEntry);
            }
            if (!cluster.conditionsCaught.includes(finding.conditionId)) {
              cluster.conditionsCaught.push(finding.conditionId);
            }
          } else {
            // Unknown cluster ID from LLM — create new cluster as fallback
            log.warn(`  Unknown cluster ID "${assignment.assignTo}" — creating new cluster`);
            clusters.push({
              clusterId: makeClusterId(finding.findingTitle, finding.reasoning),
              title: finding.findingTitle,
              reasoning: finding.reasoning,
              severity: 'unknown',
              foundIn: [{
                runId: finding.runId,
                conditionId: finding.conditionId,
                findingIndex: finding.findingIndex,
                findingTitle: finding.findingTitle,
              }],
              conditionsCaught: [finding.conditionId],
            });
          }
        }
      }

      // Handle unassigned findings in this batch
      const assignedIndices = new Set(assignments.map((a) => a.findingIndex));
      for (let j = 0; j < batch.length; j++) {
        if (!assignedIndices.has(j + 1)) {
          const f = batch[j]!;
          log.warn(`  Finding "${f.findingTitle.slice(0, 40)}" not assigned — creating orphan cluster`);
          clusters.push({
            clusterId: `novel-orphan-${f.findingIndex}`,
            title: f.findingTitle,
            reasoning: f.reasoning,
            severity: 'unknown',
            foundIn: [{
              runId: f.runId,
              conditionId: f.conditionId,
              findingIndex: f.findingIndex,
              findingTitle: f.findingTitle,
            }],
            conditionsCaught: [f.conditionId],
          });
        }
      }
    } catch (err) {
      const msg = err instanceof LLMError ? err.message : String(err);
      log.warn(`  Incremental batch failed: ${msg} — adding as orphan clusters`);
      for (const f of batch) {
        clusters.push({
          clusterId: `novel-orphan-${f.findingIndex}`,
          title: f.findingTitle,
          reasoning: f.reasoning,
          severity: 'unknown',
          foundIn: [{
            runId: f.runId,
            conditionId: f.conditionId,
            findingIndex: f.findingIndex,
            findingTitle: f.findingTitle,
          }],
          conditionsCaught: [f.conditionId],
        });
      }
    }
  }

  return {
    codebaseId,
    clusteredAt: new Date().toISOString(),
    clusterModel: CLUSTER_MODEL,
    // inputHash set by the caller (clusterFindings orchestrator)
    totalFindings: clusters.reduce((sum, c) => sum + c.foundIn.length, 0),
    uniqueBugs: clusters.length,
    clusters,
  };
}

// ─── Full clustering (with chunking) ───

/**
 * Full re-cluster from scratch. Splits into chunks of MAX_FINDINGS_PER_FULL_CHUNK
 * for reliable LLM responses.
 */
async function clusterFindingsFull(
  inputs: ClusterInput[],
  codebaseId: string,
  options: ClusterOptions,
): Promise<NovelCluster[]> {
  const solFiles = options.scopeFiles ? getSolFileList(codebaseId) : undefined;
  if (solFiles) {
    log.info(`  File scoping enabled: ${solFiles.length} source file(s) for ${codebaseId}`);
  }

  const useScoping = !!(solFiles && solFiles.length > 0);

  interface RawClusterEntry {
    clusterId: string;
    title: string;
    reasoning: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    memberIndices: number[];
    relevantFiles?: string[];
  }

  // Split into chunks if needed
  const chunks: ClusterInput[][] = [];
  for (let i = 0; i < inputs.length; i += MAX_FINDINGS_PER_FULL_CHUNK) {
    chunks.push(inputs.slice(i, i + MAX_FINDINGS_PER_FULL_CHUNK));
  }

  if (chunks.length > 1) {
    log.info(`  Splitting ${inputs.length} findings into ${chunks.length} chunks of ≤${MAX_FINDINGS_PER_FULL_CHUNK}`);
  }

  const allClusters: NovelCluster[] = [];

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]!;
    const chunkLabel = chunks.length > 1 ? ` (chunk ${ci + 1}/${chunks.length})` : '';
    log.info(`  Clustering ${chunk.length} findings${chunkLabel}...`);

    let rawClusters: RawClusterEntry[];
    try {
      if (useScoping) {
        rawClusters = await callLLM(buildClusterPrompt(chunk, codebaseId, solFiles), {
          model: CLUSTER_MODEL,
          timeout: CLUSTER_TIMEOUT,
          schema: ClusterWithScopingResponseSchema,
          jsonShape: 'array',
          retries: 3,
        });
      } else {
        rawClusters = await callLLM(buildClusterPrompt(chunk, codebaseId), {
          model: CLUSTER_MODEL,
          timeout: CLUSTER_TIMEOUT,
          schema: ClusterResponseSchema,
          jsonShape: 'array',
          retries: 3,
        });
      }
    } catch (err) {
      const msg = err instanceof LLMError ? err.message : String(err);
      log.warn(`  Clustering failed${chunkLabel}: ${msg}`);
      // Add chunk findings as orphan clusters
      for (const f of chunk) {
        allClusters.push({
          clusterId: `novel-orphan-${f.findingIndex}`,
          title: f.findingTitle,
          reasoning: f.reasoning,
          severity: 'unknown',
          foundIn: [{ runId: f.runId, conditionId: f.conditionId, findingIndex: f.findingIndex, findingTitle: f.findingTitle }],
          conditionsCaught: [f.conditionId],
        });
      }
      continue;
    }

    // Build clusters from LLM response
    for (const rc of rawClusters) {
      const members = rc.memberIndices
        .filter((i) => i >= 1 && i <= chunk.length)
        .map((i) => chunk[i - 1]!);

      allClusters.push({
        clusterId: makeClusterId(rc.title, rc.reasoning),
        title: rc.title,
        reasoning: rc.reasoning,
        severity: rc.severity,
        foundIn: members.map((m) => ({
          runId: m.runId,
          conditionId: m.conditionId,
          findingIndex: m.findingIndex,
          findingTitle: m.findingTitle,
        })),
        conditionsCaught: [...new Set(members.map((m) => m.conditionId))],
        relevantFiles: rc.relevantFiles,
      });
    }

    // Handle unassigned findings in this chunk
    const assigned = new Set(rawClusters.flatMap((rc) => rc.memberIndices));
    for (let j = 0; j < chunk.length; j++) {
      if (!assigned.has(j + 1)) {
        const f = chunk[j]!;
        allClusters.push({
          clusterId: `novel-orphan-${f.findingIndex}`,
          title: f.findingTitle,
          reasoning: f.reasoning,
          severity: 'unknown',
          foundIn: [{ runId: f.runId, conditionId: f.conditionId, findingIndex: f.findingIndex, findingTitle: f.findingTitle }],
          conditionsCaught: [f.conditionId],
        });
      }
    }
  }

  return allClusters;
}

// ─── Core orchestrator ───

/**
 * Cluster findings for a single codebase.
 *
 * Two paths:
 *   - Incremental (default): match new findings against existing clusters
 *   - Full (--force or no existing clusters): cluster all findings from scratch (chunked)
 */
export async function clusterFindings(
  inputs: ClusterInput[],
  codebaseId: string,
  resultsDir: string,
  options: ClusterOptions = {},
): Promise<ClusterResult | null> {
  const outPath = path.join(resultsDir, `clusters-${codebaseId}.json`);

  if (inputs.length === 0) return null;

  // Content-based cache key
  const inputHash = hashContent(
    JSON.stringify(inputs) + CLUSTER_MODEL + String(!!options.scopeFiles),
  );

  // Load existing clusters (if any)
  let existing: ClusterResult | null = null;
  if (!options.force && fs.existsSync(outPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      // Cache hit: all inputs unchanged + model unchanged
      if (existing!.inputHash === inputHash && existing!.clusterModel === CLUSTER_MODEL) {
        log.info(`  ${codebaseId}: clusters up to date — skipping`);
        return existing;
      }
    } catch {
      existing = null; // Corrupted file — re-cluster
    }
  }

  // Single finding + no existing clusters = single cluster (no LLM needed)
  if (inputs.length === 1 && (!existing || existing.clusters.length === 0)) {
    const f = inputs[0]!;
    const result: ClusterResult = {
      codebaseId,
      clusteredAt: new Date().toISOString(),
      clusterModel: CLUSTER_MODEL,
      inputHash,
      totalFindings: 1,
      uniqueBugs: 1,
      clusters: [{
        clusterId: 'novel-1',
        title: f.findingTitle,
        reasoning: f.reasoning,
        severity: 'unknown',
        foundIn: [{ runId: f.runId, conditionId: f.conditionId, findingIndex: f.findingIndex, findingTitle: f.findingTitle }],
        conditionsCaught: [f.conditionId],
      }],
    };
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    log.info(`  ${codebaseId}: 1 finding → 1 cluster (no LLM needed)`);
    return result;
  }

  // Choose path: incremental vs full
  let result: ClusterResult;

  if (!options.force && existing && existing.clusters.length > 0) {
    // Prune stale foundIn entries (findings that were reclassified or deleted)
    const prunedClusters = pruneStaleFindings(existing.clusters, inputs);
    const prunedCount = existing.clusters.reduce((s, c) => s + c.foundIn.length, 0) -
      prunedClusters.reduce((s, c) => s + c.foundIn.length, 0);
    if (prunedCount > 0) {
      log.info(`  ${codebaseId}: pruned ${prunedCount} stale finding(s) from clusters`);
    }
    const droppedClusters = existing.clusters.length - prunedClusters.length;
    if (droppedClusters > 0) {
      log.info(`  ${codebaseId}: dropped ${droppedClusters} empty cluster(s)`);
    }
    existing.clusters = prunedClusters;

    // Incremental: match new findings against existing clusters
    const newFindings = findNewFindings(inputs, existing);
    if (newFindings.length === 0) {
      log.info(`  ${codebaseId}: no new findings to cluster`);
      // Update counts and inputHash
      existing.inputHash = inputHash;
      existing.totalFindings = prunedClusters.reduce((s, c) => s + c.foundIn.length, 0);
      existing.uniqueBugs = prunedClusters.length;
      fs.writeFileSync(outPath, JSON.stringify(existing, null, 2));
      return existing;
    }

    log.info(`  ${codebaseId}: ${newFindings.length} new finding(s) to assign to ${existing.clusters.length} existing cluster(s) [incremental]`);
    result = await clusterFindingsIncremental(newFindings, existing, codebaseId);
    result.inputHash = inputHash;
  } else {
    // Full: cluster all findings from scratch (chunked if needed)
    log.info(`  ${codebaseId}: clustering ${inputs.length} findings [full${options.force ? ', forced' : ''}]`);
    const clusters = await clusterFindingsFull(inputs, codebaseId, options);
    result = {
      codebaseId,
      clusteredAt: new Date().toISOString(),
      clusterModel: CLUSTER_MODEL,
      inputHash,
      totalFindings: inputs.length,
      uniqueBugs: clusters.length,
      clusters,
    };
  }

  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  log.success(`  ${codebaseId}: ${result.totalFindings} findings in ${result.uniqueBugs} clusters`);

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
