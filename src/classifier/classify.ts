/**
 * GT classification with 3x majority vote.
 *
 * For each finding, calls Sonnet 3 times with the same prompt.
 * Takes majority vote:
 *   - 3/3 agree → high confidence
 *   - 2/3 agree → medium confidence
 *   - no majority → uncertain (preserved, not defaulted to FP)
 *
 * Deduplicates GT matches: if multiple findings match the same GT ID,
 * the one with highest agreement wins; losers become uncertain.
 *
 * Results cached by gtHash + stdoutHash — skip if both match.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { parseOutput, type ParsedFinding } from '../shared/parser.js';
import type {
  RunMeta,
  GroundTruth,
  GTFinding,
  ClassificationVote,
  FindingClassification,
  RunClassification,
} from '../shared/types.js';
import { callLLM, parallelMap, LLMError } from './llm.js';
import { hashContent } from '../shared/util/hash.js';
import * as log from '../shared/util/logger.js';

// ─── Config ───

const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL || 'claude-sonnet-4-20250514';
const CLASSIFY_CONCURRENCY = parseInt(process.env.CLASSIFY_CONCURRENCY || '') || 10;
const CLASSIFY_TIMEOUT = 120_000;
/** Number of classification votes per finding. 1 = fast/cheap, 3 = reliable. */
const VOTES_PER_FINDING = parseInt(process.env.CLASSIFY_VOTES || '') || 1;

// ─── Zod schema for classification response ───

const ClassifyResponseSchema = z.object({
  matchedGtId: z.string().nullable(),
  category: z.enum(['matched', 'novel', 'fp']),
  confidence: z.enum(['high', 'medium', 'low']),
  reasoning: z.string(),
});

// ─── Options ───

export interface ClassifyOptions {
  force?: boolean;
}

// ─── Utilities ───

function loadGroundTruth(codebaseId: string): GroundTruth | null {
  const gtPath = path.resolve(process.cwd(), 'ground_truth', `${codebaseId}.json`);
  if (!fs.existsSync(gtPath)) return null;
  return JSON.parse(fs.readFileSync(gtPath, 'utf8'));
}

/**
 * Extract ~40 lines of context around a finding from the raw audit text.
 */
function extractFindingContext(text: string, finding: ParsedFinding): string {
  const lines = text.split('\n');
  const titleClean = finding.title.replace(/[`*]/g, '');
  const idx = lines.findIndex((l) => {
    const clean = l.replace(/[`*]/g, '');
    return (
      clean.includes(titleClean) ||
      (titleClean.length > 20 && clean.includes(titleClean.slice(0, 20)))
    );
  });
  if (idx === -1) return finding.title;
  const start = Math.max(0, idx);
  const end = Math.min(lines.length, idx + 40);
  return lines.slice(start, end).join('\n');
}

// ─── Prompt ───

/**
 * Static prompt template text. Hashed for cache invalidation —
 * when this text changes, all cached classifications auto-invalidate.
 */
const CLASSIFY_PROMPT_TEMPLATE = `You are a smart contract security expert. Classify ONE audit finding against known ground truth vulnerabilities from an official C4 audit contest.

## Ground Truth Entries (Known Real Bugs)

{{GT_SECTION}}

## Audit Finding to Classify

Title: {{FINDING_TITLE}}
Location: {{FINDING_LOCATION}}
Confidence: {{FINDING_CONFIDENCE}}
Severity: {{FINDING_SEVERITY}}

Full context from the audit report:
"""
{{FINDING_CONTEXT}}
"""

## Task

Does this finding describe the SAME root cause as any ground truth entry?

RULES:
1. **matched** — Same ROOT CAUSE as a GT entry. Set matchedGtId to the GT ID.
   - Same contract.function does NOT mean same bug. The ROOT CAUSE must match.
   - "overrideCampaign uses wrong startTimestamp" MATCHES L-02 ("override end timestamp uses wrong variable") — same root cause.
   - "fee-on-transfer accounting" does NOT match M-01 ("minimum rate on gross amount") — different root causes even if same function.

2. **novel** — A genuine/plausible vulnerability NOT in the ground truth. Must describe a concrete exploit path or clearly broken invariant. Set matchedGtId to null.

3. **fp** — Incorrect, describes intended behavior, purely informational, centralization/admin-trust without exploit, or too vague. Set matchedGtId to null.

Respond with ONLY this JSON:
{
  "matchedGtId": "<GT_ID>" or null,
  "category": "matched" | "novel" | "fp",
  "confidence": "high" | "medium" | "low",
  "reasoning": "<2-3 sentences: root cause, why it does/doesn't match GT, if novel why it's real>"
}`;

/** Cached hash of the prompt template — computed once at module load. */
const PROMPT_HASH = hashContent(CLASSIFY_PROMPT_TEMPLATE);

function buildClassifyPrompt(
  finding: ParsedFinding,
  findingContext: string,
  gtFindings: GTFinding[],
): string {
  const gtSection = gtFindings
    .map(
      (g) =>
        `### ${g.id} (${g.severity ?? 'unknown'})
Title: ${g.title ?? 'N/A'}
Location: ${g.location ?? 'N/A'}
Root Cause: ${g.rootCause ?? 'N/A'}
Description: ${g.description}`,
    )
    .join('\n\n');

  return CLASSIFY_PROMPT_TEMPLATE
    .replace('{{GT_SECTION}}', gtSection)
    .replace('{{FINDING_TITLE}}', finding.title)
    .replace('{{FINDING_LOCATION}}', finding.location ?? 'unknown')
    .replace('{{FINDING_CONFIDENCE}}', String(finding.confidence ?? 'N/A'))
    .replace('{{FINDING_SEVERITY}}', finding.severity ?? 'N/A')
    .replace('{{FINDING_CONTEXT}}', findingContext);
}

// ─── Single vote ───

/**
 * Cast a single classification vote. Returns null on failure
 * (failed votes must NOT count as FP — they are excluded from majority).
 */
async function castVote(
  finding: ParsedFinding,
  findingContext: string,
  gtFindings: GTFinding[],
): Promise<ClassificationVote | null> {
  try {
    const response = await callLLM(
      buildClassifyPrompt(finding, findingContext, gtFindings),
      {
        model: CLASSIFIER_MODEL,
        timeout: CLASSIFY_TIMEOUT,
        schema: ClassifyResponseSchema,
      },
    );

    // Validate GT ID if matched
    if (response.matchedGtId !== null) {
      const valid = gtFindings.some((g) => g.id === response.matchedGtId);
      if (!valid) {
        return {
          category: 'fp',
          matchedGtId: null,
          confidence: 'low',
          reasoning: `Invalid GT ID "${response.matchedGtId}". ${response.reasoning}`,
        };
      }
      // Force category to matched when GT ID is present
      response.category = 'matched';
    }

    return {
      category: response.category,
      matchedGtId: response.matchedGtId,
      confidence: response.confidence,
      reasoning: response.reasoning,
    };
  } catch (err) {
    const msg = err instanceof LLMError ? `${err.code}: ${err.message}` : String(err);
    log.warn(`    Vote failed for #${finding.index}: ${msg}`);
    return null; // Failed votes are excluded, not counted as FP
  }
}

// ─── Majority vote logic ───

/**
 * Compute the majority decision from votes (nulls = failed votes, excluded).
 *
 * With 1 successful vote: uses that vote directly.
 * With 2+ successful votes: majority wins. No majority → uncertain.
 * With 0 successful votes: uncertain (all votes failed).
 *
 * Exported for testing — not part of the public API.
 */
export function computeMajority(rawVotes: (ClassificationVote | null)[]): FindingClassification & { _agreement: number } {
  // Filter out failed votes
  const votes = rawVotes.filter((v): v is ClassificationVote => v !== null);
  const failedCount = rawVotes.length - votes.length;

  // All votes failed
  if (votes.length === 0) {
    return {
      findingIndex: 0,
      findingTitle: '',
      category: 'uncertain',
      matchedGtId: null,
      agreement: 'no-majority',
      reasoning: `All ${rawVotes.length} vote(s) failed — cannot classify.`,
      votes: [],
      _agreement: 0,
    };
  }

  // Single successful vote — use it directly
  if (votes.length === 1) {
    const vote = votes[0]!;
    // Show actual vote count: 1/1 for single-vote mode, 1/3 if 2 others failed
    const agreement = rawVotes.length === 1 ? '1/1' : `1/${rawVotes.length}`;
    return {
      findingIndex: 0,
      findingTitle: '',
      category: vote.category,
      matchedGtId: vote.matchedGtId,
      agreement: agreement as string,
      reasoning: vote.reasoning,
      votes,
      _agreement: 1,
    };
  }

  // Build vote keys: "matched:M-01", "novel:", "fp:"
  const voteKeys = votes.map((v) =>
    v.category === 'matched' ? `matched:${v.matchedGtId}` : `${v.category}:`,
  );

  // Count occurrences
  const counts = new Map<string, number>();
  for (const key of voteKeys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Find majority
  let majorityKey: string | null = null;
  let majorityCount = 0;
  for (const [key, count] of counts) {
    if (count > majorityCount) {
      majorityCount = count;
      majorityKey = key;
    }
  }

  // No majority among successful votes
  if (majorityCount < 2 || majorityKey === null) {
    const bestVote = votes.find((v) => v.category === 'novel') ?? votes[0]!;
    return {
      findingIndex: 0,
      findingTitle: '',
      category: 'uncertain',
      matchedGtId: null,
      agreement: 'no-majority',
      reasoning: `No majority (${voteKeys.join(', ')}${failedCount > 0 ? `, ${failedCount} failed` : ''}). ${bestVote.reasoning}`,
      votes,
      _agreement: 0,
    };
  }

  // Get the representative vote
  const majorityIdx = voteKeys.findIndex((k) => k === majorityKey);
  const representative = votes[majorityIdx]!;
  const agreement = `${majorityCount}/${rawVotes.length}`;

  return {
    findingIndex: 0,
    findingTitle: '',
    category: representative.category,
    matchedGtId: representative.matchedGtId,
    agreement,
    reasoning: representative.reasoning,
    votes,
    _agreement: majorityCount,
  };
}

// ─── Per-run classification ───

async function classifyRun(
  runId: string,
  resultsDir: string,
  gt: GroundTruth,
  options: ClassifyOptions,
): Promise<RunClassification | null> {
  const metaPath = path.join(resultsDir, `${runId}.meta.json`);
  const stdoutPath = path.join(resultsDir, `${runId}.stdout.txt`);
  if (!fs.existsSync(metaPath) || !fs.existsSync(stdoutPath)) return null;

  const meta: RunMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (meta.exitCode !== 0 && meta.exitCode !== 143) return null;

  const text = fs.readFileSync(stdoutPath, 'utf8');
  const stdoutHash = hashContent(text);
  const gtHash = hashContent(JSON.stringify(gt));
  const classPath = path.join(resultsDir, `${runId}.classifications.json`);

  // Cache check: gt + stdout + prompt template must all match
  if (!options.force && fs.existsSync(classPath)) {
    try {
      const existing: RunClassification = JSON.parse(fs.readFileSync(classPath, 'utf8'));
      if (
        existing.gtHash === gtHash &&
        existing.stdoutHash === stdoutHash &&
        existing.promptHash === PROMPT_HASH
      ) {
        log.info(`  Cached: ${runId}`);
        return existing;
      }
      if (existing.promptHash !== PROMPT_HASH) {
        log.info(`  Prompt changed — re-classifying: ${runId}`);
      }
    } catch {
      // Corrupted file — re-classify
    }
  }

  const parseResult = parseOutput(text);

  // LLM fallback: recover findings from unmatched blocks
  if (parseResult.unmatchedBlocks.length > 0) {
    log.info(`  ${parseResult.unmatchedBlocks.length} unmatched block(s) — attempting LLM recovery`);
    try {
      const { recoverUnmatchedFindings } = await import('../shared/parser.js');
      const recovered = await recoverUnmatchedFindings(
        parseResult.unmatchedBlocks,
        parseResult.findings.length + 1,
      );
      if (recovered.length > 0) {
        parseResult.findings.push(...recovered);
        log.success(`  Recovered ${recovered.length} finding(s)`);
      }
    } catch (err) {
      log.warn(`  LLM recovery failed: ${err}`);
    }
  }

  if (parseResult.findings.length === 0) {
    const emptyResult: RunClassification = {
      runId,
      codebaseId: meta.codebaseId,
      conditionId: meta.conditionId,
      classifiedAt: new Date().toISOString(),
      classifierModel: CLASSIFIER_MODEL,
      gtHash,
      stdoutHash,
      promptHash: PROMPT_HASH,
      votesPerFinding: VOTES_PER_FINDING,
      classifications: [],
    };
    fs.writeFileSync(classPath, JSON.stringify(emptyResult, null, 2));
    return emptyResult;
  }

  log.info(
    `  Classifying ${parseResult.findings.length} findings × ${VOTES_PER_FINDING} votes (${CLASSIFIER_MODEL}, max ${CLASSIFY_CONCURRENCY} concurrent)`,
  );

  // Pre-extract contexts
  const findingsWithContext = parseResult.findings.map((finding) => ({
    finding,
    context: extractFindingContext(text, finding),
  }));

  // ── Step 1: Cast 3 votes per finding (parallel across all vote tasks) ──
  interface VoteTask {
    findingIdx: number;
    voteNum: number;
  }
  const voteTasks: VoteTask[] = [];
  for (let fi = 0; fi < findingsWithContext.length; fi++) {
    for (let vi = 0; vi < VOTES_PER_FINDING; vi++) {
      voteTasks.push({ findingIdx: fi, voteNum: vi });
    }
  }

  const voteResults = await parallelMap(
    voteTasks,
    async (task) => {
      const { finding, context } = findingsWithContext[task.findingIdx]!;
      return castVote(finding, context, gt.findings);
    },
    CLASSIFY_CONCURRENCY,
  );

  // ── Step 2: Aggregate votes per finding ──
  const classifications: (FindingClassification & { _agreement: number })[] = [];
  for (let fi = 0; fi < findingsWithContext.length; fi++) {
    const { finding } = findingsWithContext[fi]!;
    const rawVotes: (ClassificationVote | null)[] = [];
    for (let vi = 0; vi < VOTES_PER_FINDING; vi++) {
      rawVotes.push(voteResults[fi * VOTES_PER_FINDING + vi]!);
    }

    const result = computeMajority(rawVotes);
    result.findingIndex = finding.index;
    result.findingTitle = finding.title;
    classifications.push(result);

    const tag =
      result.category === 'matched'
        ? `→ ${result.matchedGtId} (${result.agreement})`
        : `→ ${result.category.toUpperCase()} (${result.agreement})`;
    log.live(`    #${finding.index} ${finding.title.slice(0, 45)} ${tag}`);
  }

  // ── Step 3: Dedup GT matches (highest agreement wins) ──
  const gtWinners = new Map<string, number>(); // gtId → index in classifications
  for (let i = 0; i < classifications.length; i++) {
    const cls = classifications[i]!;
    if (cls.category !== 'matched' || !cls.matchedGtId) continue;

    const existingIdx = gtWinners.get(cls.matchedGtId);
    if (existingIdx === undefined) {
      gtWinners.set(cls.matchedGtId, i);
    } else {
      const existing = classifications[existingIdx]!;
      // Higher agreement wins; if tied, higher index (earlier = first-found, keep it)
      if (cls._agreement > existing._agreement) {
        // Demote existing
        existing.category = 'uncertain';
        existing.matchedGtId = null;
        existing.reasoning = `Duplicate GT match for ${cls.matchedGtId} — demoted (${existing.agreement}). ${existing.reasoning}`;
        log.warn(`    Dedup: #${existing.findingIndex} demoted (dup ${cls.matchedGtId})`);
        gtWinners.set(cls.matchedGtId, i);
      } else {
        // Demote current
        cls.category = 'uncertain';
        cls.matchedGtId = null;
        cls.reasoning = `Duplicate GT match for ${classifications[existingIdx]!.matchedGtId} — demoted. ${cls.reasoning}`;
        log.warn(`    Dedup: #${cls.findingIndex} demoted (dup ${classifications[existingIdx]!.matchedGtId})`);
      }
    }
  }

  // Strip internal _agreement field
  const finalClassifications: FindingClassification[] = classifications.map(
    ({ _agreement, ...rest }) => rest,
  );

  const runClass: RunClassification = {
    runId,
    codebaseId: meta.codebaseId,
    conditionId: meta.conditionId,
    classifiedAt: new Date().toISOString(),
    classifierModel: CLASSIFIER_MODEL,
    gtHash,
    stdoutHash,
    promptHash: PROMPT_HASH,
    votesPerFinding: VOTES_PER_FINDING,
    classifications: finalClassifications,
  };

  fs.writeFileSync(classPath, JSON.stringify(runClass, null, 2));

  // Summary
  const matched = finalClassifications.filter((c) => c.category === 'matched').length;
  const novel = finalClassifications.filter((c) => c.category === 'novel').length;
  const fp = finalClassifications.filter((c) => c.category === 'fp').length;
  const uncertain = finalClassifications.filter((c) => c.category === 'uncertain').length;
  log.success(
    `  Done: ${matched} matched, ${novel} novel, ${fp} FP, ${uncertain} uncertain`,
  );

  return runClass;
}

// ─── Classify all runs ───

export async function classifyAllRuns(
  resultsDir: string,
  options: ClassifyOptions = {},
): Promise<RunClassification[]> {
  const metaFiles = fs.readdirSync(resultsDir).filter((f) => f.endsWith('.meta.json'));

  // Group by codebase
  const byCodebase = new Map<string, string[]>();
  for (const file of metaFiles) {
    const meta: RunMeta = JSON.parse(
      fs.readFileSync(path.join(resultsDir, file), 'utf8'),
    );
    if (meta.exitCode !== 0 && meta.exitCode !== 143) continue;
    const arr = byCodebase.get(meta.codebaseId) ?? [];
    arr.push(meta.runId);
    byCodebase.set(meta.codebaseId, arr);
  }

  const allResults: RunClassification[] = [];

  for (const [codebaseId, runIds] of byCodebase) {
    const gt = loadGroundTruth(codebaseId);
    if (!gt) {
      log.info(`No ground truth for ${codebaseId} — skipping classification`);
      continue;
    }

    log.info(
      `Classifying ${runIds.length} run(s) for ${codebaseId} (${gt.findings.length} GT entries)`,
    );

    for (const runId of runIds) {
      const result = await classifyRun(runId, resultsDir, gt, options);
      if (result) allResults.push(result);
    }
  }

  const totalFindings = allResults.reduce(
    (sum, r) => sum + r.classifications.length,
    0,
  );
  log.success(`Classification complete — ${totalFindings} findings classified`);

  return allResults;
}
