# The Persisted-Output Trap: Why Subagents Fail on Medium-Sized Codebases

> **Note**: This issue was documented on 2026-03-13 against Claude Code's platform behavior at that time. The thresholds and behavior described may have changed in newer Claude Code versions. The investigation methodology and findings remain relevant for understanding skill failure modes on larger codebases.

## Summary

When the solidity-auditor skill spawns subagents to read bundle files, a Claude Code platform interaction between the **Read tool's 25K token limit** and the **persisted-output 50K character threshold** creates a deadlock that prevents agents from reading their bundles. This affects any codebase where the bundle's formatted Read output exceeds 50K characters (~1,200+ lines of Solidity with line-number formatting).

## The Two Gates

Claude Code enforces two independent size limits on tool results:

| Gate | Threshold | What happens | Configurable? |
|------|-----------|-------------|---------------|
| **Read tool token limit** | 25,000 tokens | Hard refusal — no content returned, error tells model to use offset/limit | `MAX_MCP_OUTPUT_TOKENS` env var |
| **Persisted-output char limit** | 50,000 characters | Output saved to disk, model receives only a pointer + 2KB preview | No known env var |

These gates operate independently and in sequence: a Read call can **pass** the 25K token gate but then have its result **trapped** by the 50K character gate.

## The Deadlock Chain

Observed in the merkl benchmark run (2026-03-13, V2 skill):

```
Step 1: Agent reads 1,571-line bundle (no offset/limit)
        → Read tool checks: ~8K tokens → PASSES 25K token gate
        → Read returns content with cat -n line numbers
        → Formatted output: 103KB (~103,000 characters)
        → 103K > 50K threshold → OUTPUT PERSISTED TO DISK

Step 2: Agent receives only:
        "<persisted-output>
         Output too large (103.2KB).
         Full output saved to: .../.claude/projects/.../tool-results/toolu_xxx.txt
         Preview (first 2KB): [tiny snippet]"

        Agent NEVER received the file content. Only a 2KB preview.

Step 3: Agent tries to Read the persisted toolu_xxx.txt file
        → File is 29,662 tokens (includes line-number formatting from step 1)
        → 29K > 25K → HARD REFUSAL by Read tool
        → Agent must fall back to chunked reads with offset/limit
```

The trap: a file that is small enough to read (8K tokens) produces output large enough to persist (103K chars), and the persisted file is too large to read back (29K tokens).

## Why Formatted Output Is Larger

The Read tool returns content in `cat -n` format: line numbers + tab + content. For a 1,571-line Solidity file:

- Raw file: ~50KB, ~8K tokens
- Read output (with line numbers): ~103KB, ~29K tokens

The line-number formatting roughly doubles the character count and triples the token count, because each line gets a prefix like `  1234→` that tokenizes inefficiently.

## Impact on V1 vs V2

### V1 (skill_v1_default) — Complete failure on merkl

V1 bundles ALL discovered .sol files (44 files for merkl, 7,612 lines) into each agent's bundle. The chain:

1. Bundle creation failed 3 times before succeeding (background Bash issues) — burned ~5 minutes
2. Orchestrator read bundles in 1000-line chunks (correctly) but then tried to paste into agent prompts
3. Agents spawned sequentially (not parallel) at 8m47s — only 73 seconds before timeout
4. ALL 4 agents hit Read errors on the 7,612-line bundles
5. 0 agents completed. Total output: 20 lines (setup text only)

### V2 (skill_v2) — Recovered, but with extra cost

V2 bundles were smaller (~1,571 lines) because the V2 orchestrator used scope info to limit files. The chain:

1. 5 agents read bundles without offset/limit → all Read calls succeeded (under 25K tokens)
2. All 5 results persisted to disk (103KB each, over 50K char threshold)
3. Agent 1 tried to read persisted file → 29,662 tokens → error
4. Agent 1 recovered with chunked offset/limit reads
5. Other agents proceeded with only the 2KB preview (per GitHub issue #17407, ~85% of agents ignore persisted-output and proceed with whatever context they have)
6. All 5 agents returned results. FP-gate agent validated successfully.

V2's smaller bundles and better recovery instructions made the difference.

## Why Standalone Interactive Runs Appear to Work

Three factors explain why running `/solidity-auditor` interactively doesn't exhibit this failure:

1. **Persisted-output activation is server-side and non-deterministic.** GitHub issue [#17407](https://github.com/anthropics/claude-code/issues/17407) documented that the 50K threshold toggles on/off server-side between days. Some runs persist outputs, some don't.

2. **Agents confabulate past the error ~85% of the time.** Per issue #17407, most agents ignore the `<persisted-output>` marker and proceed as if they read the file. In interactive mode with a human reviewing output, this may go unnoticed if the analysis looks reasonable.

3. **The skill's chunk-read instructions are the correct fix but aren't reliably followed.** Both V1 and V2 agent instruction files say "Read your bundle file in parallel 1000/2000-line chunks" — but the actual agents do full reads without offset/limit. When agents DO follow the chunking instruction, the persisted-output trap is avoided entirely because each chunk is well under both thresholds.

## Evidence from Benchmark Events

### V2 agents — full reads, no chunking (ignoring instructions)

```
L39: Read /tmp/audit-merkl-skill_v2-agent-1-bundle.md  offset=NONE limit=NONE
L37: Read /tmp/audit-merkl-skill_v2-agent-2-bundle.md  offset=NONE limit=NONE
L41: Read /tmp/audit-merkl-skill_v2-agent-3-bundle.md  offset=NONE limit=NONE
L48: Read /tmp/audit-merkl-skill_v2-agent-4-bundle.md  offset=NONE limit=NONE
L46: Read /tmp/audit-merkl-skill_v2-agent-5-bundle.md  offset=NONE limit=NONE
```

All five agents read their bundles in a single call without offset/limit, ignoring the "parallel 2000-line chunks" instruction.

### V1 orchestrator — chunked reads (but shouldn't be reading bundles itself)

```
L63: Read agent-1-bundle.md  offset=NONE  limit=1000
L64: Read agent-1-bundle.md  offset=1000  limit=1000
L65: Read agent-1-bundle.md  offset=2000  limit=1000
...  (8 reads per bundle × 4 bundles = 32 orchestrator reads)
```

V1's orchestrator reads bundles to paste into agent prompts (V1 architecture: "paste full text of vector-scan-agent.md into every prompt"). This means the orchestrator's context window fills with 4× the full codebase before any agent spawns.

## Affected Codebase Sizes

The trap triggers when: `in_scope_lines × ~65 bytes/line × 2 (line-number formatting) > 50,000 characters`

Rough threshold: **~400 lines of in-scope Solidity** (with typical line lengths).

| Codebase | In-scope lines | In-scope files | Total .sol | Would trigger? |
|----------|---------------|----------------|-----------|---------------|
| canary | 71 | 3 | 5 | No |
| merkl | 1,226 | 2 | 62 | **Yes** (observed) |
| brix | 3,199 | 14 | 109 | **Yes** (likely worse) |
| megapot | 4,380 | 15 | 27 | **Yes** |
| panoptic | 12,262 | 11 | 92 | **Yes** (massive) |

## V1's Extra Problem: No Scope Filtering

V1 bundles ALL .sol files found by its `find` command (excluding only `interfaces/`, `lib/`, `mocks/`, `test/`, `*.t.sol`, `*Test*.sol`, `*Mock*.sol`). It does NOT read scope.txt. For merkl, this means 44 files (7,612 lines) instead of 2 files (1,226 lines).

V2 sometimes uses scope info from CLAUDE.md to limit bundles, but this is non-deterministic LLM behavior, not a guaranteed feature of the skill.

Neither skill version excludes `scripts/` or `contracts/mock/` (singular — the skill pattern says `mocks/` plural).

## Recommendations

### For the benchmark (do nothing)

The benchmark setup is correct and faithfully replicates what happens when `claude -p` spawns subagents. The persisted-output trap is a real failure mode that affects production use of the skill. Documenting it accurately is more valuable than working around it.

### For the skill (upstream improvements)

1. **Enforce chunked reads in agent prompts** — make the instruction more prominent or use a system prompt that forces offset/limit usage
2. **Scope-aware bundling** — read scope.txt and only bundle in-scope files, reducing bundle sizes dramatically
3. **Add `scripts/` to the exclude pattern** — deployment scripts shouldn't be in audit bundles
4. **Fix `mocks/` vs `mock/` mismatch** — use a pattern that catches both

### For Claude Code (platform)

1. The interaction between the 25K Read token limit and the 50K persisted-output char threshold creates an unrecoverable deadlock for files in the 25K-50K char / 8K-25K token range
2. Persisted output files should not include line-number formatting (which inflates token count 3×)
3. Or: the 25K Read limit should not apply to persisted tool-result files (they're already in the system)

## References

- [#4002: File content exceeds maximum allowed tokens (25000)](https://github.com/anthropics/claude-code/issues/4002)
- [#15687: Read tool's 25k token limit is too conservative](https://github.com/anthropics/claude-code/issues/15687)
- [#16175: Subagents duplicate tool calls with persisted-output](https://github.com/anthropics/claude-code/issues/16175)
- [#17407: Phantom Reads — agents proceed without reading persisted output](https://github.com/anthropics/claude-code/issues/17407)
- [#14888: Make file read token limit dynamic based on model](https://github.com/anthropics/claude-code/issues/14888)
