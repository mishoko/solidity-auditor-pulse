import * as crypto from 'node:crypto';

/** SHA-256 truncated to 16 hex chars. Used as cache key across pipeline phases. */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}
