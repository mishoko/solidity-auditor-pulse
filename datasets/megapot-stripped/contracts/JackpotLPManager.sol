//SPDX-License-Identifier: UNLICENSED

/*
Copyright (C) 2025 Coordination Inc.
All rights reserved.

This software is proprietary and confidential. Unauthorized copying,
distribution, or use is strictly prohibited and may result in legal action.

For licensing inquiries: legal@coordinationlabs.com
*/

pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IJackpot } from "./interfaces/IJackpot.sol";
import { IJackpotLPManager } from "./interfaces/IJackpotLPManager.sol";
import { JackpotErrors } from "./lib/JackpotErrors.sol";

/**
 * @title JackpotLPManager
 * @notice Manages liquidity provider deposits, withdrawals, and share calculations using an accumulator-based pricing system
 * @dev Implements an LP management system with:
 *      - Accumulator-based share pricing for fair LP value distribution
 *      - Pending deposit/withdrawal system to handle drawing transitions
 *      - Consolidation mechanics for multi-drawing LP positions
 *      - Emergency withdrawal capabilities for system recovery
 */
contract JackpotLPManager is IJackpotLPManager, Ownable {

    // =============================================================
    //                          STRUCTS
    // =============================================================

    struct DepositInfo {
        uint256 amount;
        uint256 drawingId;
    }

    struct WithdrawalInfo {
        uint256 amountInShares;
        uint256 drawingId;
    }

    struct LP {
        uint256 consolidatedShares; // Note: this is the amount in shares, not usdc
        DepositInfo lastDeposit; // Note: this is the amount in usdc, not shares
        WithdrawalInfo pendingWithdrawal; // Note: this is the amount in shares, not usdc
        uint256 claimableWithdrawals; // Note: this is the amount in usdc, not shares
    }

    struct LPValueBreakdown {
        uint256 activeDeposits;
        uint256 pendingDeposits;
        uint256 pendingWithdrawals;
        uint256 claimableWithdrawals;
    }

    // =============================================================
    //                          EVENTS
    // =============================================================
    event LpDeposited(
        address indexed lpAddress,
        uint256 indexed currentDrawingId,
        uint256 amount,
        uint256 totalPendingDeposits
    );

    event LpWithdrawInitiated(
        address indexed lpAddress,
        uint256 indexed currentDrawingId,
        uint256 amount,
        uint256 totalPendingWithdrawals
    );

    event LpWithdrawFinalized(
        address indexed lpAddress,
        uint256 indexed currentDrawingId,
        uint256 amount
    );

    // =============================================================
    //                          ERRORS
    // =============================================================

    error UnauthorizedCaller();
    error ZeroAddress();
    error InvalidLPPoolCap();

    // =============================================================
    //                          CONSTANTS
    // =============================================================

    uint256 constant PRECISE_UNIT = 1e18;

    // =============================================================
    //                          STATE VARIABLES
    // =============================================================

    mapping(uint256 => LPDrawingState) internal lpDrawingState;
    mapping(address => LP) public lpInfo;
    mapping(uint256 => uint256) public drawingAccumulator;
    uint256 public lpPoolCap;

    IJackpot public jackpot;

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
     * @notice Initializes the JackpotLPManager with the Jackpot contract reference
     * @dev Sets up the connection to the main Jackpot contract that will call LP management functions
     * @param _jackpot Address of the main Jackpot contract
     * @custom:requirements
     * - Jackpot address must not be zero address
     * @custom:effects
     * - Sets jackpot contract reference
     * - Sets deployer as owner
     * @custom:security
     * - Zero address validation for jackpot contract
     */
    constructor(IJackpot _jackpot) Ownable(msg.sender) {
        if (_jackpot == IJackpot(address(0))) revert ZeroAddress();
        jackpot = _jackpot;
    }

    // =============================================================
    //                          EXTERNAL FUNCTIONS
    // =============================================================

    /**
     * @notice Initializes the LP system with the first accumulator value
     * @dev Sets up the initial accumulator value for share calculations. Called during Jackpot initialization.
     * @custom:requirements
     * - Only Jackpot contract can call
     * - Must not already be initialized
     * @custom:effects
     * - Sets drawingAccumulator[0] to PRECISE_UNIT
     * - Enables LP deposit functionality
     * @custom:security
     * - Single initialization enforcement
     * - Access restricted to Jackpot contract
     */
    function initializeLP() external onlyJackpot() {
        drawingAccumulator[0] = PRECISE_UNIT;
    }

    /**
     * @notice Processes a new LP deposit for the current drawing
     * @dev Consolidates any previous deposits from earlier drawings. If deposit already made for current drawing then amount is added to current pending amount.
     *      Deposits are held as pending until the drawing settles, then converted to shares.
     * @param _drawingId Current drawing ID
     * @param _lpAddress Address making the deposit
     * @param _amount Amount of USDC being deposited
     * @custom:requirements
     * - Only Jackpot contract can call
     * - Deposit would not exceed LP pool cap
     * - Drawing accumulator must be initialized
     * @custom:emits LpDeposited
     * @custom:effects
     * - Consolidates previous deposits if any
     * - Creates new deposit record or adds to existing pending amount
     * - Updates total pending deposits for drawing
     * @custom:security
     * - Access restricted to Jackpot contract
     * - Pool cap validation prevents over-deposits
     */
    function processDeposit(uint256 _drawingId, address _lpAddress, uint256 _amount) external onlyJackpot() {
        // Note: this check also prevents users from depositing before initializeLPDeposits() is called since the pool cap will be 0
        // We will exclude pending withdrawals since the amount withdrawn is dependent on the post-drawing LP value. This makes this
        // check more conservative.
        uint256 totalPoolValue = lpDrawingState[_drawingId].lpPoolTotal + lpDrawingState[_drawingId].pendingDeposits;
        if (_amount + totalPoolValue > lpPoolCap) revert JackpotErrors.ExceedsPoolCap();

        LP storage lp = lpInfo[_lpAddress];

        _consolidateDeposits(lp, _drawingId);

        lp.lastDeposit.amount += _amount;
        lp.lastDeposit.drawingId = _drawingId;

        lpDrawingState[_drawingId].pendingDeposits += _amount;

        emit LpDeposited(_lpAddress, _drawingId, _amount, lpDrawingState[_drawingId].pendingDeposits);
    }

    /**
     * @notice Initiates withdrawal by converting consolidated shares to pending
     * @dev Moves shares from active to pending status, preventing further use until finalization.
     *      Automatically consolidates previous deposits before processing withdrawal.
     * @param _drawingId Current drawing ID
     * @param _lpAddress Address initiating withdrawal
     * @param _amountToWithdrawInShares Amount of shares to withdraw
     * @custom:requirements
     * - Only Jackpot contract can call
     * - LP must have sufficient consolidated shares
     * @custom:emits LpWithdrawInitiated
     * @custom:effects
     * - Consolidates previous deposits if any
     * - Moves shares to pending withdrawal status
     * - Updates drawing pending withdrawal total
     * - Reduces consolidated shares balance
     * @custom:security
     * - Access restricted to Jackpot contract
     * - Share balance validation
     */
    function processInitiateWithdraw(uint256 _drawingId, address _lpAddress, uint256 _amountToWithdrawInShares) external onlyJackpot() {
        LP storage lp = lpInfo[_lpAddress];

        _consolidateDeposits(lp, _drawingId);

        if (lp.consolidatedShares < _amountToWithdrawInShares) revert JackpotErrors.InsufficientShares();

        _consolidateWithdrawals(lp, _drawingId);

        lp.pendingWithdrawal.amountInShares += _amountToWithdrawInShares;
        lp.pendingWithdrawal.drawingId = _drawingId;

        lp.consolidatedShares -= _amountToWithdrawInShares;
        lpDrawingState[_drawingId].pendingWithdrawals += _amountToWithdrawInShares;

        emit LpWithdrawInitiated(_lpAddress, _drawingId, _amountToWithdrawInShares, lpDrawingState[_drawingId].pendingWithdrawals);
    }

    /**
     * @notice Finalizes pending withdrawals and returns USDC amount
     * @dev Converts pending shares to USDC using historical accumulator values.
     *      Combines pending and claimable withdrawals for total withdrawal amount.
     * @param _drawingId Current drawing ID
     * @param _lpAddress Address finalizing withdrawal
     * @return withdrawableAmount Total USDC amount to transfer to LP
     * @custom:requirements
     * - Only Jackpot contract can call
     * - LP must have withdrawable amounts (claimable > 0)
     * @custom:emits LpWithdrawFinalized
     * @custom:effects
     * - Converts pending shares to USDC using historical accumulators
     * - Resets claimable withdrawal balance to zero
     * - Updates total LP pool value
     * @custom:security
     * - Access restricted to Jackpot contract
     * - Accurate share-to-USDC conversion using verified accumulator values
     */
    function processFinalizeWithdraw(uint256 _drawingId, address _lpAddress) external onlyJackpot() returns (uint256 withdrawableAmount) {
        LP storage lp = lpInfo[_lpAddress];

        // Accrue pending withdrawals to claimable withdrawals
        _consolidateWithdrawals(lp, _drawingId);

        if (lp.claimableWithdrawals == 0) revert JackpotErrors.NothingToWithdraw();

        withdrawableAmount = lp.claimableWithdrawals;

        lp.claimableWithdrawals = 0;
        emit LpWithdrawFinalized(_lpAddress, _drawingId, withdrawableAmount);
    }

    /**
     * @notice Emergency withdrawal for all LP positions when system is stuck
     * @dev Used when emergency mode is enabled to allow complete LP recovery.
     *      Bypasses normal withdrawal restrictions and converts all LP positions to USDC.
     * @param _drawingId Current drawing ID
     * @param _user Address making emergency withdrawal
     * @return withdrawableAmount Total USDC amount to transfer
     * @custom:requirements
     * - Only Jackpot contract can call (which enforces emergency mode)
     * - LP must have positions to withdraw
     * @custom:emits LpWithdrawFinalized
     * @custom:effects
     * - Converts all deposit types (pending, consolidated, withdrawals) to USDC
     * - Removes all LP tracking for the user
     * - Updates global LP state consistently
     * - Handles special case for drawing 0
     * @custom:security
     * - Only available through Jackpot emergency mode
     * - Complete position removal prevents partial recovery
     * - Maintains global state consistency
     */
    function emergencyWithdrawLP(uint256 _drawingId, address _user) external onlyJackpot() returns (uint256 withdrawableAmount) {
        LP storage lp = lpInfo[_user];

        if (_drawingId == 0) {
            // Note we do not need to subtract from lpPoolTotal since same round pending deposits have not been added yet
            withdrawableAmount += lp.lastDeposit.amount;
            lpDrawingState[_drawingId].pendingDeposits -= lp.lastDeposit.amount;
            delete lp.lastDeposit;
            emit LpWithdrawFinalized(_user, _drawingId, withdrawableAmount);
            return withdrawableAmount;
        }

        // lastDeposit from previous rounds to consolidated shares
        _consolidateDeposits(lp, _drawingId);
        // Add any deposits from this round (since they are denominated in usdc we can add directly to the withdrawable amount)
        if (lp.lastDeposit.amount > 0) {
            // Note we do not need to subtract from lpPoolTotal since same round pending deposits have not been added yet
            withdrawableAmount += lp.lastDeposit.amount;
            lpDrawingState[_drawingId].pendingDeposits -= lp.lastDeposit.amount;
            delete lp.lastDeposit;
        }

        // consolidated shares to usdc
        uint256 sharesToUsdc = lp.consolidatedShares * drawingAccumulator[_drawingId - 1] / PRECISE_UNIT;
        withdrawableAmount += sharesToUsdc;
        // Keep global state consistent
        lpDrawingState[_drawingId].lpPoolTotal -= sharesToUsdc;
        lp.consolidatedShares = 0;

        // pending withdrawals from previous rounds to usdc
        _consolidateWithdrawals(lp, _drawingId);
        // Add convert pending withdrawals from this round to usdc
        if (lp.pendingWithdrawal.amountInShares > 0) {
            uint256 withdrawalToUsdc = lp.pendingWithdrawal.amountInShares * drawingAccumulator[lp.pendingWithdrawal.drawingId - 1] / PRECISE_UNIT;
            withdrawableAmount += withdrawalToUsdc;
            // Keep global state consistent
            lpDrawingState[_drawingId].pendingWithdrawals -= lp.pendingWithdrawal.amountInShares;
            lpDrawingState[_drawingId].lpPoolTotal -= withdrawalToUsdc;
            delete lp.pendingWithdrawal;
        }
        
        // Do not need to update any global state since claimableWithdrawals have already been counted as out of the lpPool
        withdrawableAmount += lp.claimableWithdrawals;
        lp.claimableWithdrawals = 0;

        emit LpWithdrawFinalized(_user, _drawingId, withdrawableAmount);
    }

    /**
     * @notice Processes drawing settlement and updates accumulator values
     * @dev Runs after a drawing is settled to roll LP value forward and set the next accumulator:
     *      - Compute post-draw LP value: lpPoolTotal + lpEarnings - userWinnings - protocolFeeAmount.
     *        This must not underflow; caller must ensure payouts and fees do not exceed available value plus earnings.
     *      - Compute `newAccumulator` for the settled drawing when `_drawingId > 0`:
     *          • If `currentLP.lpPoolTotal == 0`, set to `PRECISE_UNIT` to avoid division by zero.
     *          • Else `newAccumulator = drawingAccumulator[_drawingId - 1] * postDrawLpValue / currentLP.lpPoolTotal` (rounds down).
     *        For `_drawingId == 0`, the accumulator is expected to already be initialized to `PRECISE_UNIT` via `initializeLP()`.
     *      - Convert pending withdrawals to USDC using `newAccumulator` and finalize `newLPValue` as:
     *          `newLPValue = postDrawLpValue + pendingDeposits - (pendingWithdrawals * newAccumulator / 1e18)`.
     *      Division truncation favors safety (conservative values). Deposits are denominated in USDC; withdrawals are in shares.
     * @param _drawingId Drawing that was completed
     * @param _lpEarnings Total LP earnings from ticket sales for the drawing
     * @param _userWinnings Total winnings paid to users for the drawing
     * @param _protocolFeeAmount Protocol fees collected for the drawing
     * @return newLPValue New total LP pool value to seed the next drawing
     * @return newAccumulator Accumulator for the settled drawing (unchanged for drawing 0)
     * @custom:requirements
     * - Caller must be the Jackpot contract
     * - `lpDrawingState[_drawingId]` must be initialized
     * - For `_drawingId == 0`, `drawingAccumulator[0]` must already be initialized (via `initializeLP()`)
     * - Inputs must reflect finalized drawing economics; must not cause underflow in post-draw value calculation
     * @custom:effects
     * - Updates `drawingAccumulator[_drawingId]` when `_drawingId > 0`
     * - Returns computed `newLPValue` for initializing the next drawing’s LP state
     * - Does not mutate pending deposit/withdrawal tallies here (only reads them for valuation)
     * @custom:security
     * - Access restricted to Jackpot contract
     * - Division-by-zero avoided by `PRECISE_UNIT` fallback when `lpPoolTotal == 0`
     * - Integer division truncation is conservative in favor of LP solvency
     */
    function processDrawingSettlement(
        uint256 _drawingId,
        uint256 _lpEarnings,
        uint256 _userWinnings,
        uint256 _protocolFeeAmount
    ) external onlyJackpot() returns (uint256 newLPValue, uint256 newAccumulator) {
        LPDrawingState storage currentLP = lpDrawingState[_drawingId];
        uint256 postDrawLpValue = currentLP.lpPoolTotal + _lpEarnings - _userWinnings - _protocolFeeAmount;

        // Note: we don't need to update the accumulator for the first drawing (0) since it's already set to PRECISE_UNIT
        if (_drawingId > 0) {
            // When setting for drawingId we need to use the accumulator from the previous drawing. If LP was 0 in previous
            // drawing then we need to set the accumulator to PRECISE_UNIT to avoid division by zero.
            newAccumulator = currentLP.lpPoolTotal == 0 ? PRECISE_UNIT :
                (drawingAccumulator[_drawingId - 1] * postDrawLpValue) / currentLP.lpPoolTotal;
            drawingAccumulator[_drawingId] = newAccumulator;
        }
        
        // Convert pending withdrawals to usdc to calculate the new lp value
        uint256 withdrawalsInUSDC = currentLP.pendingWithdrawals * newAccumulator / PRECISE_UNIT;
        newLPValue = postDrawLpValue + currentLP.pendingDeposits - withdrawalsInUSDC;
    }

    /**
     * @notice Initializes LP state for a new drawing
     * @dev Sets up initial LP pool total and resets pending amounts for new drawing. Called when transitioning to new drawing.
     * @param _drawingId New drawing ID
     * @param _initialLPValue Total LP value for the drawing
     * @custom:requirements
     * - Only Jackpot contract can call
     * - Drawing must not already be initialized
     * @custom:effects
     * - Creates new LPDrawingState with initial LP pool value
     * - Sets LP pool total and zeros pending deposits/withdrawals
     * @custom:security
     * - Access restricted to Jackpot contract
     */
    function initializeDrawingLP(uint256 _drawingId, uint256 _initialLPValue) external onlyJackpot() {
        lpDrawingState[_drawingId] = LPDrawingState({
            lpPoolTotal: _initialLPValue,
            pendingDeposits: 0,
            pendingWithdrawals: 0
        });
    }

    /**
     * @notice Sets the LP pool capacity limit for current drawing
     * @dev Updates maximum allowed LP pool size. Called when parameters affecting pool size change.
     * @param _drawingId Drawing to update cap for
     * @param _lpPoolCap New maximum pool size
     * @custom:requirements
     * - Only Jackpot contract can call
     * - New cap must not be less than current LP pool total
     * @custom:effects
     * - Updates lpPoolCap for deposit validation
     * - Affects future deposit limits
     * @custom:security
     * - Access restricted to Jackpot contract
     * - Validates cap against current pool size to prevent system inconsistency
     */
    function setLPPoolCap(uint256 _drawingId, uint256 _lpPoolCap) external onlyJackpot() {
        LPDrawingState storage currentLP = lpDrawingState[_drawingId];
        if (_lpPoolCap < currentLP.lpPoolTotal + currentLP.pendingDeposits) revert InvalidLPPoolCap();
        lpPoolCap = _lpPoolCap;
    }

    // =============================================================
    //                          VIEW FUNCTIONS
    // =============================================================

    /**
     * @notice Returns the drawing accumulator value for share pricing
     * @dev Accumulator is used to convert between shares and USDC based on drawing performance
     * @param _drawingId Drawing to query
     * @return Accumulator value in PRECISE_UNIT scale
     */
    function getDrawingAccumulator(uint256 _drawingId) external view returns (uint256) {
        return drawingAccumulator[_drawingId];
    }

    /**
     * @notice Returns complete LP state for an address
     * @dev Includes consolidated shares, last deposit, pending withdrawal and claimable amounts
     * @param _lpAddress Address to query
     * @return LP struct containing all LP position information
     */
    function getLpInfo(address _lpAddress) external view returns (LP memory) {
        return lpInfo[_lpAddress];
    }

    /**
     * @notice Returns a USDC-denominated breakdown of an LP’s position by state for the current drawing
     * @dev Computes non-mutating, best-effort valuations of the LP’s funds across states:
     *      - activeDeposits: Consolidated shares (including preview consolidation of a prior-round lastDeposit)
     *        valued at the last settled accumulator, i.e., drawingAccumulator[currentDrawingId - 1].
     *      - pendingDeposits: Same-round lastDeposit.amount (USDC) if lastDeposit.drawingId == currentDrawingId; otherwise 0.
     *      - pendingWithdrawals: Same-round pendingWithdrawal.amountInShares valued at drawingAccumulator[currentDrawingId - 1].
     *        This is an estimate; final conversion occurs at settlement using the current drawing’s accumulator.
     *      - claimableWithdrawals: Prior-round pendingWithdrawal valued at
     *        drawingAccumulator[pendingWithdrawal.drawingId], plus existing claimableWithdrawals.
     *      All amounts are denominated in USDC wei (6 decimals). Integer division truncates (conservative rounding).
     * @param _lpAddress Address of the LP to query
     * @return breakdown LPValueBreakdown struct containing:
     *         - activeDeposits
     *         - pendingDeposits
     *         - pendingWithdrawals (estimate until settlement)
     *         - claimableWithdrawals
     * @custom:requirements
     * - LP system should be initialized (drawingAccumulator[0] set by initializeLP()).
     * - Assumes a settled accumulator exists for currentDrawingId - 1 (i.e., currentDrawingId > 0).
     * @custom:effects
     * - Read-only view; does not mutate state.
     * @custom:security
     * - Valuations reference historical accumulators; pending withdrawals are estimates and may differ from final settled amounts.
     */
    function getLPValueBreakdown(address _lpAddress) external view returns (LPValueBreakdown memory breakdown) {
        LP storage lp = lpInfo[_lpAddress];
        uint256 currentDrawingId = jackpot.currentDrawingId();
        uint256 consolidatedShares = lp.consolidatedShares;
        if (lp.lastDeposit.drawingId < currentDrawingId && lp.lastDeposit.amount > 0) {
            consolidatedShares += (lp.lastDeposit.amount * PRECISE_UNIT) / drawingAccumulator[lp.lastDeposit.drawingId];
        }

        uint256 claimableWithdrawals = lp.claimableWithdrawals;
        if (lp.pendingWithdrawal.drawingId < currentDrawingId && lp.pendingWithdrawal.amountInShares > 0) {
            claimableWithdrawals += (lp.pendingWithdrawal.amountInShares * drawingAccumulator[lp.pendingWithdrawal.drawingId]) / PRECISE_UNIT;
        }

        return LPValueBreakdown({
            activeDeposits: consolidatedShares * drawingAccumulator[currentDrawingId - 1] / PRECISE_UNIT,
            pendingDeposits: lp.lastDeposit.drawingId == currentDrawingId ? lp.lastDeposit.amount : 0,
            pendingWithdrawals: lp.pendingWithdrawal.drawingId == currentDrawingId ? 
                lp.pendingWithdrawal.amountInShares * drawingAccumulator[currentDrawingId - 1] / PRECISE_UNIT : 0,
            claimableWithdrawals: claimableWithdrawals
        });
    }

    /**
     * @notice Returns LP drawing state for a specific drawing
     * @dev Includes lpPoolTotal, pendingDeposits, pendingWithdrawals for the drawing
     * @param _drawingId Drawing to query
     * @return LPDrawingState struct containing drawing-specific LP data
     */
    function getLPDrawingState(uint256 _drawingId) external view returns (LPDrawingState memory) {
        return lpDrawingState[_drawingId];
    }

    // =============================================================
    //                          INTERNAL FUNCTIONS
    // =============================================================

    function _consolidateDeposits(LP storage _lp, uint256 _drawingId) internal {
        if (_lp.lastDeposit.amount > 0 && _lp.lastDeposit.drawingId < _drawingId) {
            // Accumulators can never be zero after first initialization because even if entire prizePool is won the LP
            // will still receive ticket revenue
            _lp.consolidatedShares += (_lp.lastDeposit.amount * PRECISE_UNIT) / drawingAccumulator[_lp.lastDeposit.drawingId];
            delete _lp.lastDeposit;
        }
    }

    function _consolidateWithdrawals(LP storage _lp, uint256 _drawingId) internal {
        if (_lp.pendingWithdrawal.amountInShares > 0 && _lp.pendingWithdrawal.drawingId < _drawingId) {
            // Accumulators can never be zero after first initialization because even if entire prizePool is won the LP
            // will still receive ticket revenue
            _lp.claimableWithdrawals += (_lp.pendingWithdrawal.amountInShares * drawingAccumulator[_lp.pendingWithdrawal.drawingId]) / PRECISE_UNIT;
            delete _lp.pendingWithdrawal;
        }
    }
}
