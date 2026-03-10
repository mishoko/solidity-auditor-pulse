# Benchmark Results

Generated: 2026-03-10T14:10:48.175Z
Runs analyzed: 3

## canary — Root Cause (Run 1)

| Root Cause | V1 Default | V1 Deep | CC Bare |
|------------|---|---|---|
| Reentrancy in `withdraw()` | [100] | [100] | CRITICAL |
| Missing access control on `setPrice()` | [100] | [100] | CRITICAL |
| `tx.origin` authentication in `withdrawFunds()` | [85] | [85] | HIGH |
| Unchecked return value of `send()` | [85] | [100] | HIGH |
| Missing access control on `withdrawUnsafe()` | - | - | MEDIUM |
| Potential overflow in price calculation | - | - | LOW |
| **Total** | **4** | **4** | **6** |
| **Consolidated / Reported** | 4/4 ✓ | 4/4 ✓ | 6/6 ✓ |
| **Duration** | 464s | 278s | 36s |

## Timing Summary

| Codebase | V1 Default | V1 Deep | CC Bare |
|----------|---|---|---|
| canary | 464s | 278s | 36s |
