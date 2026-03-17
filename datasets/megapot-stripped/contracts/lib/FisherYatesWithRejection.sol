// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title FisherYatesRejection
 * @notice Library implementing Fisher-Yates shuffle with rejection sampling for unbiased random selection
 * @dev Provides cryptographically secure random number selection without modulo bias:
 *      - Uses Fisher-Yates shuffle algorithm for uniform distribution
 *      - Implements rejection sampling to eliminate modulo bias
 *      - Supports configurable range and sample count
 *      - Ensures each selected number has equal probability
 *      - Optimized for jackpot drawing and other applications requiring provable fairness
 *      - Returns selections without replacement (no duplicates)
 */
library FisherYatesRejection {
    uint256 constant MAX_UINT = type(uint256).max;

    /**
     * @notice Generates random numbers using Fisher-Yates shuffle with rejection sampling
     * @dev Implements unbiased random selection by:
     *      1. Building a pool of all numbers in the specified range
     *      2. Using Fisher-Yates shuffle with rejection sampling to avoid modulo bias
     *      3. Selecting the first 'count' numbers from the shuffled pool
     *      The rejection sampling ensures uniform distribution by rejecting random values
     *      that would create bias when reduced to the required range. Developer needs to ensure
     *      that the range is not too large to be able to build an array of the appropriate size
     *      in memory.
     * @param minRange Minimum value in the selection range (inclusive)
     * @param maxRange Maximum value in the selection range (inclusive)
     * @param count Number of unique values to select
     * @param seed Cryptographic seed for random number generation
     * @return result Array of selected numbers in the order they were shuffled
     * @custom:requirements
     * - count must be <= (maxRange - minRange + 1) to ensure sufficient pool size
     * - minRange must be <= maxRange for valid range
     * - seed should be cryptographically secure for unbiased results
     * @custom:effects
     * - Returns 'count' unique numbers from the specified range
     * - Each number in range has equal probability of selection
     * - No duplicates in the result array
     * @custom:security
     * - Rejection sampling eliminates modulo bias
     * - Fisher-Yates algorithm ensures uniform distribution
     * - Deterministic output for given seed enables verification
     * - Gas usage scales with rejection rate (worst case for biased ranges)
     */
    function draw(
        uint256 minRange,
        uint256 maxRange,
        uint256 count,
        uint256 seed
    ) external pure returns (uint256[] memory result) {
        require(count <= maxRange - minRange + 1, "Too many draws");

        // Build pool [1, 2, ..., range]
        uint256 rangeSize = maxRange - minRange + 1;
        uint256[] memory pool = new uint256[](rangeSize);
        for (uint256 i = 0; i < rangeSize; i++) {
            pool[i] = i + minRange;
        }

        uint256 nonce = 0;

        // Fisher-Yates shuffle with rejection sampling
        for (uint256 i = rangeSize - 1; i > 0; i--) {
            uint256 rand;
            while (true) {
                rand = uint256(keccak256(abi.encode(seed, nonce)));
                uint256 limit = (MAX_UINT / (i + 1)) * (i + 1);

                if (rand < limit) {
                    rand = rand % (i + 1);
                    break;
                }
                nonce++;
            }

            // Swap pool[i] and pool[rand]
            (pool[i], pool[rand]) = (pool[rand], pool[i]);
            nonce++;
        }

        // Take first `count` numbers
        result = new uint256[](count);
        for (uint256 j = 0; j < count; j++) {
            result[j] = pool[j];
        }
    }
}
