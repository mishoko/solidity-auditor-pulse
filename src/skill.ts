import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSimple } from './util/shell.js';
import { workspacePath } from './workspace.js';
import type { SkillConditionConfig } from './types.js';
import * as log from './util/logger.js';

const ROOT = process.cwd();

export async function setupSkillForRun(runId: string, condition: SkillConditionConfig): Promise<void> {
  const skillSrc = path.join(ROOT, 'skills_versions', condition.skillVersion, 'solidity-auditor');
  if (!fs.existsSync(skillSrc)) {
    throw new Error(
      `Skill version not found: ${skillSrc}\n` +
      `Expected directory: skills_versions/${condition.skillVersion}/solidity-auditor/`
    );
  }

  const commandsDir = path.join(workspacePath(runId), '.claude', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });

  // Copy skill into project-local .claude/commands so Claude picks it up
  const dest = path.join(commandsDir, 'solidity-auditor');
  await execSimple(`cp -R "${skillSrc}" "${dest}"`);

  log.info(`Skill ${condition.skillVersion} installed at .claude/commands/solidity-auditor`);
}

export async function resolveSkillGitCommit(skillVersion: string): Promise<string | undefined> {
  const sourceJson = path.join(ROOT, 'skills_versions', skillVersion, 'source.json');
  try {
    const data = JSON.parse(fs.readFileSync(sourceJson, 'utf8'));
    return data.commit;
  } catch {
    return undefined;
  }
}
