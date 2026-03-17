/**
 * Extracts findings from audit stdout files (skill structured or bare free-form).
 * Normalizes each finding to a root-cause key for cross-run comparison.
 *
 * Root cause design:
 *   - Primary key: full location (contract.function) — maximally specific, never merges
 *     distinct findings silently.
 *   - Cross-condition matching: two conditions reporting a bug at the same contract.function
 *     will naturally match. If they describe it differently, they show as separate rows —
 *     this is the SAFE failure mode (visible duplication > silent loss).
 *   - Ground truth matching: separate flexible logic (vuln keyword + contract) in summary.ts,
 *     decoupled from display root cause.
 */

import { z } from 'zod';

export interface ParsedFinding {
  /** Sequential number in the report */
  index: number;
  /** Original title as written */
  title: string;
  /** Confidence score (skill format) or null (bare format) */
  confidence: number | null;
  /** Severity label (bare format) or null (skill format) */
  severity: string | null;
  /** Contract.function reference, e.g. "Vault.withdraw" */
  location: string | null;
  /** Normalized root-cause key for cross-run matching */
  rootCause: string;
  /** Vulnerability classification from title keywords */
  vulnType: string;
  /** Body text following the finding header (truncated to ~300 chars). Used for clustering context. */
  description: string;
  /** True if this finding was recovered from unmatched blocks via LLM fallback */
  recovered?: boolean;
}

export interface ParseResult {
  findings: ParsedFinding[];
  /** Number of findings reported in the summary/list table (for validation) */
  reportedCount: number | null;
  format: 'skill' | 'bare' | 'unknown';
  /** Heuristic estimate of total findings in the raw output (for coverage measurement) */
  rawFindingEstimate: number;
  /** Text blocks that look like findings but were not captured by the parser */
  unmatchedBlocks: string[];
}

// --- Skill format parsing ---
// Pattern: [confidence] **N. Title**
const SKILL_FINDING_RE = /^\[(\d+)\]\s+\*\*(\d+)\.\s+(.+?)\*\*/;
// Pattern: `Contract.function` · Confidence: N
const SKILL_LOCATION_RE = /^`([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)`\s+·/;
// Findings List table row: | N | [confidence] | Title |
const SKILL_TABLE_ROW_RE = /^\|\s*(\d+)\s*\|\s*\[(\d+)\]\s*\|\s*(.+?)\s*\|/;

// --- Bare format parsing ---
// Pattern 1: ##+ [SEVERITY] Title — Location (bare Claude uses variable header levels)
const BARE_FINDING_RE = /^#{2,4}\s+\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\s+(.+?)(?:\s+—\s+(.+))?$/i;
// Pattern 2: ### H-1: Title, ### C-1. Title (numbered severity prefix, colon or dot separator)
const BARE_NUMBERED_RE = /^#{2,4}\s+(C|H|M|L|I)-\d+[.:]\s+(.+?)(?:\s+—\s+(.+))?$/i;
// Pattern 2b: ### [H-1] Title (numbered severity prefix, bracketed)
const BARE_BRACKETED_NUM_RE = /^#{2,4}\s+\[(C|H|M|L|I)-\d+\]\s+(.+?)(?:\s+—\s+(.+))?$/i;
// Pattern 3: ### N. Title — **SEVERITY** (numbered with trailing bold severity)
const BARE_TRAILING_SEV_RE = /^#{2,4}\s+\d+\.\s+(.+?)\s+—\s+\*\*(CRITICAL|HIGH|MEDIUM|LOW|INFO)\*\*$/i;
// Pattern 4: ### N. Title (SEVERITY) (numbered with parenthesized severity)
const BARE_PAREN_SEV_RE = /^#{2,4}\s+\d+\.\s+(.+?)\s+\((Critical|High|Medium|Low|Info)\)\s*$/i;
// Pattern 5: **N. [SEVERITY] Title — Location** — bold inline (no heading, severity in brackets)
const BARE_BOLD_INLINE_RE = /^\*\*\d+\.\s+\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\s+(.+?)(?:\s+—\s+(.+?))?\*\*\s*$/i;
// Pattern 6: ### N. Title (plain numbered, severity inherited from section header like ## High Severity)
const BARE_SECTION_NUMBERED_RE = /^#{2,4}\s+\d+\.\s+(.+?)$/i;
// Section header pattern for severity inheritance
const SEVERITY_SECTION_RE = /^#{1,3}\s+(?:(Critical)(?:\s*\/?\s*High)?|(High)|(Medium)|(Low)|(Informational|Info))\s+Severity/i;

// --- Vulnerability classification (used for ground truth matching, not for root cause key) ---
const VULN_KEYWORDS: [RegExp, string][] = [
  [/reentranc/i, 'reentrancy'],
  [/access.?control|missing.?(?:access|owner|auth)|unrestricted|unprotected|(?:anyone|any\s+user).*can/i, 'access-control'],
  [/unchecked.{0,3}(?:return|send|call)|silent.*(?:fail|fund|loss)/i, 'unchecked-return'],
  [/tx\.origin|phishing/i, 'tx-origin'],
  [/overflow|underflow|truncat/i, 'overflow'],
  [/front.?run|sandwich|mev/i, 'frontrunning'],
  [/dos|denial.?of.?service/i, 'dos'],
  [/flash.?loan/i, 'flash-loan'],
  [/oracle|price.?manipul/i, 'oracle-manipulation'],
  [/delegatecall/i, 'delegatecall'],
  [/selfdestruct/i, 'selfdestruct'],
  [/integer/i, 'integer-issue'],
];

export function classifyVuln(title: string): string {
  for (const [re, label] of VULN_KEYWORDS) {
    if (re.test(title)) return label;
  }
  return 'other';
}

function extractLocation(title: string, explicitLoc: string | null): string | null {
  // Try to extract Contract.function from title first (most precise)
  // Matches "Vault.withdraw()" or "TokenSale.setPrice"
  const dotMatch = title.match(/\b([A-Z]\w+)\.(\w+)/);
  if (dotMatch?.[1] && dotMatch[2]) return `${dotMatch[1]}.${dotMatch[2]}`;

  // Extract contract name from explicit location (e.g. "Vault.sol:14-21")
  let contract: string | null = null;
  if (explicitLoc) {
    const m = explicitLoc.match(/`?(\w+)\.sol/);
    if (m?.[1]) contract = m[1];
  }

  // Extract function name from title backticks (e.g. "Reentrancy in `withdraw()`")
  const funcMatch = title.match(/`(\w+)\(\)`/);
  const func = funcMatch?.[1] ?? null;

  // Combine contract + function if we have both
  if (contract && func) return `${contract}.${func}`;
  if (contract) return contract;
  if (func) return func;

  // Last resort: look for "on `functionName`" or "in `functionName`"
  const inMatch = title.match(/(?:in|on)\s+`(\w+)`/);
  if (inMatch?.[1]) return inMatch[1];

  return null;
}

/**
 * Extract ~300 chars of body text following a finding header.
 * Stops at the next finding header or section boundary.
 */
function extractDescription(lines: string[], startLine: number): string {
  const bodyLines: string[] = [];
  for (let j = startLine + 1; j < Math.min(startLine + 20, lines.length); j++) {
    const line = (lines[j] ?? '').trim();
    // Stop at next finding header or section boundary
    if (/^#{2,4}\s+/.test(line) || /^\[\d+\]\s+\*\*\d+\./.test(line) || /^\*\*\d+\.\s+\[/.test(line)) break;
    // Skip empty lines at the start
    if (bodyLines.length === 0 && line === '') continue;
    // Skip location lines (already captured separately)
    if (/^`[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*`\s+·/.test(line)) continue;
    if (line) bodyLines.push(line);
  }
  const raw = bodyLines.join(' ').replace(/```[\s\S]*?```/g, '').trim();
  return raw.length > 300 ? raw.slice(0, 297) + '...' : raw;
}

/**
 * Generates a stable slug from the title for use when location is unavailable.
 * Takes first few meaningful words, lowercased, hyphen-joined.
 */
function titleSlug(title: string): string {
  const words = title
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 4);
  return words.join('-') || 'unknown';
}

/**
 * Root cause key: maximally specific, never silently merges distinct findings.
 *
 * Format: "contract::function::vulntype"
 *   - Two different bugs at the same function (e.g. unchecked-return + access-control
 *     on withdrawUnsafe) get different keys.
 *   - Same bug reported by different conditions (same contract, function, vuln type)
 *     correctly merges into one row.
 *   - When function unknown: "contract::vulntype" or "contract::title-slug"
 *   - When location unknown: "unknown::title-slug"
 */
function makeRootCause(title: string, location: string | null): string {
  const vuln = classifyVuln(title);
  if (location) {
    const parts = location.split('.');
    const contract = (parts[0] ?? '').toLowerCase();
    const func = parts.length > 1 ? (parts[1] ?? '').toLowerCase() : null;
    if (func) return `${contract}::${func}::${vuln}`;
    if (vuln !== 'other') return `${contract}::${vuln}`;
    return `${contract}::${titleSlug(title)}`;
  }
  return `unknown::${titleSlug(title)}`;
}

/**
 * Heuristic estimate of how many findings exist in the raw output.
 * Uses broad patterns to catch findings the structured parser might miss.
 * Conservative: prefers underestimation to avoid false coverage warnings.
 */
function estimateRawFindings(text: string): number {
  const lines = text.split('\n');
  const candidates = new Set<number>(); // line numbers that look like finding starts

  // Skill format: [confidence] **N. Title**
  const skillCount = (text.match(/^\[\d+\]\s+\*\*\d+\.\s+/gm) ?? []).length;
  if (skillCount > 0) return skillCount;

  // Bare format: multiple heading patterns
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();

    // Skip non-heading lines
    if (!line.startsWith('#') && !line.startsWith('**')) continue;

    // Skip known section headers (not findings)
    if (/^#{1,3}\s+(Summary|Overview|Methodology|Scope|Appendix|Disclaimer|Conclusion|Recommendations|Table of Contents|Introduction|Findings?\s+Summary)/i.test(line)) continue;
    if (/^#{1,3}\s+(Critical|High|Medium|Low|Informational|Info)\s+(Severity|Risk|Issues?)\s*$/i.test(line)) continue;
    if (/^#{1,2}\s+\w+\.sol\s*$/i.test(line)) continue;

    // Finding-like headings
    if (
      /^#{2,4}\s+\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]/i.test(line) ||       // ### [HIGH] Title
      /^#{2,4}\s+(C|H|M|L|I)-\d+/i.test(line) ||                          // ### H-1: Title
      /^#{2,4}\s+\[(C|H|M|L|I)-\d+\]/i.test(line) ||                      // ### [H-1] Title
      /^#{2,4}\s+\d+\.\s+.+?\s+—\s+\*\*(CRITICAL|HIGH|MEDIUM|LOW)/i.test(line) || // ### 1. Title — **HIGH**
      /^#{2,4}\s+\d+\.\s+.+?\s+\((Critical|High|Medium|Low)/i.test(line) || // ### 1. Title (High)
      /^\*\*\d+\.\s+\[(CRITICAL|HIGH|MEDIUM|LOW)/i.test(line)               // **1. [HIGH] Title**
    ) {
      candidates.add(i);
      continue;
    }

    // Numbered headings under a severity section (### N. Title)
    if (/^#{2,4}\s+\d+\.\s+\S/.test(line)) {
      // Only count if there's a severity section nearby above
      let hasSevSection = false;
      for (let j = i - 1; j >= Math.max(0, i - 20); j--) {
        if (/^#{1,3}\s+(Critical|High|Medium|Low|Informational|Info)\s+(Severity|Risk)/i.test((lines[j] ?? '').trim())) {
          hasSevSection = true;
          break;
        }
      }
      if (hasSevSection) {
        candidates.add(i);
      }
    }
  }

  return candidates.size;
}

// --- Section headers that are NOT findings ---
const SECTION_HEADER_RE = /^(Summary|Overview|Methodology|Scope|Appendix|Disclaimer|Conclusion|Recommendations|Table of Contents|Introduction|Findings?\s+Summary|Detailed\s+Findings|Audit\s+Report|Security\s+Assessment|Executive|References|Severity\s+Classification|Risk\s+Rating)/i;

// --- Vulnerability-related keywords that suggest a finding ---
const VULN_SIGNAL_WORDS = /\b(vulnerab|attack|exploit|risk|impact|severity|reentrancy|reentrant|overflow|underflow|access\s*control|unauthorized|unchecked|front.?run|sandwich|mev|flash.?loan|oracle|manipulation|delegatecall|selfdestruct|dos|denial|phishing|tx\.origin|slippage|liquidat|privilege|escala|bypass|inject|drain|steal|siphon|lock|freeze|grief|censor|int(eger)?.*overflow|critical|high|medium|low)\b/i;

/**
 * Identifies text blocks that look like findings but weren't captured by the parser.
 * Returns the first 3 lines of each unmatched block, capped at 10 blocks.
 */
export function extractUnmatchedBlocks(text: string, parsedFindings: ParsedFinding[]): string[] {
  const lines = text.split('\n');
  const unmatched: string[] = [];

  // Build set of parsed finding title words for overlap matching
  const parsedTitleWords: Set<string>[] = parsedFindings.map(f => {
    const words = f.title
      .toLowerCase()
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2);
    return new Set(words);
  });

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();

    // Must start with a heading (##, ###, ####) or bold pattern (**N.)
    const isHeading = /^#{2,4}\s+\S/.test(line);
    const isBoldNumbered = /^\*\*\d+\.\s+/.test(line);
    if (!isHeading && !isBoldNumbered) continue;

    // Extract the heading text (strip markdown syntax)
    let headingText = line;
    if (isHeading) {
      headingText = line.replace(/^#{2,4}\s+/, '');
    } else {
      headingText = line.replace(/^\*\*/, '').replace(/\*\*\s*$/, '');
    }

    // Skip known section headers
    if (SECTION_HEADER_RE.test(headingText)) continue;

    // Skip severity section headers (e.g. "## High Severity")
    if (/^(Critical|High|Medium|Low|Informational|Info)\s+(Severity|Risk|Issues?)\s*$/i.test(headingText)) continue;

    // Skip file headers (e.g. "## Vault.sol")
    if (/^\w+\.sol\s*$/i.test(headingText)) continue;

    // Check if this block contains vulnerability-related keywords
    // Look at the heading itself + next few lines (up to next heading or 10 lines)
    let blockText = line;
    const blockEndIdx = Math.min(i + 10, lines.length);
    for (let j = i + 1; j < blockEndIdx; j++) {
      const nextLine = (lines[j] ?? '').trim();
      if (/^#{1,4}\s+/.test(nextLine) || /^\*\*\d+\./.test(nextLine)) break;
      blockText += ' ' + nextLine;
    }

    if (!VULN_SIGNAL_WORDS.test(blockText)) continue;

    // Check if this block was already matched by the parser (word overlap)
    const blockWords = headingText
      .toLowerCase()
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2);

    let alreadyMatched = false;
    for (const titleWords of parsedTitleWords) {
      let overlap = 0;
      for (const w of blockWords) {
        if (titleWords.has(w)) overlap++;
      }
      if (overlap >= 2) {
        alreadyMatched = true;
        break;
      }
    }
    if (alreadyMatched) continue;

    // Collect first 3 lines of this block
    const snippetLines: string[] = [];
    for (let j = i; j < Math.min(i + 3, lines.length); j++) {
      const snippetLine = (lines[j] ?? '').trim();
      if (j > i && (/^#{1,4}\s+/.test(snippetLine) || /^\*\*\d+\./.test(snippetLine))) break;
      if (snippetLine) snippetLines.push(snippetLine);
    }

    if (snippetLines.length > 0) {
      unmatched.push(snippetLines.join('\n'));
    }

    if (unmatched.length >= 10) break;
  }

  return unmatched;
}

export function parseOutput(text: string): ParseResult {
  const lines = text.split('\n');

  // Detect format
  const hasSkillHeader = text.includes('🔐 Security Review');
  const hasBareHeader = /^#{2,4}\s+\[(CRITICAL|HIGH|MEDIUM|LOW)/im.test(text)
    || /^#{2,4}\s+(H|M|L|I)-\d+[.:]/im.test(text)
    || /^#{2,4}\s+\[(H|M|L|I)-\d+\]/im.test(text)
    || /^#{2,4}\s+\d+\.\s+.+?\s+—\s+\*\*(CRITICAL|HIGH|MEDIUM|LOW|INFO)\*\*/im.test(text)
    || /^#{2,4}\s+\d+\.\s+.+?\s+\((Critical|High|Medium|Low|Info)\)/im.test(text)
    || (SEVERITY_SECTION_RE.test(text) && /^#{2,4}\s+\d+\.\s+/m.test(text));

  const estimate = estimateRawFindings(text);

  const finalize = (result: ParseResult): ParseResult => {
    result.rawFindingEstimate = Math.max(estimate, result.findings.length);
    result.unmatchedBlocks = extractUnmatchedBlocks(text, result.findings);
    return result;
  };

  if (hasSkillHeader) {
    return finalize(parseSkillFormat(lines));
  }
  if (hasBareHeader) {
    return finalize(parseBareFormat(lines));
  }

  // Try skill first, fallback to bare
  const skillResult = parseSkillFormat(lines);
  if (skillResult.findings.length > 0) {
    return finalize(skillResult);
  }
  const bareResult = parseBareFormat(lines);
  if (bareResult.findings.length > 0) {
    return finalize(bareResult);
  }

  return finalize({ findings: [], reportedCount: null, format: 'unknown', rawFindingEstimate: estimate, unmatchedBlocks: [] });
}

function parseSkillFormat(lines: string[]): ParseResult {
  const findings: ParsedFinding[] = [];
  let reportedCount: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();

    // Match finding header: [100] **1. Title**
    const m = SKILL_FINDING_RE.exec(line);
    if (m?.[1] && m[2] && m[3]) {
      const confidence = parseInt(m[1], 10);
      const index = parseInt(m[2], 10);
      const title = m[3].trim();

      // Look for location on next non-empty line
      let location: string | null = null;
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const locMatch = SKILL_LOCATION_RE.exec((lines[j] ?? '').trim());
        if (locMatch?.[1]) {
          location = locMatch[1];
          break;
        }
      }

      if (!location) location = extractLocation(title, null);

      findings.push({
        index,
        title,
        confidence,
        severity: null,
        location,
        rootCause: makeRootCause(title, location),
        vulnType: classifyVuln(title),
        description: extractDescription(lines, i),
      });
    }

    // Count rows in Findings List table for validation
    const tableMatch = SKILL_TABLE_ROW_RE.exec(line);
    if (tableMatch?.[1]) {
      const rowNum = parseInt(tableMatch[1], 10);
      if (reportedCount === null || rowNum > reportedCount) {
        reportedCount = rowNum;
      }
    }
  }

  return { findings, reportedCount, format: 'skill', rawFindingEstimate: 0, unmatchedBlocks: [] };
}

function parseBareFormat(lines: string[]): ParseResult {
  const findings: ParsedFinding[] = [];
  let index = 0;
  let reportedCount: number | null = null;

  // Track current ## Contract.sol section to infer contract name
  let currentContract: string | null = null;

  // Track current severity section (e.g. "## High Severity") for Pattern 6
  let currentSectionSeverity: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();

    // Track severity section headers: ## Critical / High Severity, ## Medium Severity, etc.
    const sevSectionMatch = SEVERITY_SECTION_RE.exec(line);
    if (sevSectionMatch) {
      const raw = (sevSectionMatch[1] ?? sevSectionMatch[2] ?? sevSectionMatch[3] ?? sevSectionMatch[4] ?? sevSectionMatch[5] ?? '').toUpperCase();
      if (raw === 'CRITICAL') currentSectionSeverity = 'HIGH'; // treat Critical as HIGH
      else currentSectionSeverity = raw;
      continue;
    }

    // Track section headers: ##+ Vault.sol, ##+ TokenSale.sol
    const sectionMatch = line.match(/^#{2,4}\s+(\w+)\.sol\s*$/);
    if (sectionMatch?.[1]) {
      currentContract = sectionMatch[1];
      continue;
    }

    // Reset section severity on non-severity ## headers (e.g. "## Summary", "## Informational")
    if (/^#{1,2}\s+(Summary|Appendix|Disclaimer)\b/i.test(line)) {
      currentSectionSeverity = null;
    }

    // Match bare finding headers across 7 format variants
    const sevWordMatch = BARE_FINDING_RE.exec(line);          // ### [CRITICAL] Title
    const sevPrefixMatch = sevWordMatch ? null : BARE_NUMBERED_RE.exec(line);     // ### H-1: Title
    const sevBracketMatch = (sevWordMatch || sevPrefixMatch) ? null : BARE_BRACKETED_NUM_RE.exec(line); // ### [H-1] Title
    const sevTrailingMatch = (sevWordMatch || sevPrefixMatch || sevBracketMatch) ? null : BARE_TRAILING_SEV_RE.exec(line); // ### 1. Title — **CRITICAL**
    const sevParenMatch = (sevWordMatch || sevPrefixMatch || sevBracketMatch || sevTrailingMatch) ? null : BARE_PAREN_SEV_RE.exec(line); // ### 1. Title (Critical)
    const sevBoldMatch = (sevWordMatch || sevPrefixMatch || sevBracketMatch || sevTrailingMatch || sevParenMatch) ? null : BARE_BOLD_INLINE_RE.exec(line); // **1. [CRITICAL] Title**
    // Pattern 6: ### N. Title (only when section severity is active, checked LAST)
    const sevSectionNumMatch = (sevWordMatch || sevPrefixMatch || sevBracketMatch || sevTrailingMatch || sevParenMatch || sevBoldMatch) ? null
      : (currentSectionSeverity ? BARE_SECTION_NUMBERED_RE.exec(line) : null);
    const bareMatch = sevWordMatch || sevPrefixMatch || sevBracketMatch || sevTrailingMatch || sevParenMatch || sevBoldMatch || sevSectionNumMatch;
    if (bareMatch) {
      index++;
      const sevLetterMap: Record<string, string> = { C: 'CRITICAL', H: 'HIGH', M: 'MEDIUM', L: 'LOW', I: 'INFO' };
      let severity: string;
      let title: string;
      let locStr: string | null;
      // Patterns 3 & 4: title in group 1, severity in group 2
      const trailOrParen = sevTrailingMatch ?? sevParenMatch;
      if (trailOrParen?.[1] && trailOrParen[2]) {
        title = trailOrParen[1].trim();
        severity = trailOrParen[2].toUpperCase();
        locStr = null;
      } else if (sevBoldMatch?.[1] && sevBoldMatch[2]) {
        // Pattern 5: **N. [SEVERITY] Title — Location** — severity in [1], title in [2], location in [3]
        severity = sevBoldMatch[1].toUpperCase();
        title = sevBoldMatch[2].trim();
        locStr = sevBoldMatch[3] ?? null;
      } else if (sevWordMatch?.[1] && sevWordMatch[2]) {
        severity = sevWordMatch[1].toUpperCase();
        title = sevWordMatch[2].trim();
        locStr = sevWordMatch[3] ?? null;
      } else if (sevSectionNumMatch?.[1]) {
        // Pattern 6: ### N. Title with severity from section header
        severity = currentSectionSeverity!;
        title = sevSectionNumMatch[1].trim();
        locStr = null;
      } else {
        const numbered = (sevPrefixMatch ?? sevBracketMatch)!;
        const sevLetter = numbered[1]?.toUpperCase() ?? '';
        severity = sevLetterMap[sevLetter] ?? sevLetter;
        title = (numbered[2] ?? '').trim();
        locStr = numbered[3] ?? null;
      }

      // Try to extract location from title, fall back to current section contract
      let location = extractLocation(title, locStr);
      if (location && !location.includes('.') && currentContract) {
        // We only got a function name — combine with current contract section
        location = `${currentContract}.${location}`;
      } else if (!location && currentContract) {
        location = currentContract;
      }

      findings.push({
        index,
        title,
        confidence: null,
        severity,
        location,
        rootCause: makeRootCause(title, location),
        vulnType: classifyVuln(title),
        description: extractDescription(lines, i),
      });
    }

    // Count summary table rows. Two formats:
    // 1. Aggregated: | Critical | 2 | ... |
    // 2. Per-finding: | Critical | Contract | Issue | ... |
    const summaryAgg = line.match(/^\|\s*(Critical|High|Medium|Low|Info)\s*\|\s*(\d+)\s*\|/i);
    const aggCountStr = summaryAgg?.[2];
    if (aggCountStr) {
      const count = parseInt(aggCountStr, 10);
      reportedCount = (reportedCount ?? 0) + count;
    } else {
      const summaryRow = line.match(/^\|\s*(Critical|High|Medium|Low|Info)\s*\|/i);
      if (summaryRow) {
        reportedCount = (reportedCount ?? 0) + 1;
      }
    }
  }

  return { findings, reportedCount, format: 'bare', rawFindingEstimate: 0, unmatchedBlocks: [] };
}

// --- LLM fallback recovery for unmatched blocks ---

const RECOVERY_MODEL = process.env.RECOVERY_PARSER_MODEL || 'claude-sonnet-4-20250514';
const RECOVERY_TIMEOUT = parseInt(process.env.RECOVERY_PARSER_TIMEOUT_MS || '') || 60_000;

const RecoveredFindingSchema = z.object({
  title: z.string(),
  severity: z.string().nullable(),
  location: z.string().nullable(),
  vulnerabilityType: z.string(),
  description: z.string(),
});

const RecoveredArraySchema = z.array(RecoveredFindingSchema);

/**
 * Use an LLM call to extract structured findings from text blocks
 * that the regex parser could not handle.
 *
 * Uses the shared LLMProvider (callLLM) — testable with FakeLLMProvider.
 */
export async function recoverUnmatchedFindings(
  unmatchedBlocks: string[],
  startIndex: number,
): Promise<ParsedFinding[]> {
  if (unmatchedBlocks.length === 0) return [];

  // Lazy import to avoid circular dependency (parser is used by classify, which uses llm)
  const { callLLM } = await import('../classifier/llm.js');

  const blocksText = unmatchedBlocks.map((b, i) => `[Block ${i + 1}]\n${b}`).join('\n\n');

  const prompt = `You are a smart contract security finding parser. Below are text blocks from a security audit report that could not be parsed by a regex parser. Extract each distinct vulnerability finding.

${blocksText}

For each finding, return a JSON object with:
- "title": concise finding title
- "severity": one of "CRITICAL", "HIGH", "MEDIUM", "LOW", or null if unknown
- "location": "Contract.function" format if identifiable, or null
- "vulnerabilityType": category (e.g. "reentrancy", "access-control", "overflow")
- "description": one-sentence summary

Respond with ONLY a JSON array (no other text). If a block is not actually a vulnerability finding, skip it.`;

  try {
    const raw = await callLLM(prompt, {
      model: RECOVERY_MODEL,
      timeout: RECOVERY_TIMEOUT,
      schema: RecoveredArraySchema,
      jsonShape: 'array',
      retries: 1,
    });

    return raw.map((r, i) => {
      const location = r.location || 'Unknown';
      return {
        index: startIndex + i,
        title: r.title,
        confidence: null,
        severity: r.severity || null,
        location,
        rootCause: `${location}::${(r.vulnerabilityType || 'unknown').toLowerCase().replace(/\s+/g, '-')}`,
        vulnType: r.vulnerabilityType || 'unknown',
        description: r.description || '',
        recovered: true,
      };
    });
  } catch {
    return [];
  }
}
