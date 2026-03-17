# Create Stripped Codebase — Session Prompt

Copy and paste the block below into a new Claude Code session to create a stripped dataset for a new codebase. Replace the placeholder values before running.

---

## Prompt

```
You are setting up a stripped (scoped-only) codebase for the solidity-auditor benchmark pipeline.

## What "stripped" means

The full dataset in `datasets/<codebase>/` contains the entire repo — tests, mocks, scripts, docs, build artifacts. A stripped version contains ONLY the in-scope Solidity files (from `scope.txt`) so the LLM focuses on auditable code with zero noise.

## Inputs you need

1. **Codebase ID**: `<CODEBASE>` (e.g., `brix`)
2. **In-scope files with nSLOC** (from the C4 contest page):

<paste the scope table here — File + nSLOC columns>

## Steps to execute

### 1. Create the stripped dataset

- Create `datasets/<CODEBASE>-stripped/` with only the files listed in scope
- Preserve the original directory structure (e.g., `src/token/iTRY/iTry.sol` stays at that path)
- Copy files from `datasets/<CODEBASE>/` — never modify the original dataset
- Create `datasets/<CODEBASE>-stripped/scope.txt` listing all files (one per line, `./` prefixed)
- Do NOT include: tests, mocks, scripts, docs, config files, build output, lock files, `node_modules`, `lib/` (forge deps)

### 2. Verify file count and contents

- Confirm the exact number of .sol files matches the scope table
- Confirm each file exists and is non-empty
- List total lines per file for sanity check (nSLOC won't match exactly due to counting methodology — that's fine, just verify files are complete)

### 3. Create ground truth

- Copy `ground_truth/<CODEBASE>.json` to `ground_truth/<CODEBASE>-stripped.json`
- Update `codebaseId` to `<CODEBASE>-stripped`
- Update `description` to include "(stripped)"
- Keep all findings unchanged — they reference the same contracts

### 4. Update bench config

- Add entry to `config/bench.json` codebases array:
  ```json
  {
    "id": "<CODEBASE>-stripped",
    "path": "datasets/<CODEBASE>-stripped",
    "gitCommit": "<same commit as original codebase entry, omit if original has none>"
  }
  ```

### 5. Build and dry-run

- Run `npx tsc` — must compile clean
- Run: `node dist/runner/cli.js --codebases <CODEBASE>-stripped --conditions bare_audit,skill_v1_default,skill_v2 --runs 3 --dry-run`
- Confirm output shows 9 runs (3 conditions x 3 runs)

### 6. Report back

Summarize:
- Number of files in stripped dataset
- Total lines (raw) across all files
- Ground truth finding count (H/M/L breakdown)
- Dry-run confirmation

## Constraints

- Do NOT include v1_deep condition (we don't test it)
- Do NOT modify the original dataset in `datasets/<CODEBASE>/`
- Do NOT modify any existing ground truth files
- Classification uses `CLASSIFY_VOTES=3` for 3-vote Sonnet classification (set on `npm run analyze`, NOT on `npm run bench` — the runner doesn't classify)

## Running the benchmark after creation

Once the stripped dataset is set up and dry-run passes, run these commands in order:

1. **Archive previous results** (if any exist in `results/`):
   ```bash
   npm run archive
   ```

2. **Run benchmark** (3 conditions x 3 runs, parallel):
   ```bash
   npm run bench -- --codebases <CODEBASE>-stripped --conditions bare_audit,skill_v1_default,skill_v2 --runs 3 --parallel
   ```

3. **Analyze** (classify → cluster → validate → report):
   ```bash
   CLASSIFY_VOTES=3 npm run analyze
   ```
   This generates `summary.md` with the full report.

4. **Generate dashboard** (HTML, no LLM calls):
   ```bash
   npm run dashboard
   open dashboard.html
   ```
```

---

## Example: creating brix-stripped

Paste the prompt above, then provide the scope:

```
File    nSLOC
src/protocol/FastAccessVault.sol    X
src/protocol/YieldForwarder.sol    X
src/protocol/iTryIssuer.sol    X
src/token/iTRY/crosschain/iTryTokenOFT.sol    X
src/token/iTRY/crosschain/iTryTokenOFTAdapter.sol    X
src/token/iTRY/iTry.sol    X
src/token/wiTRY/StakediTry.sol    X
src/token/wiTRY/StakediTryCooldown.sol    X
src/token/wiTRY/StakediTryCrosschain.sol    X
src/token/wiTRY/StakediTryFastRedeem.sol    X
src/token/wiTRY/crosschain/UnstakeMessenger.sol    X
src/token/wiTRY/crosschain/wiTryOFT.sol    X
src/token/wiTRY/crosschain/wiTryOFTAdapter.sol    X
src/token/wiTRY/crosschain/wiTryVaultComposer.sol    X
src/token/wiTRY/iTrySilo.sol    X
Totals    1324
```

(Replace X with actual nSLOC values from the contest page.)
