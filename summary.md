# Benchmark Results

> Generated: 2026-03-13

## Overview

| Codebase | Condition | Findings | Duration | Cost |
|----------|-----------|----------|----------|------|
| merkl | V2 | 2 | 5m37s | $2.26 |
| merkl | V1 | 4 | 9m24s | $2.68 |
| merkl | Bare CC | 12 | 3m17s | $0.49 |
| canary | Bare CC | 4 | 25s | $0.10 |
| nft-dealers | Bare CC | 13 | 1m53s | $0.24 |

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

| GT | Finding | V2 | V1 | Bare CC |
| -- | ------- | --- | --- | --- |
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
Bare CC  ████████████████████ 4/4 (100%) reentrancy-vault-withdraw, access-control-setprice, unchecked-return-withdrawunsafe, tx-origin-withdrawfunds
```

### False Positives

```
Bare CC  ░░░░░░░░░░░░░░░░░░░░ 0 FP(s)
```

### Findings

```
Bare CC  ████████████████████ 4 finding(s)
```

### Duration

```
Bare CC  ████████████████████ 25s
```

<details><summary>Bare CC — 4 finding(s)</summary>

- Reentrancy in `Vault.withdraw` · Vault.withdraw
- Missing Access Control on `TokenSale.setPrice` · TokenSale.setPrice
- `tx.origin` Authentication in `TokenSale.withdrawFunds` · TokenSale.withdrawFunds
- Unchecked `send` Return Value in `Vault.withdrawUnsafe` · Vault.withdrawUnsafe

</details>

### Findings Matrix

| GT | Finding | Bare CC |
| -- | ------- | --- |
| reentrancy-vault-withdraw | CEI violation — external call before balance update | ✓ |
| access-control-setprice | No onlyOwner modifier, anyone can set price to zero | ✓ |
| unchecked-return-withdrawunsafe | send() return value ignored, funds lost silently | ✓ |
| tx-origin-withdrawfunds | tx.origin auth enables phishing via intermediary con... | ✓ |

## nft-dealers

### Findings

```
Bare CC  ████████████████████ 13 finding(s)
```

### Duration

```
Bare CC  ████████████████████ 1m53s
```

<details><summary>Bare CC — 13 finding(s)</summary>

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
