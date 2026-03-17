export interface CodebaseConfig {
  id: string;
  path: string;
  gitCommit?: string;
}

export type ConditionType = 'bare' | 'skill';

export interface BareConditionConfig {
  id: string;
  type: 'bare';
  prompt: string;
}

export interface SkillConditionConfig {
  id: string;
  type: 'skill';
  skillVersion: string;
  command: string;
  deep?: boolean;
  fileOutput?: boolean;
}

export type ConditionConfig = BareConditionConfig | SkillConditionConfig;

export interface BenchConfig {
  codebases: CodebaseConfig[];
  conditions: ConditionConfig[];
  defaultRunsPerCondition: number;
}

export interface RunMeta {
  runId: string;
  codebaseId: string;
  conditionId: string;
  iteration: number;
  timestampUtc: string;
  codebaseGitCommit?: string;
  skillVersion?: string;
  skillGitCommit?: string;
  mode: 'bare' | 'skill';
  deep?: boolean;
  fileOutput?: boolean;
  claudeModel?: string;
  claudeCliVersion?: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
}

export interface CliOptions {
  configPath: string;
  runsOverride?: number;
  codebaseFilter?: string[];
  conditionFilter?: string[];
  dryRun: boolean;
  parallel: boolean;
  model?: string;
}

// ─── Ground Truth ───

export interface GTFinding {
  id: string;
  severity?: string;
  title?: string;
  rootCause?: string;
  location?: string;
  line?: number;
  description: string;
  judgeVerdict?: string;
}

export interface GroundTruth {
  codebaseId: string;
  source?: string;
  reportUrl?: string;
  description?: string;
  findings: GTFinding[];
}

// ─── Classification (simplified — majority vote) ───

/** Single vote from one classification attempt. */
export interface ClassificationVote {
  category: 'matched' | 'novel' | 'fp';
  matchedGtId: string | null;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

/** Aggregated classification for one finding after majority vote. */
export interface FindingClassification {
  findingIndex: number;
  findingTitle: string;
  /** Final category after majority vote. */
  category: 'matched' | 'novel' | 'fp' | 'uncertain';
  /** Matched GT entry ID (only when category=matched). */
  matchedGtId: string | null;
  /** Agreement level: how many votes agreed. '1/1' = single vote mode. */
  agreement: string;
  /** Human-readable reasoning (from the majority vote). */
  reasoning: string;
  /** Raw votes for auditability. */
  votes: ClassificationVote[];
}

export interface RunClassification {
  runId: string;
  codebaseId: string;
  conditionId: string;
  classifiedAt: string;
  classifierModel: string;
  /** SHA-256 of GT content (for cache invalidation). 'none' if no GT. */
  gtHash: string;
  /** SHA-256 of stdout content (for cache invalidation). */
  stdoutHash: string;
  /** SHA-256 of classification prompt template (invalidates cache on prompt changes). */
  promptHash?: string;
  /** Number of votes cast per finding (1 = fast, 3 = reliable). For reproducibility. */
  votesPerFinding?: number;
  classifications: FindingClassification[];
}

// ─── Novel Clustering ───

export interface NovelCluster {
  clusterId: string;
  title: string;
  reasoning: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'unknown';
  /** Which runs/conditions found findings in this cluster. */
  foundIn: Array<{
    runId: string;
    conditionId: string;
    findingIndex: number;
    findingTitle: string;
  }>;
  /** Unique condition IDs that found this bug. */
  conditionsCaught: string[];
  /** Source files relevant to this cluster (populated when scopeFiles is enabled). */
  relevantFiles?: string[];
}

export interface ClusterResult {
  codebaseId: string;
  clusteredAt: string;
  clusterModel: string;
  /** SHA-256 of serialized cluster inputs (for cache invalidation). */
  inputHash?: string;
  clusters: NovelCluster[];
  totalFindings: number;
  uniqueBugs: number;
}

// ─── Cluster Validation ───

export type RiskCategory = 'centralization-risk' | 'informational';

export interface ClusterValidation {
  clusterId: string;
  title: string;
  verdict: 'confirmed' | 'plausible' | 'rejected';
  severity: 'critical' | 'high' | 'medium' | 'low';
  reasoning: string;
  codeEvidence?: string;
  /** Risk category for filtering. Absent = real vulnerability (default). */
  riskCategory?: RiskCategory;
}

export interface ValidationResult {
  codebaseId: string;
  validatedAt: string;
  validatorModel: string;
  /** SHA-256 of cluster file content (for cache invalidation). */
  clusterHash?: string;
  validations: ClusterValidation[];
  confirmed: number;
  plausible: number;
  rejected: number;
}

// ─── Metrics ───

export interface StatSummary {
  mean: number;
  std: number;
  min: number;
  max: number;
}

export interface RunMetrics {
  runId: string;
  codebaseId: string;
  conditionId: string;
  iteration: number;
  findingsCount: number;
  durationMs: number;
  costUsd: number | null;
  matched: number | null;
  novel: number | null;
  fp: number | null;
  uncertain: number | null;
  recall: number | null;
  precision: number | null;
  f1: number | null;
  recallBySeverity: Record<string, { matched: number; total: number; rate: number }> | null;
  parserCoverage: number | null;
}

export interface ConditionAggregateMetrics {
  conditionId: string;
  codebaseId: string;
  runCount: number;
  recall: StatSummary | null;
  precision: StatSummary | null;
  f1: StatSummary | null;
  findingsCount: StatSummary;
  durationMs: StatSummary;
  costUsd: StatSummary | null;
  /** Jaccard similarity of matched GT IDs across runs. */
  consistency: number | null;
  uniqueNovelBugs: number | null;
}
