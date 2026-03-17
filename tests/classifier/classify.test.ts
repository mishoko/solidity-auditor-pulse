import { describe, it, expect } from 'vitest';
import { computeMajority } from '../../src/classifier/classify.js';
import { hashContent } from '../../src/shared/util/hash.js';
import type { ClassificationVote } from '../../src/shared/types.js';

// ─── Helpers ───

function vote(
  category: 'matched' | 'novel' | 'fp',
  matchedGtId: string | null = null,
): ClassificationVote {
  return {
    category,
    matchedGtId,
    confidence: 'high',
    reasoning: `Test vote: ${category}`,
  };
}

// ─── computeMajority ───

describe('computeMajority', () => {
  // ── Single vote mode (CLASSIFY_VOTES=1) ──

  describe('single vote (1/1)', () => {
    it('returns the vote directly', () => {
      const result = computeMajority([vote('matched', 'H-01')]);
      expect(result.category).toBe('matched');
      expect(result.matchedGtId).toBe('H-01');
      expect(result.agreement).toBe('1/1');
      expect(result._agreement).toBe(1);
    });

    it('handles novel vote', () => {
      const result = computeMajority([vote('novel')]);
      expect(result.category).toBe('novel');
      expect(result.matchedGtId).toBeNull();
      expect(result.agreement).toBe('1/1');
    });

    it('handles fp vote', () => {
      const result = computeMajority([vote('fp')]);
      expect(result.category).toBe('fp');
      expect(result.agreement).toBe('1/1');
    });
  });

  // ── Three vote mode (CLASSIFY_VOTES=3) ──

  describe('three votes — unanimous', () => {
    it('3/3 matched same GT', () => {
      const result = computeMajority([
        vote('matched', 'H-01'),
        vote('matched', 'H-01'),
        vote('matched', 'H-01'),
      ]);
      expect(result.category).toBe('matched');
      expect(result.matchedGtId).toBe('H-01');
      expect(result.agreement).toBe('3/3');
      expect(result._agreement).toBe(3);
    });

    it('3/3 novel', () => {
      const result = computeMajority([vote('novel'), vote('novel'), vote('novel')]);
      expect(result.category).toBe('novel');
      expect(result.agreement).toBe('3/3');
    });

    it('3/3 fp', () => {
      const result = computeMajority([vote('fp'), vote('fp'), vote('fp')]);
      expect(result.category).toBe('fp');
      expect(result.agreement).toBe('3/3');
    });
  });

  describe('three votes — majority', () => {
    it('2/3 matched + 1 novel → matched', () => {
      const result = computeMajority([
        vote('matched', 'H-01'),
        vote('matched', 'H-01'),
        vote('novel'),
      ]);
      expect(result.category).toBe('matched');
      expect(result.matchedGtId).toBe('H-01');
      expect(result.agreement).toBe('2/3');
      expect(result._agreement).toBe(2);
    });

    it('2/3 novel + 1 fp → novel', () => {
      const result = computeMajority([vote('novel'), vote('fp'), vote('novel')]);
      expect(result.category).toBe('novel');
      expect(result.agreement).toBe('2/3');
    });

    it('2/3 fp + 1 matched → fp', () => {
      const result = computeMajority([vote('fp'), vote('matched', 'M-01'), vote('fp')]);
      expect(result.category).toBe('fp');
      expect(result.agreement).toBe('2/3');
    });
  });

  describe('three votes — no majority (split)', () => {
    it('matched + novel + fp → uncertain', () => {
      const result = computeMajority([
        vote('matched', 'H-01'),
        vote('novel'),
        vote('fp'),
      ]);
      expect(result.category).toBe('uncertain');
      expect(result.matchedGtId).toBeNull();
      expect(result.agreement).toBe('no-majority');
    });

    it('matched H-01 + matched H-02 + novel → uncertain (different GT IDs = different vote keys)', () => {
      const result = computeMajority([
        vote('matched', 'H-01'),
        vote('matched', 'H-02'),
        vote('novel'),
      ]);
      expect(result.category).toBe('uncertain');
      expect(result.agreement).toBe('no-majority');
    });
  });

  // ── Failed votes ──

  describe('failed votes (null)', () => {
    it('all 3 votes failed → uncertain', () => {
      const result = computeMajority([null, null, null]);
      expect(result.category).toBe('uncertain');
      expect(result.agreement).toBe('no-majority');
      expect(result.votes).toHaveLength(0);
    });

    it('1 success + 2 failed → uses the single vote with 1/3 agreement', () => {
      const result = computeMajority([vote('novel'), null, null]);
      expect(result.category).toBe('novel');
      expect(result.agreement).toBe('1/3');
      expect(result._agreement).toBe(1);
    });

    it('2 success + 1 failed, majority → uses majority with 2/3', () => {
      const result = computeMajority([vote('fp'), null, vote('fp')]);
      expect(result.category).toBe('fp');
      expect(result.agreement).toBe('2/3');
    });

    it('2 success + 1 failed, no majority → uncertain', () => {
      const result = computeMajority([vote('novel'), null, vote('fp')]);
      expect(result.category).toBe('uncertain');
      expect(result.agreement).toBe('no-majority');
    });
  });

  // ── Dynamic vote counts (CLASSIFY_VOTES=5) ──

  describe('five votes (agreement labels are dynamic)', () => {
    it('5/5 unanimous → 5/5', () => {
      const result = computeMajority([
        vote('matched', 'H-01'),
        vote('matched', 'H-01'),
        vote('matched', 'H-01'),
        vote('matched', 'H-01'),
        vote('matched', 'H-01'),
      ]);
      expect(result.agreement).toBe('5/5');
      expect(result._agreement).toBe(5);
    });

    it('3/5 majority → 3/5', () => {
      const result = computeMajority([
        vote('novel'),
        vote('fp'),
        vote('novel'),
        vote('fp'),
        vote('novel'),
      ]);
      expect(result.category).toBe('novel');
      expect(result.agreement).toBe('3/5');
      expect(result._agreement).toBe(3);
    });

    it('4/5 with 1 failed → 4/5', () => {
      const result = computeMajority([
        vote('matched', 'M-01'),
        vote('matched', 'M-01'),
        null,
        vote('matched', 'M-01'),
        vote('matched', 'M-01'),
      ]);
      expect(result.agreement).toBe('4/5');
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('empty votes array → uncertain', () => {
      const result = computeMajority([]);
      expect(result.category).toBe('uncertain');
      expect(result.agreement).toBe('no-majority');
    });

    it('votes carry through to result', () => {
      const v1 = vote('novel');
      const v2 = vote('novel');
      const result = computeMajority([v1, v2, vote('fp')]);
      expect(result.votes).toHaveLength(3);
    });

    it('matched votes for different GT IDs are separate vote keys', () => {
      // 1 vote for H-01, 1 vote for H-02, 1 for novel → no majority
      const result = computeMajority([
        vote('matched', 'H-01'),
        vote('matched', 'H-02'),
        vote('novel'),
      ]);
      expect(result.category).toBe('uncertain');
      // Each is a different vote key: "matched:H-01", "matched:H-02", "novel:"
    });

    it('reasoning reflects the split in uncertain results', () => {
      const result = computeMajority([
        vote('matched', 'H-01'),
        vote('novel'),
        vote('fp'),
      ]);
      expect(result.reasoning).toContain('No majority');
    });
  });
});

// ─── hashContent ───

describe('hashContent', () => {
  it('returns 16 hex chars', () => {
    const hash = hashContent('test content');
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('is deterministic — same input → same hash', () => {
    const a = hashContent('identical input');
    const b = hashContent('identical input');
    expect(a).toBe(b);
  });

  it('different inputs → different hashes', () => {
    const a = hashContent('input A');
    const b = hashContent('input B');
    expect(a).not.toBe(b);
  });

  it('whitespace matters', () => {
    const a = hashContent('hello world');
    const b = hashContent('hello  world');
    expect(a).not.toBe(b);
  });

  it('empty string has a valid hash', () => {
    const hash = hashContent('');
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('JSON serialization order matters (cache correctness)', () => {
    // If GT content changes, the hash MUST change
    const gt1 = JSON.stringify({ findings: [{ id: 'H-01' }] });
    const gt2 = JSON.stringify({ findings: [{ id: 'H-01' }, { id: 'H-02' }] });
    expect(hashContent(gt1)).not.toBe(hashContent(gt2));
  });
});
