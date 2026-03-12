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
