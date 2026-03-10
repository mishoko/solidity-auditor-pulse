/**
 * Extracts findings from audit stdout files (skill structured or bare free-form).
 * Normalizes each finding to a root-cause key for cross-run comparison.
 */

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
}

export interface ParseResult {
  findings: ParsedFinding[];
  /** Number of findings reported in the summary/list table (for validation) */
  reportedCount: number | null;
  format: 'skill' | 'bare' | 'unknown';
}

// --- Skill format parsing ---
// Pattern: [confidence] **N. Title**
const SKILL_FINDING_RE = /^\[(\d+)\]\s+\*\*(\d+)\.\s+(.+?)\*\*/;
// Pattern: `Contract.function` · Confidence: N
const SKILL_LOCATION_RE = /^`([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)`\s+·/;
// Findings List table row: | N | [confidence] | Title |
const SKILL_TABLE_ROW_RE = /^\|\s*(\d+)\s*\|\s*\[(\d+)\]\s*\|\s*(.+?)\s*\|/;

// --- Bare format parsing ---
// Pattern: ##+ [SEVERITY] Title — Location (bare Claude uses variable header levels)
const BARE_FINDING_RE = /^#{2,4}\s+\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\s+(.+?)(?:\s+—\s+(.+))?$/i;

// --- Root cause normalization ---
const VULN_KEYWORDS: [RegExp, string][] = [
  [/reentranc/i, 'reentrancy'],
  [/access.?control|missing.?(?:access|owner|auth)|unrestricted|unprotected|(?:anyone|any\s+user).*can/i, 'access-control'],
  [/unchecked.{0,3}(?:return|send|call)|silent.*(?:fail|fund|loss)/i, 'unchecked-return'],
  [/tx\.origin|phishing/i, 'tx-origin'],
  [/overflow|underflow/i, 'overflow'],
  [/front.?run|sandwich|mev/i, 'frontrunning'],
  [/dos|denial.?of.?service/i, 'dos'],
  [/flash.?loan/i, 'flash-loan'],
  [/oracle|price.?manipul/i, 'oracle-manipulation'],
  [/delegatecall/i, 'delegatecall'],
  [/selfdestruct/i, 'selfdestruct'],
  [/integer/i, 'integer-issue'],
];

function extractLocation(title: string, explicitLoc: string | null): string | null {
  // Try to extract Contract.function from title first (most precise)
  // Matches "Vault.withdraw()" or "TokenSale.setPrice"
  const dotMatch = title.match(/\b([A-Z]\w+)\.(\w+)/);
  if (dotMatch) return `${dotMatch[1]}.${dotMatch[2]}`;

  // Extract contract name from explicit location (e.g. "Vault.sol:14-21")
  let contract: string | null = null;
  if (explicitLoc) {
    const m = explicitLoc.match(/`?(\w+)\.sol/);
    if (m) contract = m[1];
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
  if (inMatch) return inMatch[1];

  return null;
}

function classifyVuln(title: string): string {
  for (const [re, label] of VULN_KEYWORDS) {
    if (re.test(title)) return label;
  }
  return 'other';
}

function makeRootCause(title: string, location: string | null): string {
  const vuln = classifyVuln(title);
  // Use contract name only (not function) for root cause matching.
  // Function names differ between formats (e.g. bare says "send()" for unchecked-return
  // in withdrawUnsafe, while skill says "withdrawUnsafe"). Contract + vuln type is stable.
  let contract = 'unknown';
  if (location) {
    const parts = location.split('.');
    contract = parts[0].toLowerCase();
  }
  return `${contract}::${vuln}`;
}

export function parseOutput(text: string): ParseResult {
  const lines = text.split('\n');

  // Detect format
  const hasSkillHeader = text.includes('🔐 Security Review') || text.includes('## Scope');
  const hasBareHeader = /^#{2,4}\s+\[(CRITICAL|HIGH|MEDIUM|LOW)/im.test(text);

  if (hasSkillHeader) return parseSkillFormat(lines);
  if (hasBareHeader) return parseBareFormat(lines);

  // Try skill first, fallback to bare
  const skillResult = parseSkillFormat(lines);
  if (skillResult.findings.length > 0) return skillResult;
  const bareResult = parseBareFormat(lines);
  if (bareResult.findings.length > 0) return bareResult;

  return { findings: [], reportedCount: null, format: 'unknown' };
}

function parseSkillFormat(lines: string[]): ParseResult {
  const findings: ParsedFinding[] = [];
  let reportedCount: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Match finding header: [100] **1. Title**
    const m = SKILL_FINDING_RE.exec(line);
    if (m) {
      const confidence = parseInt(m[1], 10);
      const index = parseInt(m[2], 10);
      const title = m[3].trim();

      // Look for location on next non-empty line
      let location: string | null = null;
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const locMatch = SKILL_LOCATION_RE.exec(lines[j].trim());
        if (locMatch) {
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
      });
    }

    // Count rows in Findings List table for validation
    const tableMatch = SKILL_TABLE_ROW_RE.exec(line);
    if (tableMatch) {
      const rowNum = parseInt(tableMatch[1], 10);
      if (reportedCount === null || rowNum > reportedCount) {
        reportedCount = rowNum;
      }
    }
  }

  return { findings, reportedCount, format: 'skill' };
}

function parseBareFormat(lines: string[]): ParseResult {
  const findings: ParsedFinding[] = [];
  let index = 0;
  let reportedCount: number | null = null;

  // Track current ## Contract.sol section to infer contract name
  let currentContract: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Track section headers: ##+ Vault.sol, ##+ TokenSale.sol
    const sectionMatch = line.match(/^#{2,4}\s+(\w+)\.sol\s*$/);
    if (sectionMatch) {
      currentContract = sectionMatch[1];
      continue;
    }

    const m = BARE_FINDING_RE.exec(line);
    if (m) {
      index++;
      const severity = m[1].toUpperCase();
      const title = m[2].trim();
      const locStr = m[3] || null;

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
      });
    }

    // Count summary table rows. Two formats:
    // 1. Aggregated: | Critical | 2 | ... |
    // 2. Per-finding: | Critical | Contract | Issue | ... |
    const summaryAgg = line.match(/^\|\s*(Critical|High|Medium|Low|Info)\s*\|\s*(\d+)\s*\|/i);
    if (summaryAgg) {
      const count = parseInt(summaryAgg[2], 10);
      reportedCount = (reportedCount ?? 0) + count;
    } else {
      const summaryRow = line.match(/^\|\s*(Critical|High|Medium|Low|Info)\s*\|/i);
      if (summaryRow) {
        reportedCount = (reportedCount ?? 0) + 1;
      }
    }
  }

  return { findings, reportedCount, format: 'bare' };
}
