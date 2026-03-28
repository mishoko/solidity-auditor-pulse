import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();

/**
 * Returns the path to the skill source directory inside skills_versions/<version>/.
 * Auto-detects the skill directory name by finding the subdirectory containing SKILL.md.
 */
export function skillSrcPath(skillVersion: string): string {
  const versionDir = path.join(ROOT, 'skills_versions', skillVersion);
  if (!fs.existsSync(versionDir)) {
    throw new Error(`Skill version directory not found: ${versionDir}`);
  }
  const entries = fs.readdirSync(versionDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const candidate = path.join(versionDir, entry.name, 'SKILL.md');
      if (fs.existsSync(candidate)) {
        return path.join(versionDir, entry.name);
      }
    }
  }
  throw new Error(
    `No skill found in skills_versions/${skillVersion}/. ` +
    `Expected a subdirectory containing SKILL.md.`
  );
}

/** Returns the skill directory name (e.g. 'solidity-auditor', 'contract-auditor'). */
export function skillDirName(skillVersion: string): string {
  return path.basename(skillSrcPath(skillVersion));
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
