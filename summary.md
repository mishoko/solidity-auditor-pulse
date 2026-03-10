# Benchmark Results

## canary — Root Cause (Run 1)

| Root Cause                                            | V2            | V1 Default    | V1 Deep | CC Bare  |
| ----------------------------------------------------- | ------------- | ------------- | ------- | -------- |
| Reentrancy in `withdraw()`                            | [100]         | [100]         | -       | CRITICAL |
| Missing access control on `setPrice()`                | [100]         | [100]         | -       | CRITICAL |
| `tx.origin` authentication in `withdrawFunds()`       | [100]         | [85]          | -       | HIGH     |
| Unchecked `send()` return value in `withdrawUnsafe()` | [85]          | [85]          | -       | HIGH     |
| (FP) ~Missing access control on `withdrawUnsafe()`~   | -             | -             | -       | MEDIUM   |
| (FP) ~Potential arithmetic edge case in `buy()`~      | -             | -             | -       | LOW      |
| **Total**                                             | **4**         | **4**         | **0**   | **6**    |
| **Recall**                                            | **4/4**       | **4/4**       | **0/4** | **4/4**  |
| **FPs**                                               | **0**         | **0**         | **0**   | **2**    |
| **Duration**                                          | 558s (9m 18s) | 356s (5m 56s) | 34s     | 37s      |

## canary — Root Cause (Run 2)

| Root Cause                                                       | V2            | V1 Default    | V1 Deep       | CC Bare  |
| ---------------------------------------------------------------- | ------------- | ------------- | ------------- | -------- |
| Reentrancy in `withdraw()`                                       | [100]         | [100]         | [100]         | CRITICAL |
| Missing access control on `setPrice()`                           | [100]         | [100]         | [100]         | CRITICAL |
| Unchecked return value in `withdrawUnsafe()`                     | [90]          | [95]          | [85]          | HIGH     |
| tx.origin Authentication Enables Phishing Drain                  | [80]          | [100]         | [90]          | HIGH     |
| (FP) ~Read-Only Reentrancy via getBalance() Exposes Stale State~ | -             | -             | [80]          | -        |
| (FP) ~Missing access control on `withdrawUnsafe()`~              | -             | -             | -             | MEDIUM   |
| (FP) ~Potential multiplication overflow in `buy()`~              | -             | -             | -             | LOW      |
| **Total**                                                        | **4**         | **4**         | **5**         | **6**    |
| **Recall**                                                       | **4/4**       | **4/4**       | **4/4**       | **4/4**  |
| **FPs**                                                          | **0**         | **0**         | **1**         | **2**    |
| **Duration**                                                     | 278s (4m 38s) | 532s (8m 52s) | 295s (4m 55s) | 38s      |

## canary — Root Cause (Run 3)

| Root Cause                                          | V2            | V1 Default    | V1 Deep        | CC Bare |
| --------------------------------------------------- | ------------- | ------------- | -------------- | ------- |
| Reentrancy in `withdraw()`                          | [100]         | [100]         | -              | HIGH    |
| Missing access control on `setPrice()`              | [100]         | [100]         | -              | HIGH    |
| `tx.origin` authentication in `withdrawFunds()`     | [100]         | [85]          | -              | HIGH    |
| Unchecked return value in `withdrawUnsafe()`        | [85]          | [85]          | -              | MEDIUM  |
| (FP) ~Missing access control on `withdrawUnsafe()`~ | -             | -             | -              | MEDIUM  |
| (FP) ~Potential overflow in `buy()`~                | -             | -             | -              | LOW     |
| **Total**                                           | **4**         | **4**         | **0**          | **6**   |
| **Recall**                                          | **4/4**       | **4/4**       | **0/4**        | **4/4** |
| **FPs**                                             | **0**         | **0**         | **0**          | **2**   |
| **Duration**                                        | 335s (5m 35s) | 342s (5m 42s) | 881s (14m 41s) | 39s     |

*Generated: 2026-03-10T19:24:41.872Z*
