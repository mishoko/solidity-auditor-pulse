import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import {
  callLLM,
  callLLMRaw,
  setLLMProvider,
  resetLLMProvider,
  LLMError,
  type LLMProvider,
} from '../../src/classifier/llm.js';
import { collectNovelFindings } from '../../src/classifier/cluster.js';
import type { RunClassification } from '../../src/shared/types.js';

// ─── FakeLLMProvider ───

/**
 * Test double for LLM calls. Returns canned responses based on prompt content.
 * Tracks call count for assertions.
 */
class FakeLLMProvider implements LLMProvider {
  calls: Array<{ prompt: string; model: string }> = [];
  responses: Map<string, string> = new Map();
  defaultResponse = '{"result": "ok"}';

  /** Set a canned response for prompts containing the given substring. */
  when(promptContains: string, response: string): this {
    this.responses.set(promptContains, response);
    return this;
  }

  async call(prompt: string, model: string, _timeout: number): Promise<string> {
    this.calls.push({ prompt, model });
    for (const [key, response] of this.responses) {
      if (prompt.includes(key)) return response;
    }
    return this.defaultResponse;
  }
}

// ─── LLMProvider integration ───

describe('LLMProvider interface', () => {
  let fake: FakeLLMProvider;

  beforeAll(() => {
    fake = new FakeLLMProvider();
    setLLMProvider(fake);
  });

  afterAll(() => {
    resetLLMProvider();
  });

  it('callLLM uses the injected provider', async () => {
    const schema = z.object({ answer: z.string() });
    fake.defaultResponse = '{"answer": "42"}';

    const result = await callLLM('What is the answer?', {
      model: 'test-model',
      timeout: 5000,
      schema,
      retries: 1,
    });

    expect(result).toEqual({ answer: '42' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.model).toBe('test-model');
  });

  it('callLLMRaw uses the injected provider', async () => {
    fake.defaultResponse = 'Raw markdown response here';

    const result = await callLLMRaw('Generate report', 'analyst-model', 5000);

    expect(result).toBe('Raw markdown response here');
    expect(fake.calls.at(-1)!.model).toBe('analyst-model');
  });

  it('callLLM validates Zod schema', async () => {
    const schema = z.object({ count: z.number() });
    fake.defaultResponse = '{"count": "not-a-number"}';

    await expect(
      callLLM('bad response', { model: 'test', timeout: 5000, schema, retries: 1 }),
    ).rejects.toThrow(LLMError);
  });

  it('callLLM extracts JSON from surrounding text', async () => {
    const schema = z.object({ found: z.boolean() });
    fake.defaultResponse = 'Here is the result:\n\n```json\n{"found": true}\n```\n\nDone.';

    const result = await callLLM('find it', {
      model: 'test',
      timeout: 5000,
      schema,
      retries: 1,
    });

    expect(result).toEqual({ found: true });
  });

  it('callLLM handles array JSON shape', async () => {
    const schema = z.array(z.object({ id: z.string() }));
    fake.defaultResponse = 'Results: [{"id": "a"}, {"id": "b"}]';

    const result = await callLLM('list items', {
      model: 'test',
      timeout: 5000,
      schema,
      jsonShape: 'array',
      retries: 1,
    });

    expect(result).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});

// ─── collectNovelFindings (pipeline phase connector) ───

describe('collectNovelFindings', () => {
  const classifications: RunClassification[] = [
    {
      runId: 'run-1',
      codebaseId: 'cb-1',
      conditionId: 'skill_v2',
      classifiedAt: '2026-01-01T00:00:00Z',
      classifierModel: 'sonnet',
      gtHash: 'abc',
      stdoutHash: 'def',
      classifications: [
        {
          findingIndex: 1,
          findingTitle: 'Reentrancy in withdraw',
          category: 'matched',
          matchedGtId: 'H-01',
          agreement: '1/1',
          reasoning: 'Matched',
          votes: [],
        },
        {
          findingIndex: 2,
          findingTitle: 'Flash loan attack',
          category: 'novel',
          matchedGtId: null,
          agreement: '1/1',
          reasoning: 'Novel flash loan vector',
          votes: [],
        },
        {
          findingIndex: 3,
          findingTitle: 'Gas optimization',
          category: 'fp',
          matchedGtId: null,
          agreement: '1/1',
          reasoning: 'Not a vulnerability',
          votes: [],
        },
        {
          findingIndex: 4,
          findingTitle: 'Unclear oracle issue',
          category: 'uncertain',
          matchedGtId: null,
          agreement: 'no-majority',
          reasoning: 'Votes disagreed',
          votes: [],
        },
      ],
    },
    {
      runId: 'run-2',
      codebaseId: 'cb-1',
      conditionId: 'bare_audit',
      classifiedAt: '2026-01-01T01:00:00Z',
      classifierModel: 'sonnet',
      gtHash: 'abc',
      stdoutHash: 'ghi',
      classifications: [
        {
          findingIndex: 1,
          findingTitle: 'Access control missing',
          category: 'novel',
          matchedGtId: null,
          agreement: '1/1',
          reasoning: 'Novel access control issue',
          votes: [],
        },
      ],
    },
  ];

  it('collects only novel and uncertain findings', () => {
    const inputs = collectNovelFindings(classifications);
    expect(inputs).toHaveLength(3); // flash loan, oracle issue, access control
  });

  it('excludes matched and fp findings', () => {
    const inputs = collectNovelFindings(classifications);
    const titles = inputs.map((i) => i.findingTitle);
    expect(titles).not.toContain('Reentrancy in withdraw');
    expect(titles).not.toContain('Gas optimization');
  });

  it('includes novel findings', () => {
    const inputs = collectNovelFindings(classifications);
    const titles = inputs.map((i) => i.findingTitle);
    expect(titles).toContain('Flash loan attack');
    expect(titles).toContain('Access control missing');
  });

  it('includes uncertain findings', () => {
    const inputs = collectNovelFindings(classifications);
    const titles = inputs.map((i) => i.findingTitle);
    expect(titles).toContain('Unclear oracle issue');
  });

  it('preserves run metadata', () => {
    const inputs = collectNovelFindings(classifications);
    const flashLoan = inputs.find((i) => i.findingTitle === 'Flash loan attack')!;
    expect(flashLoan.runId).toBe('run-1');
    expect(flashLoan.conditionId).toBe('skill_v2');
    expect(flashLoan.findingIndex).toBe(2);
    expect(flashLoan.reasoning).toBe('Novel flash loan vector');
  });

  it('returns empty for all-matched/fp classifications', () => {
    const allMatched: RunClassification[] = [
      {
        runId: 'run-x',
        codebaseId: 'cb-x',
        conditionId: 'skill_v2',
        classifiedAt: '',
        classifierModel: 'sonnet',
        gtHash: '',
        stdoutHash: '',
        classifications: [
          { findingIndex: 1, findingTitle: 'A', category: 'matched', matchedGtId: 'H-01', agreement: '1/1', reasoning: '', votes: [] },
          { findingIndex: 2, findingTitle: 'B', category: 'fp', matchedGtId: null, agreement: '1/1', reasoning: '', votes: [] },
        ],
      },
    ];
    expect(collectNovelFindings(allMatched)).toHaveLength(0);
  });
});
