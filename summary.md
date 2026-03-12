# Benchmark Results

> Generated: 2026-03-12

## Overview

| Codebase | Condition | Findings | Duration | Cost |
|----------|-----------|----------|----------|------|
| canary | V2 | 4 | 3m38s | $0.99 |
| canary | V1 | 4 | 2m14s | $0.71 |
| canary | Bare CC | 4 | 23s | $0.10 |
| merkl | V2 | 2 | 5m37s | $2.26 |
| merkl | V1 | 4 | 9m24s | $2.68 |
| merkl | Bare CC | 12 | 3m17s | $0.49 |

## canary

### Recall

```
V2       ████████████████████ 4/4 (100%) reentrancy-vault-withdraw, access-control-setprice, unchecked-return-withdrawunsafe, tx-origin-withdrawfunds
V1       ████████████████████ 4/4 (100%) reentrancy-vault-withdraw, access-control-setprice, unchecked-return-withdrawunsafe, tx-origin-withdrawfunds
Bare CC  ████████████████████ 4/4 (100%) reentrancy-vault-withdraw, access-control-setprice, unchecked-return-withdrawunsafe, tx-origin-withdrawfunds
```

### False Positives

```
V2       ░░░░░░░░░░░░░░░░░░░░ 0 FP(s)
V1       ░░░░░░░░░░░░░░░░░░░░ 0 FP(s)
Bare CC  ░░░░░░░░░░░░░░░░░░░░ 0 FP(s)
```

### Duration

```
V2       ████████████████████ 3m38s
V1       ████████████░░░░░░░░ 2m14s
Bare CC  ██░░░░░░░░░░░░░░░░░░ 23s
```

### Findings Matrix

| GT | Finding | V2 | V1 | Bare CC |
| -- | ------- | --- | --- | --- |
| ?-reentrancy-vault-withdraw | CEI violation — external call before balance update | [100] | [100] | CRIT |
| ?-access-control-setprice | No onlyOwner modifier, anyone can set price to zero | [100] | [100] | CRIT |
| ?-unchecked-return-withdrawunsafe | send() return value ignored, funds lost silently | [85] | [85] | HIGH |
| ?-tx-origin-withdrawfunds | tx.origin auth enables phishing via intermediary con... | [100] | [100] | HIGH |

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

### Duration

```
V2       ████████████░░░░░░░░ 5m37s
V1       ████████████████████ 9m24s
Bare CC  ███████░░░░░░░░░░░░░ 3m17s
```

### Findings Matrix

| GT | Finding | V2 | V1 | Bare CC |
| -- | ------- | --- | --- | --- |
| M-01 | Minimum Reward-Per-Hour Validation Applied to Gross ... | - | - | - |
| M-02 | Improper Error Handling of onClaim Callback in _clai... | [65] | - | - |
| M-03 | Multi-step campaign overrides are anchored to the or... | - | [78] | - |
| L-01 | resolveDispute reverts when disputer is blacklisted ... | [65] | - | - |
| L-02 | overrideCampaign end timestamp validation uses wrong... | - | [78] | HIGH |
| L-03 | overrideCampaign missing reward rate validation allo... | - | [78] | - |
| L-04 | _createCampaign validates minimum rate on gross amou... | - | - | - |
| L-05 | getMerkleRoot returns old tree during dispute period... | - | - | - |
