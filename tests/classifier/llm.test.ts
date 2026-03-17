import { describe, it, expect } from 'vitest';
import { parallelMap } from '../../src/classifier/llm.js';

describe('parallelMap', () => {
  it('preserves order of results', async () => {
    const items = [30, 10, 20];
    const results = await parallelMap(
      items,
      async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
        return `done-${ms}`;
      },
      3,
    );
    expect(results).toEqual(['done-30', 'done-10', 'done-20']);
  });

  it('respects concurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const results = await parallelMap(
      [1, 2, 3, 4, 5, 6],
      async (item) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        return item * 2;
      },
      2,
    );

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
  });

  it('handles empty array', async () => {
    const results = await parallelMap([], async () => 'never', 5);
    expect(results).toEqual([]);
  });

  it('handles concurrency greater than items', async () => {
    const results = await parallelMap(
      [1, 2],
      async (n) => n * 10,
      100,
    );
    expect(results).toEqual([10, 20]);
  });

  it('propagates errors', async () => {
    await expect(
      parallelMap(
        [1, 2, 3],
        async (n) => {
          if (n === 2) throw new Error('boom');
          return n;
        },
        2,
      ),
    ).rejects.toThrow('boom');
  });

  it('passes index to callback', async () => {
    const indices: number[] = [];
    await parallelMap(
      ['a', 'b', 'c'],
      async (_, idx) => {
        indices.push(idx);
      },
      1,
    );
    expect(indices).toEqual([0, 1, 2]);
  });
});
