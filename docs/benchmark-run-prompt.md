# Benchmark Run Prompt

Copy the block below and set the `CODEBASES` variable to one or more dataset names.

**Single codebase:** `CODEBASES=merkl`
**Multiple codebases:** `CODEBASES=canary,nft-dealers,merkl`

Available codebases: `canary`, `nft-dealers`, `merkl`, `brix`, `ekubo`, `megapot`, `panoptic`

---

```
CODEBASES=<SET_HERE>
RUNS=1

Run a parallel benchmark on the above codebase(s) with all 3 conditions (bare_audit, skill_v1_default, skill_v2), $RUNS run each, 10-minute timeout.

Before running:
1. Check if each dataset has scope.txt and out_of_scope.txt — show me the in-scope file count per codebase
2. Build the project

Run:
3. Execute: npm run bench -- --codebases $CODEBASES --conditions bare_audit,skill_v1_default,skill_v2 --runs $RUNS --parallel

After the run completes:
4. Verify all conditions passed verification checks
5. Check scope compliance:
   - Which .sol files did each condition actually Read? (parse events.jsonl for file_path entries ending in .sol)
   - Grep all stdout files for any out-of-scope contract names — report hit count per condition
   - If bare reads dependency files (interfaces, structs) for context that's acceptable — flag only if findings reference out-of-scope contracts
6. Check for tool errors in the event stream (token limit exceeded, file not found, etc.)
7. Note any V1/V2 bundle creation issues (retries, empty bundles, background task failures)

Produce a summary with:

## Results Table

Per codebase:

| Metric | bare_audit | skill_v1_default | skill_v2 |
|---|---|---|---|
| Duration | | | |
| Exit code | | | |
| Agents spawned/returned | | | |
| Cost | | | |
| Events captured | | | |
| Verification | PASS/FAIL (check count) | | |

## Scope Compliance

- Per-condition: which .sol files were Read
- Per-condition: mentions of out-of-scope contracts in stdout (count + context if any)
- Verdict: clean / acceptable / violation

## Notable Observations

- Any tool errors, bundle issues, retries, grace-kills, or unexpected behavior
- Agent spawn timing and return patterns
- Anything that suggests a skill bug or performance concern on this codebase size
- If running multiple codebases: any signs of cross-codebase interference or rate limiting
```
