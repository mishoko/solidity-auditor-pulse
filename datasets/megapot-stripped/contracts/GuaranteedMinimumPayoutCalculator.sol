//SPDX-License-Identifier: UNLICENSED

/*
Copyright (C) 2025 Coordination Inc.
All rights reserved.

This software is proprietary and confidential. Unauthorized copying,
distribution, or use is strictly prohibited and may result in legal action.

For licensing inquiries: legal@coordinationlabs.com
*/

pragma solidity ^0.8.28;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { Combinations } from "./lib/Combinations.sol";
import { IJackpot } from "./interfaces/IJackpot.sol";
import { IPayoutCalculator } from "./interfaces/IPayoutCalculator.sol";

/**
 * @title GuaranteedMinimumPayoutCalculator
 * @notice Calculates prize payouts using a two-tier system with guaranteed minimums and premium allocation
 * @dev Implements a 12-tier payout system based on jackpot match combinations:
 *      - Tiers 0-11: matches(0-5) × bonusball(no/yes) = matches*2 + (bonusballMatch ? 1 : 0)
 *      - Each tier has configurable minimum payouts and premium pool allocation weights
 *      - Premium pool is allocated proportionally after minimum payouts are satisfied
 *      - Includes both user-owned and LP-owned winning tickets in allocation calculations
 *      - Supports owner-configurable payout parameters that can be updated between drawings
 */
contract GuaranteedMinimumPayoutCalculator is IPayoutCalculator, Ownable {

    // =============================================================
    //                          STRUCTS
    // =============================================================

    struct DrawingTierInfo {
        uint256 minPayout;
        uint256 premiumTierMinAllocation;
        bool[12] minPayoutTiers;
        uint256[12] premiumTierWeights;
    }

    // =============================================================
    //                          ERRORS
    // =============================================================

    error UnauthorizedCaller();
    error ZeroAddress();
    error InvalidTierWeights();
    error InvalidPremiumTierMinimumAllocation();

    // =============================================================
    //                          CONSTANTS
    // =============================================================

    uint256 public constant PRECISE_UNIT = 1e18;
    uint8 constant NORMAL_BALL_COUNT = 5;
    uint8 constant TOTAL_TIER_COUNT = 12; // matches(0,1,2,3,4,5) * bonusball(0,1) = 6 * 2 = 12

    // =============================================================
    //                          STATE VARIABLES
    // =============================================================
    
    // Note:drawingId --> tierId (matches*2 + {1 if bonusball match}) → tier payout
    mapping(uint256=>DrawingTierInfo) public drawingTierInfo;
    mapping(uint256=>mapping(uint256 => uint256)) tierPayouts;

    // Must be 12 elements long (matches(0,1,2,3,4,5) * bonusball(0,1))
    // Allocation of remaining prize pool after minimum payout is accounted for
    uint256[TOTAL_TIER_COUNT] public premiumTierWeights;
    // All tiers eligible for the minimum payout, true if eligible, false if not
    bool[TOTAL_TIER_COUNT] public minPayoutTiers;
    uint256 public minimumPayout;
    uint256 public premiumTierMinAllocation;

    IJackpot public immutable jackpot;

    // =============================================================
    //                          MODIFIERS
    // =============================================================
    
    modifier onlyJackpot() {
        if (msg.sender != address(jackpot)) revert UnauthorizedCaller();
        _;
    }

    // =============================================================
    //                          CONSTRUCTOR
    // =============================================================
    
    /**
     * @notice Initializes the GuaranteedMinimumPayoutCalculator with payout configuration
     * @dev Sets up the connection to the Jackpot contract and initial payout parameters.
     *      Premium tier weights must sum to PRECISE_UNIT for proper allocation.
     * @param _jackpot Address of the main Jackpot contract (immutable reference)
     * @param _minimumPayout Base minimum payout amount for eligible tiers
     * @param _premiumTierMinAllocation Minimum allocation of prize pool for premium tier (in PRECISE_UNIT scale)
     * @param _minPayoutTiers Boolean array indicating which tiers receive minimum payouts (12 elements)
     * @param _premiumTierWeights Weight allocation for premium pool distribution (12 elements, must sum to PRECISE_UNIT)
     * @custom:requirements
     * - Jackpot address must not be zero
     * - Premium tier weights must sum exactly to PRECISE_UNIT
     * - Arrays must be exactly 12 elements (TOTAL_TIER_COUNT)
     * @custom:effects
     * - Sets immutable jackpot contract reference
     * - Initializes minimum payout configuration
     * - Sets up premium tier allocation weights
     * - Sets deployer as contract owner
     * @custom:security
     * - Immutable jackpot reference prevents unauthorized contract changes
     * - Weight sum validation ensures proper allocation
     */
    constructor(
        IJackpot _jackpot,
        uint256 _minimumPayout,
        uint256 _premiumTierMinAllocation,
        bool[TOTAL_TIER_COUNT] memory _minPayoutTiers,
        uint256[TOTAL_TIER_COUNT] memory _premiumTierWeights
    ) Ownable(msg.sender) {
        if (_jackpot == IJackpot(address(0))) revert ZeroAddress();
        if (_premiumTierMinAllocation > PRECISE_UNIT) revert InvalidPremiumTierMinimumAllocation();
        jackpot = _jackpot;
        minimumPayout = _minimumPayout;
        premiumTierMinAllocation = _premiumTierMinAllocation;
        minPayoutTiers = _minPayoutTiers;
        _setPremiumTierWeights(_premiumTierWeights);
    }

    // =============================================================
    //                       EXTERNAL FUNCTIONS
    // =============================================================

    /**
     * @notice Calculates and stores payout amounts for a completed drawing
     * @dev Two-phase payout calculation with premium-protection threshold:
     *      1) Compute total winning tickets per tier, including duplicate user tickets, to avoid under-collateralization.
     *      2) Compute the minimum payout allocation across eligible tiers. Apply minimum payouts only if:
     *         (prizePool * premiumTierMinAllocation / 1e18) + minimumPayoutAllocation < prizePool.
     *         - If the inequality is false (i.e., equality or greater), minimum payouts are disabled for this drawing and the
     *           entire prize pool is allocated by premium weights. This ensures the premium tier receives at least its
     *           configured minimum allocation and avoids arithmetic underflow.
     *      Integer division is used for the premium minimum allocation term; any truncation favors premium protection.
     * @param _drawingId Drawing to calculate payouts for
     * @param _prizePool Total prize pool available for distribution
     * @param _normalMax Maximum normal ball number for combination calculations (assumed valid per Jackpot constraints)
     * @param _bonusballMax Maximum bonusball number for combination calculations (assumed valid per Jackpot constraints)
     * @param _uniqueResult Array of unique winner counts per tier (12 elements, user-owned tickets)
     * @param _dupResult Array of duplicate winner counts per tier (12 elements, user-owned tickets)
     * @return totalPayout Total amount allocated to all user-owned winning tickets
     * @custom:requirements
     * - Caller must be the Jackpot contract
     * - Tier parameters must be snapshotted via setDrawingTierInfo(_drawingId)
     * - `_uniqueResult.length == 12` and `_dupResult.length == 12`
     * - `_normalMax` and `_bonusballMax` provided by Jackpot must be valid for combination math
     * @custom:effects
     * - Calculates total winning ticket counts per tier (LP + users; duplicates included)
     * - Applies minimum payouts only if the premium-protection threshold is satisfied
     * - Distributes the remaining or full prize pool by premium tier weights
     * - Stores per-tier payout amounts in `tierPayouts`
     * - Returns the sum owed to user-owned winning tickets only (unique + duplicate)
     * @custom:security
     * - Access restricted to Jackpot contract
     * - Duplicate winners included in denominator to prevent under-collateralization
     * - Guards against underflow by disabling minimum payouts when insufficient pool remains
     */
    function calculateAndStoreDrawingUserWinnings(
        uint256 _drawingId,
        uint256 _prizePool,
        uint8 _normalMax,
        uint8 _bonusballMax,
        uint256[] memory _uniqueResult,
        uint256[] memory _dupResult
    )
        external
        onlyJackpot
        returns (uint256 totalPayout)
    {   
        DrawingTierInfo storage tierInfo = drawingTierInfo[_drawingId];

        // First calculate the total number of winners for each tier including duplicates and use that to determine guaranteed
        // minimum payouts
        uint256[TOTAL_TIER_COUNT] memory tierWinners;
        uint256 minimumPayoutAllocation = 0;
        for (uint256 i = 0; i < TOTAL_TIER_COUNT; i++) {
            // If tier is not eligible for minimum payout AND gets no part of premium allocation then no winners
            if (!tierInfo.minPayoutTiers[i] && tierInfo.premiumTierWeights[i] == 0) {
                tierWinners[i] = 0;
                continue;
            }
            // Derived from index formula which is matches*2 + {1 if bonusball match} (i/2 is always floored)
            uint256 matches = i / 2;

            // Including _dupResult[i] here takes money from the premium tier pool, if we don't include it we take money from the
            // LP pool reducing edge for LPs. Including here eliminates chances of under-collateralization. The amount of winners within
            // a tier is the total amount of winning tickets available for that tier plus any duplicate winners from that tier. The logic
            // here is that some of the non-duplicate winners are held by LPs and some are held by users. All of the duplicate winners
            // are held by users.
            uint256 tierWinningTickets = _calculateTierTotalWinningCombos(matches, _normalMax, _bonusballMax, i % 2 == 1) + _dupResult[i];
            tierWinners[i] = tierWinningTickets;
            if (tierInfo.minPayoutTiers[i]) {
                minimumPayoutAllocation += tierWinningTickets * tierInfo.minPayout;
            }
        }
        
        // Only use minimum payouts if the premium tier minimum allocation + minimum payout allocation is less than the prize pool
        bool useMinimumPayouts = ((_prizePool * tierInfo.premiumTierMinAllocation / PRECISE_UNIT) + minimumPayoutAllocation) < _prizePool;

        totalPayout = _calculateAndStoreTierPayouts(
            _drawingId,
            useMinimumPayouts ? _prizePool - minimumPayoutAllocation : _prizePool,
            useMinimumPayouts ? tierInfo.minPayout : 0,
            tierWinners,
            _uniqueResult,
            _dupResult
        );
    }

    /**
     * @notice Snapshots current payout configuration for a specific drawing
     * @dev Freezes current minimumPayout, minPayoutTiers, and premiumTierWeights into drawingTierInfo,
     *      allowing future configuration changes without affecting this drawing's payout calculations.
     * @param _drawingId Drawing to set up tier information for
     * @custom:requirements
     * - Only Jackpot contract can call
     * - Should be called before drawing execution
     * @custom:emits None
     * @custom:effects
     * - Creates immutable snapshot of current payout configuration
     * - Enables payout calculations for the specific drawing
     * - Allows future parameter updates without affecting this drawing
     * @custom:security
     * - Access restricted to Jackpot contract
     * - Ensures drawing payout consistency regardless of future changes
     */
    function setDrawingTierInfo(uint256 _drawingId) external onlyJackpot {
        drawingTierInfo[_drawingId] = DrawingTierInfo({
            minPayout: minimumPayout,
            premiumTierMinAllocation: premiumTierMinAllocation,
            minPayoutTiers: minPayoutTiers,
            premiumTierWeights: premiumTierWeights
        });
    }

    // =============================================================
    //                        ADMIN FUNCTIONS
    // =============================================================
    
    /**
     * @notice Updates the base minimum payout amount
     * @dev Changes the guaranteed minimum payout for all eligible tiers in future drawings.
     *      Does not affect drawings that have already had tier info set.
     * @param _minimumPayout New minimum payout amount (in USDC wei)
     * @custom:requirements
     * - Only owner can call
     * @custom:emits None
     * @custom:effects
     * - Updates global minimum payout configuration
     * - Affects future drawings only (after setDrawingTierInfo is called)
     * @custom:security
     * - Owner-only access restriction
     */
    function setMinimumPayout(uint256 _minimumPayout) external onlyOwner {
        minimumPayout = _minimumPayout;
    }
    
    /**
     * @notice Updates which tiers are eligible for minimum guaranteed payouts
     * @dev Configures which of the 12 tiers receive minimum payout guarantees in future drawings.
     *      Tiers with false values rely solely on premium pool allocation.
     * @param _minPayoutTiers Boolean array indicating minimum payout eligibility (12 elements)
     * @custom:requirements
     * - Only owner can call
     * - Array must be exactly 12 elements (TOTAL_TIER_COUNT)
     * @custom:emits None
     * @custom:effects
     * - Updates minimum payout tier configuration
     * - Affects future drawings only (after setDrawingTierInfo is called)
     * - Tiers set to false will only receive premium pool allocation
     * @custom:security
     * - Owner-only access restriction
     * - Array length validation
     */
    function setMinPayoutTiers(bool[TOTAL_TIER_COUNT] memory _minPayoutTiers) external onlyOwner {
        minPayoutTiers = _minPayoutTiers;
    }

    /**
     * @notice Updates the minimum allocation of the prize pool reserved for premium tier distribution
     * @dev Sets the minimum percentage of the total prize pool that must be allocated to premium tiers.
     *      This ensures premium tiers receive adequate funding even when minimum payouts consume most of the pool.
     *      The allocation is enforced during payout calculations by making sure the minimum payout allocation + 
     *      minimum premium allocation is less than the prize pool. If this equality fails then minimum payouts
     *      are disabled and the entire prize pool is distributed to the premium tiers.
     * @param _premiumTierMinAllocation Minimum allocation percentage in PRECISE_UNIT scale (e.g., 0.1e18 = 10%)
     * @custom:requirements
     * - Only owner can call
     * - Allocation percentage must not exceed 100% (PRECISE_UNIT)
     * @custom:emits None
     * @custom:effects
     * - Updates global premium tier minimum allocation configuration
     * - Affects future drawings only (after setDrawingTierInfo is called)
     * - Changes how prize pool is split between minimum payouts and premium allocation
     * @custom:security
     * - Owner-only access restriction
     * - Upper bound validation prevents invalid allocation percentages
     * - Ensures balanced distribution between guaranteed minimums and premium rewards
     */
    function setPremiumTierMinAllocation(uint256 _premiumTierMinAllocation) external onlyOwner {
        if (_premiumTierMinAllocation > PRECISE_UNIT) revert InvalidPremiumTierMinimumAllocation();
        premiumTierMinAllocation = _premiumTierMinAllocation;
    }

    /**
     * @notice Updates premium tier weight allocation
     * @dev Changes how the premium prize pool (after minimum payouts) is distributed across tiers.
     *      Weights must sum to PRECISE_UNIT to ensure complete allocation.
     * @param _premiumTierWeights Array of allocation weights (12 elements, must sum to PRECISE_UNIT)
     * @custom:requirements
     * - Only owner can call
     * - Array must be exactly 12 elements (TOTAL_TIER_COUNT)
     * - Weights must sum exactly to PRECISE_UNIT (1e18)
     * @custom:emits None
     * @custom:effects
     * - Updates premium pool allocation weights
     * - Affects future drawings only (after setDrawingTierInfo is called)
     * - Changes how remaining prize pool is distributed after minimum payouts
     * @custom:security
     * - Owner-only access restriction
     * - Weight sum validation ensures complete allocation
     * - Array length validation
     */
    function setPremiumTierWeights(uint256[TOTAL_TIER_COUNT] memory _premiumTierWeights) external onlyOwner {
        _setPremiumTierWeights(_premiumTierWeights);
    }

    // =============================================================
    //                        VIEW FUNCTIONS
    // =============================================================
    
    /**
     * @notice Returns the calculated payout amount for a specific tier in a drawing
     * @dev Retrieves the final payout amount per winning ticket for the specified tier.
     *      Returns 0 if no payout has been calculated or tier had no winners.
     * @param _drawingId Drawing to query
     * @param _tierId Tier to query (0-11, calculated as matches*2 + bonusballMatch)
     * @return Payout amount per winning ticket for the tier (in USDC wei)
     */
    function getTierPayout(uint256 _drawingId, uint256 _tierId) external view returns (uint256) {
        return tierPayouts[_drawingId][_tierId];
    }

    /**
     * @notice Returns all tier payouts for a specific drawing
     * @dev Retrieves the complete array of payout amounts for all 12 tiers in a drawing.
     *      Useful for displaying complete payout structure or performing batch calculations.
     * @param _drawingId Drawing to query
     * @return Array of payout amounts for all tiers (12 elements, in USDC wei)
     */
    function getDrawingTierPayouts(uint256 _drawingId) external view returns (uint256[TOTAL_TIER_COUNT] memory) {
        uint256[TOTAL_TIER_COUNT] memory drawingTierPayouts;
        for (uint256 i = 0; i < TOTAL_TIER_COUNT; i++) {
            drawingTierPayouts[i] = tierPayouts[_drawingId][i];
        }
        return drawingTierPayouts;
    }

    /**
     * @notice Returns current minimum payout tier configuration
     * @dev Shows which tiers are currently eligible for minimum guaranteed payouts.
     *      This reflects the current configuration, not necessarily what was used for past drawings.
     * @return Boolean array indicating minimum payout eligibility for each tier (12 elements)
     */
    function getMinPayoutTiers() external view returns (bool[TOTAL_TIER_COUNT] memory) {
        return minPayoutTiers;
    }

    /**
     * @notice Returns current premium tier weight configuration
     * @dev Shows current premium pool allocation weights across all tiers.
     *      This reflects the current configuration, not necessarily what was used for past drawings.
     * @return Array of premium pool allocation weights (12 elements, sum to PRECISE_UNIT)
     */
    function getPremiumTierWeights() external view returns (uint256[TOTAL_TIER_COUNT] memory) {
        return premiumTierWeights;
    }

    /**
     * @notice Returns the complete tier configuration used for a specific drawing
     * @dev Retrieves the snapshot of payout configuration that was frozen for the drawing.
     *      This shows the exact parameters used for payout calculations.
     * @param _drawingId Drawing to query
     * @return DrawingTierInfo struct containing minimum payout, tier eligibility, and premium weights
     */
    function getDrawingTierInfo(uint256 _drawingId) external view returns (DrawingTierInfo memory) {
        return drawingTierInfo[_drawingId];
    }

    // =============================================================
    //                        INTERNAL FUNCTIONS
    // =============================================================
    function _setPremiumTierWeights(uint256[TOTAL_TIER_COUNT] memory _premiumTierWeights) internal {
        uint256 tierWeightSum = 0;
        for (uint256 i = 0; i < TOTAL_TIER_COUNT; i++) {
            tierWeightSum += _premiumTierWeights[i];
        }
        if (tierWeightSum != PRECISE_UNIT) revert InvalidTierWeights();

        premiumTierWeights = _premiumTierWeights;
    }

    function _calculateAndStoreTierPayouts(
        uint256 _drawingId,
        uint256 _remainingPrizePool,
        uint256 _minPayout,
        uint256[TOTAL_TIER_COUNT] memory _tierWinners,
        uint256[] memory _uniqueResult,
        uint256[] memory _dupResult
    )
        internal
        returns(uint256 totalPayout)
    {
        DrawingTierInfo storage tierInfo = drawingTierInfo[_drawingId];
        for (uint256 i = 0; i < TOTAL_TIER_COUNT; i++) {
            // If no winners then no payout
            if (_tierWinners[i] != 0) {
                // Calculate the payout for each tier from the (remaining prize pool * weight) / total winning tickets
                //(including LP-owned winning tickets)
                uint256 premiumTierPayoutAmount = _remainingPrizePool * tierInfo.premiumTierWeights[i] / (PRECISE_UNIT * _tierWinners[i]);
                // Add the premium tier payout to the minimum payout if the tier is eligible for the minimum payout
                uint256 tierPayout = tierInfo.minPayoutTiers[i] ? _minPayout + premiumTierPayoutAmount : premiumTierPayoutAmount;
                // Store the payout for the tier in the mapping so it can be queried later and add the total tier payout to the total payout
                tierPayouts[_drawingId][i] = tierPayout;
                // the total amount of user-owned winning tickets for a given tier is the sum of result and dupResult
                totalPayout += tierPayout * (_uniqueResult[i] + _dupResult[i]);
            }
        }
    }

    function _calculateTierTotalWinningCombos(
        uint256 _matches,
        uint8 _normalMax, 
        uint8 _bonusballMax,
        bool _bonusballMatch
    )
        internal
        pure
        returns(uint256)
    {
        if (_bonusballMatch) {
            return Combinations.choose(NORMAL_BALL_COUNT, _matches) * Combinations.choose(_normalMax - NORMAL_BALL_COUNT, NORMAL_BALL_COUNT - _matches);
        } else {
            return Combinations.choose(NORMAL_BALL_COUNT, _matches) * Combinations.choose(_normalMax - NORMAL_BALL_COUNT, NORMAL_BALL_COUNT - _matches) * (_bonusballMax - 1);
        }
    }
}
