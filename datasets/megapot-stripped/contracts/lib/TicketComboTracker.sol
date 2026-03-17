// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Combinations } from "./Combinations.sol";
import { LibBit } from "solady/src/utils/LibBit.sol";

/**
 * @title TicketComboTracker
 * @notice Library for tracking jackpot ticket combinations and calculating win distributions efficiently
 * @dev Implements scalable settlement calculations using bit vectors and inclusion-exclusion principle:
 *      - Stores ticket combinations as bit vectors for efficient subset operations
 *      - Tracks both unique and duplicate ticket counts per combination subset
 *      - Uses inclusion-exclusion principle to avoid double-counting when calculating payouts
 *      - Enables O(1) duplicate detection and efficient tier-based payout calculations
 *      - Supports configurable normal ball ranges and bonusball values
 *      - Optimized for gas efficiency in high-volume jackpot scenarios
 */
library TicketComboTracker {
    struct ComboCount {
        uint128 count;
        uint128 dupCount;
    }

    struct Tracker {
        uint8 normalMax;
        uint8 bonusballMax;
        uint8 normalTiers;
        mapping(uint8 => mapping(uint256 => ComboCount)) comboCounts;
        mapping(uint8 => ComboCount) bonusballTicketCounts;
    }

    /**
     * @notice Initializes a combo tracker with jackpot configuration parameters
     * @dev Sets up the tracker with ball ranges and tier configuration for efficient combo tracking.
     *      Must be called before using any other tracker functions.
     * @param tracker Storage reference to the tracker being initialized
     * @param _normalMax Maximum value for normal balls (1 to this value)
     * @param _bonusballMax Maximum value for bonusball (1 to this value)
     * @param _normalTiers Number of normal balls per ticket (typically 5)
     * @custom:effects
     * - Configures tracker parameters for combo calculations
     * - Prepares tracker for ticket insertion and counting operations
     * @custom:security
     * - No validation as this is internal initialization
     * - Caller responsible for providing valid parameters
     */
    function init(
        Tracker storage tracker,
        uint8 _normalMax,
        uint8 _bonusballMax,
        uint8 _normalTiers
    ) internal {
        tracker.normalMax = _normalMax;
        tracker.bonusballMax = _bonusballMax;
        tracker.normalTiers = _normalTiers;
    }

    /**
     * @notice Converts an array of normal ball numbers to a bit vector representation
     * @dev Creates a bit vector where each bit position represents a ball number.
     *      Validates no duplicates and all numbers are within valid range.
     * @param _set Array of ball numbers to convert
     * @param _maxNormalBall Maximum valid ball number
     * @return Bit vector representation where bit N is set if ball N is selected
     * @custom:requirements
     * - Set must not be empty
     * - All numbers must be > 0 and <= _maxNormalBall
     * - No duplicate numbers allowed
     * @custom:security
     * - Validates range and uniqueness to prevent invalid combinations
     * - Uses bit operations for efficient duplicate detection
     */
    function toNormalsBitVector(
        uint8[] memory _set,
        uint256 _maxNormalBall
    )
        internal
        pure
        returns (uint256)
    {
        require(_set.length != 0, "Invalid set length");
        uint256 bitVector = 0;
        for (uint256 i; i < _set.length; ++i) {
            require(_set[i] <= _maxNormalBall && _set[i] > 0, "Invalid set selection");
            require((bitVector & (1 << _set[i])) == 0, "Duplicate number in set");
            bitVector |= 1 << _set[i];
        }
        return bitVector;
    }

    /**
     * @notice Inserts a ticket combination into the tracker and updates subset counts
     * @dev Converts ticket to bit vector, generates all subsets, and updates counts.
     *      Distinguishes between first purchase of a ticket (unique) and duplicates for
     *      payout calculations. 
     * @param _tracker Storage reference to the tracker
     * @param _normalBalls Array of normal ball numbers
     * @param _bonusball Bonusball number
     * @return ticketNumbers Bit vector representation of the complete ticket
     * @return isDup True if this exact combination was already inserted
     * @custom:requirements
     * - Normal balls array length must match tracker.normalTiers
     * - All ball numbers must be valid per tracker configuration
     * @custom:effects
     * - Updates counts for all subset combinations of the ticket
     * - Increments either unique or duplicate counts based on prior existence
     * - Tracks bonusball-specific subset counts for tier calculations
     * @custom:security
     * - Validates ticket format matches tracker configuration
     * - Prevents invalid combinations through bit vector validation
     */
    function insert(
        Tracker storage _tracker,
        uint8[] memory _normalBalls,
        uint8 _bonusball
    )
        internal
        returns (uint256 ticketNumbers, bool isDup)
    {
        require(_normalBalls.length == _tracker.normalTiers, "Invalid pick length");
        uint256 set = toNormalsBitVector(_normalBalls, _tracker.normalMax);
        // Iterate over all tier combos and store the combo counts
        isDup = _tracker.comboCounts[_bonusball][set].count > 0;
        for (uint8 i = 1; i <= _tracker.normalTiers; i++) {
            uint256[] memory subsets = Combinations.generateSubsets(set, i);
            for (uint256 j = 0; j < subsets.length; j++) {
                if (isDup) {
                    _tracker.comboCounts[_bonusball][subsets[j]].dupCount++;
                } else {
                    _tracker.comboCounts[_bonusball][subsets[j]].count++;
                }
            }
        }

        if (isDup) {
            _tracker.bonusballTicketCounts[_bonusball].dupCount++;
        } else {
            _tracker.bonusballTicketCounts[_bonusball].count++;
        }

        // Add the bonusball to the bit vector
        ticketNumbers = set |= 1 << (_bonusball + _tracker.normalMax);
    }

    function _countSubsetMatches(
        Tracker storage _tracker,
        uint256 _normalBallsBitVector,
        uint8 _bonusball
    )
        private
        view
        returns (uint256[] memory matches, uint256[] memory dupMatches)
    {
        matches = new uint256[]((_tracker.normalTiers+1)*2);
        dupMatches = new uint256[]((_tracker.normalTiers+1)*2);
        
        for (uint8 i = 1; i <= _tracker.bonusballMax; i++) {
            for (uint8 k = 1; k <= _tracker.normalTiers; k++) {
                uint256[] memory subsets = Combinations.generateSubsets(_normalBallsBitVector, k);
                for (uint256 l = 0; l < subsets.length; l++) {
                    if (i == _bonusball) {
                        matches[(k*2)+1] += _tracker.comboCounts[i][subsets[l]].count;
                        dupMatches[k*2+1] += _tracker.comboCounts[i][subsets[l]].dupCount;
                    } else {
                        matches[(k*2)] += _tracker.comboCounts[i][subsets[l]].count;
                        dupMatches[k*2] += _tracker.comboCounts[i][subsets[l]].dupCount;
                    }
                }
            }
        }
    }

    function _applyInclusionExclusionPrinciple(
        Tracker storage _tracker,
        uint256[] memory _matches,
        uint256[] memory _dupMatches
    )
        private
        view
        returns (uint256[] memory result, uint256[] memory dupResult)
    {
        result = new uint256[](_matches.length);
        dupResult = new uint256[](_dupMatches.length);
        
        // Solve top-down (starting from "all matched")
        for (uint256 k = _tracker.normalTiers; k >= 1; --k) {
            uint256 s = _matches[2*k];
            uint256 sp = _matches[2*k+1];
            uint256 sd = _dupMatches[2*k];
            uint256 sdp = _dupMatches[2*k+1];
            
            // Repeatedly subtract higher-tier counts that spill over into this tier
            for (uint256 m = k + 1; m <= _tracker.normalTiers; ++m) {
                // Each higher-tier ticket contributes C(m,k) subsets to this tier
                uint256 c = Combinations.choose(m, k);
                s -= c * result[2*m];
                sp -= c * result[2*m+1];
                sd -= c * dupResult[2*m];
                sdp -= c * dupResult[2*m+1];
            }
            
            result[2*k] = s;
            result[2*k+1] = sp;
            dupResult[2*k] = sd;
            dupResult[2*k+1] = sdp;
        }
    }

    function _calculateBonusballOnlyMatches(
        Tracker storage _tracker,
        uint8 _bonusball,
        uint256[] memory _uniqueResult,
        uint256[] memory _dupResult
    )
        private
        view
    {
        // Start with all bonusball-only tickets
        _uniqueResult[1] = _tracker.bonusballTicketCounts[_bonusball].count;
        _dupResult[1] = _tracker.bonusballTicketCounts[_bonusball].dupCount;
        
        // Subtract tickets that also match normal balls (they're counted in higher tiers)
        for (uint256 i = 1; i <= _tracker.normalTiers; i++) {
            _uniqueResult[1] -= _uniqueResult[2*i + 1];
            _dupResult[1] -= _dupResult[2*i + 1];
        }
    }

    /**
     * @notice Calculates winning ticket counts across all tiers for given winning numbers
     * @dev Implements three-phase calculation to determine exact winner counts per tier:
     *      1. Count all subset matches across bonusball values
     *      2. Apply inclusion-exclusion principle to remove double-counting
     *      3. Calculate bonusball-only matches (0 normal matches + bonusball)
     * @param _tracker Storage reference to the tracker
     * @param _normalBalls Array of winning normal ball numbers
     * @param _bonusball Winning bonusball number
     * @return winningTicket Bit vector representation of the winning combination
     * @return uniqueResult Array of unique winner counts per tier (indexed by tier ID)
     * @return dupResult Array of duplicate winner counts per tier (indexed by tier ID)
     * @custom:effects
     * - Generates comprehensive winner statistics for payout calculations
     * - Separates unique and duplicate winners for accurate settlement
     * - Covers all 12 tiers: matches(0-5) + bonusball(0/1)
     * @custom:security
     * - Read-only operation with no state changes
     * - Uses mathematical inclusion-exclusion for accurate counting
     * - Prevents over-counting tickets in multiple tiers
     */
    function countTierMatchesWithBonusball(
        Tracker storage _tracker,
        uint8[] memory _normalBalls,
        uint8 _bonusball
    )
        internal
        view
        returns (uint256 winningTicket, uint256[] memory uniqueResult, uint256[] memory dupResult)
    {
        uint256 set = toNormalsBitVector(_normalBalls, _tracker.normalMax);
        winningTicket = set | (1 << (_bonusball + _tracker.normalMax));

        // Step 1: Count all subset matches across all bonusballs
        (uint256[] memory matches, uint256[] memory dupMatches) = _countSubsetMatches(_tracker, set, _bonusball);
        
        // Step 2: Apply inclusion-exclusion principle to remove double counting
        (uniqueResult, dupResult) = _applyInclusionExclusionPrinciple(_tracker, matches, dupMatches);
        
        // Step 3: Calculate bonusball-only matches (no normal balls matched)
        _calculateBonusballOnlyMatches(_tracker, _bonusball, uniqueResult, dupResult);
    }

    /**
     * @notice Checks if a ticket combination has already been inserted into the tracker
     * @dev Efficiently determines duplicate status by checking if the exact combination
     *      has a non-zero count in the tracker's storage.
     * @param _tracker Storage reference to the tracker
     * @param _normalBalls Array of normal ball numbers to check
     * @param _bonusball Bonusball number to check
     * @return True if this exact combination exists in the tracker
     * @custom:requirements
     * - Normal balls array length must match tracker configuration
     * - All ball numbers must be valid per tracker setup
     * @custom:security
     * - Read-only operation with no state changes
     * - Validates input format before processing
     * - Uses efficient bit vector lookup for O(1) duplicate detection
     */
    function isDuplicate(
        Tracker storage _tracker,
        uint8[] memory _normalBalls,
        uint8 _bonusball
    )
        internal
        view
        returns (bool)
    {
        require(_normalBalls.length == _tracker.normalTiers, "Invalid set length");
        uint256 set = toNormalsBitVector(_normalBalls, _tracker.normalMax);
        return _tracker.comboCounts[_bonusball][set].count > 0;
    }

    /**
     * @notice Unpacks a bit vector representation back into separate normal balls and bonusball number
     * @dev Extracts individual ball numbers from a packed ticket by scanning bit positions.
     *      Normal balls are stored at bit positions 1 to _normalMax, bonusball at position (_normalMax + bonusball_value).
     *      Uses LibBit operations for efficient bit scanning and counting to reconstruct original ticket.
     * @param _packedTicket Bit vector representation of the complete ticket
     * @param _normalMax Maximum value for normal balls (defines boundary between normal and bonusball bits)
     * @return normalBalls Array of normal ball numbers extracted from bit positions 1 to _normalMax
     * @return bonusball Bonusball number calculated from highest set bit position minus _normalMax
     * @custom:requirements
     * - Packed ticket must contain valid bit pattern with at least one bonusball bit set
     * - Normal ball bits must be within positions 1 to _normalMax if present
     * - Bonusball bit must be at position > _normalMax
     * @custom:effects
     * - Scans bit vector to extract individual ball numbers in ascending order
     * - Reconstructs original ticket structure from packed representation
     * - No state changes as this is a pure function
     * @custom:security
     * - Read-only operation with no side effects or external calls
     * - Uses efficient LibBit operations to prevent gas issues with large bit vectors
     * - Handles edge cases like single-ball tickets and sparse patterns gracefully
     */
    function unpackTicket(
        uint256 _packedTicket,
        uint8 _normalMax
    )
        internal
        pure
        returns (uint8[] memory normalBalls, uint8 bonusball)
    {
        uint256 ballCount = LibBit.popCount(_packedTicket);
        normalBalls = new uint8[](ballCount - 1);
        uint256 p;
        for (uint256 i = 1; i <= _normalMax; i++) {
            if (_packedTicket & (1 << i) != 0) {
                normalBalls[p++] = uint8(i);
            }
        }

        // Find the bonusball bit position and subtract _normalMax to get the bonusball value
        bonusball = uint8(LibBit.fls(_packedTicket) - _normalMax);
    }
}