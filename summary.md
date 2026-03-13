# Benchmark Results

> Generated: 2026-03-13 · All runs
>
> **#N** after a condition name indicates the run number (e.g. Bare CC #2 = second run of that condition).

## Overview

| Codebase | Condition | Model | Findings | Duration | Cost |
|----------|-----------|-------|----------|----------|------|
| merkl | V2 | claude-opus-4-6 | 2 | 5m37s | $2.26 |
| merkl | V1 | claude-opus-4-6 | 4 | 9m24s | $2.68 |
| merkl | Bare CC | claude-opus-4-6 | 12 | 3m17s | $0.49 |
| canary | Bare CC #1 | claude-opus-4-6 | 4 | 22s | $0.12 |
| canary | Bare CC #2 | claude-opus-4-6 | 4 | 25s | $0.10 |
| canary | Bare CC #3 | claude-opus-4-6 | 4 | 23s | $0.12 |
| canary | Bare CC #4 | claude-opus-4-6 | 6 | 32s | $0.06 |
| canary | Bare CC #5 | claude-opus-4-6 | 6 | 32s | $0.05 |
| nft-dealers | Bare CC #1 | claude-opus-4-6 | 13 | 1m53s | $0.24 |
| nft-dealers | Bare CC #2 | claude-opus-4-6 | 13 | 2m2s | $0.29 |
| nft-dealers | Bare CC #3 | claude-opus-4-6 | 13 | 2m39s | $0.26 |

## merkl

### Recall

```
V2       █████░░░░░░░░░░░░░░░ 2/8 (25%) M-02, L-01
V1       ████████░░░░░░░░░░░░ 3/8 (38%) M-03, L-02, L-03
Bare CC  ███░░░░░░░░░░░░░░░░░ 1/8 (13%) L-02
```

**Missed by all**: M-01 (Minimum Reward-Per-Hour Validation Applied to Gros), L-04 (_createCampaign validates minimum rate on gross am), L-05 (getMerkleRoot returns old tree during dispute peri)

### False Positives

```
V2       ██░░░░░░░░░░░░░░░░░░ 1 FP(s): recoverFees drains user predeposited bal
V1       █████░░░░░░░░░░░░░░░ 3 FP(s): Creator can drain predeposited balance w; `tx.origin` in `hasSigned` modifier allo; `recoverFees()` sweeps user-predeposited
Bare CC  █████████████████░░░ 10 FP(s): `recoverFees()` drains user pre-deposite; `tx.origin` authorization in `hasSigned`; Operator-controlled callback data in `cl; `increaseTokenBalance` is vulnerable to ; `increaseTokenBalance` governor path all; `Distributor._status` not initialized to; `setClaimRecipient` has no governance ov; `feeRebate` has no upper bound validatio; `reallocateCampaignRewards` allows dupli; `Distributor.updateTree` allows governor
```

### Findings

```
V2       ███░░░░░░░░░░░░░░░░░ 2 finding(s)
V1       ███████░░░░░░░░░░░░░ 4 finding(s)
Bare CC  ████████████████████ 12 finding(s)
```

### Duration

```
V2       ████████████░░░░░░░░ 5m37s
V1       ████████████████████ 9m24s
Bare CC  ███████░░░░░░░░░░░░░ 3m17s
```

<details><summary>V2 — 2 finding(s)</summary>

- recoverFees drains user predeposited balances alongside protocol fees [75] · DistributionCreator.recoverFees
- Batch claim reverts entirely when a single transfer fails due to token blacklist [65] · Distributor._claim

</details>

<details><summary>V1 — 4 finding(s)</summary>

- Creator can drain predeposited balance when operator lacks allowance in `_pullTokens` [85] · DistributionCreator._pullTokens
- `tx.origin` in `hasSigned` modifier allows intermediary contracts to bypass T&C acceptance [78] · DistributionCreator.hasSigned
- Incorrect start timestamp used in override end-time validation [78] · DistributionCreator.overrideCampaign
- `recoverFees()` sweeps user-predeposited balances alongside protocol fees [72] · DistributionCreator.recoverFees

</details>

<details><summary>Bare CC — 12 finding(s)</summary>

- `recoverFees()` drains user pre-deposited balances alongside protocol fees · recoverFees
- `overrideCampaign()` uses stale `startTimestamp` for end-time validation when start is changed · overrideCampaign
- No validation that campaign `startTimestamp` is in the future
- `tx.origin` authorization in `hasSigned` modifier enables unintended campaign creation · hasSigned
- Operator-controlled callback data in `claimWithRecipient` enables arbitrary calls to recipient contracts · claimWithRecipient
- `increaseTokenBalance` is vulnerable to reentrancy with ERC-777 or hook-enabled tokens
- `increaseTokenBalance` governor path allows inflating balances without token backing
- `Distributor._status` not initialized to 1 in `initialize()` · Distributor._status
- `setClaimRecipient` has no governance override
- `feeRebate` has no upper bound validation
- `reallocateCampaignRewards` allows duplicate entries in `campaignListReallocation` · campaignListReallocation
- `Distributor.updateTree` allows governor to bypass dispute period · Distributor.updateTree

</details>

### Findings Matrix

| Ground Truth | Finding | V2 | V1 | Bare CC |
| ------------ | ------- | --- | --- | --- |
| M-01 | Minimum Reward-Per-Hour Validation Applied to Gross ... | - | - | - |
| M-02 | Improper Error Handling of onClaim Callback in _clai... | [65] | - | - |
| M-03 | Multi-step campaign overrides are anchored to the or... | - | [78] | - |
| L-01 | resolveDispute reverts when disputer is blacklisted ... | [65] | - | - |
| L-02 | overrideCampaign end timestamp validation uses wrong... | - | [78] | ✓ |
| L-03 | overrideCampaign missing reward rate validation allo... | - | [78] | - |
| L-04 | _createCampaign validates minimum rate on gross amou... | - | - | - |
| L-05 | getMerkleRoot returns old tree during dispute period... | - | - | - |

## canary

### Recall

```
Bare CC #1 ████████████████████ 4/4 (100%) reentrancy-vault-withdraw, access-control-setprice, unchecked-return-withdrawunsafe, tx-origin-withdrawfunds
Bare CC #2 ████████████████████ 4/4 (100%) reentrancy-vault-withdraw, access-control-setprice, unchecked-return-withdrawunsafe, tx-origin-withdrawfunds
Bare CC #3 ████████████████████ 4/4 (100%) reentrancy-vault-withdraw, access-control-setprice, unchecked-return-withdrawunsafe, tx-origin-withdrawfunds
Bare CC #4 ████████████████████ 4/4 (100%) reentrancy-vault-withdraw, access-control-setprice, unchecked-return-withdrawunsafe, tx-origin-withdrawfunds
Bare CC #5 ████████████████████ 4/4 (100%) reentrancy-vault-withdraw, access-control-setprice, unchecked-return-withdrawunsafe, tx-origin-withdrawfunds
```

### False Positives

```
Bare CC #1 ░░░░░░░░░░░░░░░░░░░░ 0 FP(s)
Bare CC #2 ░░░░░░░░░░░░░░░░░░░░ 0 FP(s)
Bare CC #3 ░░░░░░░░░░░░░░░░░░░░ 0 FP(s)
Bare CC #4 ███░░░░░░░░░░░░░░░░░ 1 FP(s): Potential integer overflow in `buy()`
Bare CC #5 ███░░░░░░░░░░░░░░░░░ 1 FP(s): Integer overflow in `buy()` price calcul
```

### Findings

```
Bare CC #1 █████████████░░░░░░░ 4 finding(s)
Bare CC #2 █████████████░░░░░░░ 4 finding(s)
Bare CC #3 █████████████░░░░░░░ 4 finding(s)
Bare CC #4 ████████████████████ 6 finding(s)
Bare CC #5 ████████████████████ 6 finding(s)
```

### Duration

```
Bare CC #1 ██████████████░░░░░░ 22s
Bare CC #2 ████████████████░░░░ 25s
Bare CC #3 ███████████████░░░░░ 23s
Bare CC #4 ████████████████████ 32s
Bare CC #5 ████████████████████ 32s
```

<details><summary>Bare CC #1 — 4 finding(s)</summary>

- Reentrancy in `Vault.withdraw` · Vault.withdraw
- Missing Access Control on `TokenSale.setPrice` · TokenSale.setPrice
- `tx.origin` Authentication in `TokenSale.withdrawFunds` · TokenSale.withdrawFunds
- Unchecked Return Value in `Vault.withdrawUnsafe` · Vault.withdrawUnsafe

</details>

<details><summary>Bare CC #2 — 4 finding(s)</summary>

- Reentrancy in `Vault.withdraw` · Vault.withdraw
- Missing Access Control on `TokenSale.setPrice` · TokenSale.setPrice
- `tx.origin` Authentication in `TokenSale.withdrawFunds` · TokenSale.withdrawFunds
- Unchecked `send` Return Value in `Vault.withdrawUnsafe` · Vault.withdrawUnsafe

</details>

<details><summary>Bare CC #3 — 4 finding(s)</summary>

- Reentrancy in `Vault.withdraw` · Vault.withdraw
- Missing Access Control on `TokenSale.setPrice` · TokenSale.setPrice
- `tx.origin` Authentication in `TokenSale.withdrawFunds` · TokenSale.withdrawFunds
- Unchecked `send` Return Value in `Vault.withdrawUnsafe` · Vault.withdrawUnsafe

</details>

<details><summary>Bare CC #4 — 6 finding(s)</summary>

- Reentrancy in `withdraw()` · Vault.withdraw
- Unchecked return value of `send()` in `withdrawUnsafe()` · Vault.send
- Missing access control on `withdrawUnsafe()` · Vault.withdrawUnsafe
- Missing access control on `setPrice()` · TokenSale.setPrice
- `tx.origin` authentication in `withdrawFunds()` · TokenSale.withdrawFunds
- Potential integer overflow in `buy()` · TokenSale.buy

</details>

<details><summary>Bare CC #5 — 6 finding(s)</summary>

- Reentrancy in `withdraw()` · Vault.withdraw
- Unchecked return value in `withdrawUnsafe()` · Vault.withdrawUnsafe
- Arbitrary recipient in `withdrawUnsafe()` · Vault.withdrawUnsafe
- Missing access control on `setPrice()` · TokenSale.setPrice
- `tx.origin` authentication in `withdrawFunds()` · TokenSale.withdrawFunds
- Integer overflow in `buy()` price calculation · TokenSale.buy

</details>

### Findings Matrix

| Ground Truth | Finding | Bare CC #1 | Bare CC #2 | Bare CC #3 | Bare CC #4 | Bare CC #5 |
| ------------ | ------- | --- | --- | --- | --- | --- |
| reentrancy-vault-withdraw | CEI violation — external call before balance update | ✓ | ✓ | ✓ | ✓ | ✓ |
| access-control-setprice | No onlyOwner modifier, anyone can set price to zero | ✓ | ✓ | ✓ | ✓ | ✓ |
| unchecked-return-withdrawunsafe | send() return value ignored, funds lost silently | ✓ | ✓ | ✓ | ✓ | ✓ |
| tx-origin-withdrawfunds | tx.origin auth enables phishing via intermediary con... | ✓ | ✓ | ✓ | ✓ | ✓ |

## nft-dealers

### Findings

```
Bare CC #1 ████████████████████ 13 finding(s)
Bare CC #2 ████████████████████ 13 finding(s)
Bare CC #3 ████████████████████ 13 finding(s)
```

### Duration

```
Bare CC #1 ██████████████░░░░░░ 1m53s
Bare CC #2 ███████████████░░░░░ 2m2s
Bare CC #3 ████████████████████ 2m39s
```

<details><summary>Bare CC #1 — 13 finding(s)</summary>

- 1. Unrestricted Repeated Calls to `collectUsdcFromSelling`
- 2. `collectUsdcFromSelling` Callable After `cancelListing`
- 3. Listing ID vs Token ID Mismatch
- 4. Collateral Never Zeroed in `collectUsdcFromSelling` · collectUsdcFromSelling
- 5. `uint32` Price Truncation
- 6. Self-Transfer of Fees is a No-Op
- 7. No NFT Escrow on Listing
- 8. Raw `transferFrom` Instead of `safeTransferFrom`
- 9. `payable` Functions Lock ETH Permanently
- 10. `updatePrice` Skips `MIN_PRICE` Validation
- 11. `calculateFees` Publicly Exposed
- 12. Redundant Zero-Address Check in `mintNft` · mintNft
- 13. No Ownership Transfer Mechanism

</details>

<details><summary>Bare CC #2 — 13 finding(s)</summary>

- `collectUsdcFromSelling` can be called repeatedly to drain the contract
- `collectUsdcFromSelling` callable after `cancelListing`
- Listing ID vs Token ID confusion
- `uint32` price truncation
- Self-transfer of fees
- `updatePrice` bypasses `MIN_PRICE` validation
- `buy()` and `mintNft()` are `payable` but don't handle ETH · buy
- No NFT escrow on listing
- `calculateFees` is publicly exposed
- Redundant `address(0)` check in `mintNft` · mintNft
- No ownership transfer mechanism
- `list()` redundant price check · list
- `buy()` doesn't require buyer to be whitelisted · buy

</details>

<details><summary>Bare CC #3 — 13 finding(s)</summary>

- `collectUsdcFromSelling` can be called repeatedly
- Fee self-transfer is a no-op
- Listing ID / Token ID mismatch
- `uint32` price truncates at ~4,294 USDC
- NFT not escrowed on listing
- `cancelListing` returns collateral
- `buy()` has no whitelist check · buy
- `mintNft` uses raw `transferFrom` instead of SafeERC20
- Unreachable `address(0)` check in `mintNft` · mintNft
- `calculateFees` is publicly exposed
- No ownership transfer mechanism
- `buy()` marked `payable` but doesn't use ETH · buy
- `metadataFrozen` declared but never used

</details>
