import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { BenchConfig } from '../shared/types.js';

const CodebaseSchema = z.object({
  id: z.string(),
  path: z.string(),
  gitCommit: z.string().optional(),
});

const BareConditionSchema = z.object({
  id: z.string(),
  type: z.literal('bare'),
  prompt: z.string(),
});

const SkillConditionSchema = z.object({
  id: z.string(),
  type: z.literal('skill'),
  skillVersion: z.string(),
  command: z.string(),
  deep: z.boolean().optional(),
  fileOutput: z.boolean().optional(),
});

const ConditionSchema = z.discriminatedUnion('type', [
  BareConditionSchema,
  SkillConditionSchema,
]);

const BenchConfigSchema = z.object({
  codebases: z.array(CodebaseSchema).min(1),
  conditions: z.array(ConditionSchema).min(1),
  defaultRunsPerCondition: z.number().int().min(1),
});

export function loadConfig(configPath: string): BenchConfig {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  return BenchConfigSchema.parse(raw);
}
