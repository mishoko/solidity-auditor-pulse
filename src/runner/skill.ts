import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();

export function skillSrcPath(skillVersion: string): string {
  const p = path.join(ROOT, 'skills_versions', skillVersion, 'solidity-auditor');
  if (!fs.existsSync(p)) {
    throw new Error(
      `Skill version not found: ${p}\n` +
      `Expected directory: skills_versions/${skillVersion}/solidity-auditor/`
    );
  }
  return p;
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
