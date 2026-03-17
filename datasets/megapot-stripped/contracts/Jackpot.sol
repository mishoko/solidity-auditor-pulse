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
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { LibBit } from "solady/src/utils/LibBit.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { Combinations } from "./lib/Combinations.sol";
import { IJackpot } from "./interfaces/IJackpot.sol";
import { IJackpotLPManager } from "./interfaces/IJackpotLPManager.sol";
import { IJackpotTicketNFT } from "./interfaces/IJackpotTicketNFT.sol";
import { IPayoutCalculator } from "./interfaces/IPayoutCalculator.sol";
import { IScaledEntropyProvider } from "./interfaces/IScaledEntropyProvider.sol";
import { JackpotErrors } from "./lib/JackpotErrors.sol";
import { TicketComboTracker } from "./lib/TicketComboTracker.sol";
import { UintCasts } from "./lib/UintCasts.sol";

/**
 * @title Jackpot
 * @notice Main jackpot contract that orchestrates all jackpot operations including ticket purchases, drawings, and prize distribution
 * @dev Implements a decentralized jackpot system with NFT-based tickets, LP-managed prize pools, and provably fair drawings using Pyth Network entropy
 */
contract Jackpot is IJackpot, Ownable2Step, ReentrancyGuardTransient {

    using SafeERC20 for IERC20;
    using UintCasts for uint256;
    using UintCasts for uint256[];

    // =============================================================
    //                           STRUCTS
    // =============================================================

    struct DrawingState {
        uint256 prizePool;
        uint256 ticketPrice;
        uint256 edgePerTicket;
        uint256 referralWinShare;
        uint256 globalTicketsBought;
        uint256 lpEarnings;
        uint8 ballMax;
        uint8 bonusballMax;
        uint256 drawingTime;
        uint256 winningTicket;
        bool jackpotLock;
    }

    struct ReferralScheme {
        address[] referrers;
        uint256[] referralSplit;
    }

    // =============================================================
    //                           EVENTS
    // =============================================================

    event TicketOrderProcessed(
        address indexed buyer,
        address indexed recipient,
        uint256 indexed currentDrawingId,
        uint256 numberOfTickets,
        uint256 lpEarnings,
        uint256 referralFees
    );

    event TicketPurchased(
        address indexed recipient,
        uint256 indexed currentDrawingId,
        bytes32 indexed source, // Note: this is used for telemetry purposes
        uint256 userTicketId,
        uint8[] normals,
        uint8 bonusball,
        bytes32 referralScheme
    );

    event ReferralFeeCollected(
        address indexed referrer,
        uint256 amount
    );

    event ReferralSchemeAdded(
        bytes32 indexed referralSchemeId,
        address[] referrers,
        uint256[] referralSplit
    );

    event TicketWinningsClaimed(
        address indexed userAddress,
        uint256 indexed drawingId,
        uint256 userTicketId,
        uint256 matchedNormals,
        bool bonusballMatch,
        uint256 winningsAmount
    );

    event TicketRefunded(uint256 indexed ticketId);

    event ReferralFeesClaimed(
        address indexed userAddress,
        uint256 amount
    );

    event JackpotSettled(
        uint256 indexed drawingId,
        uint256 totalTicketsSold,
        uint256 userWinnings,
        uint8 winningBonusball,
        uint256 winningNumbers,
        uint256 newDrawingAccumulator
    );

    event WinnersCalculated(
        uint256 indexed drawingId,
        uint256[] winningNormals,
        uint256 winningBonusball,
        uint256[] uniqueResult,
        uint256[] dupResult
    );

    event NewDrawingInitialized(
        uint256 indexed drawingId,
        uint256 lpPoolTotal,
        uint256 prizePool,
        uint256 ticketPrice,
        uint256 normalBallMax,
        uint8 bonusballMax,
        uint256 referralWinShare,
        uint256 drawingTime
    );

    event JackpotRunRequested(
        uint256 indexed drawingId,
        uint256 entropyGasLimit,
        uint256 fee
    );

    event LpEarningsUpdated(
        uint256 indexed drawingId,
        uint256 amount
    );

    event ProtocolFeeCollected(
        uint256 indexed drawingId,
        uint256 amount
    );

    // Governance Events
    event NormalBallMaxUpdated(uint256 indexed drawingId, uint8 oldValue, uint8 newValue);
    event ProtocolFeeThresholdUpdated(uint256 indexed drawingId, uint256 oldValue, uint256 newValue);
    event ProtocolFeeUpdated(uint256 indexed drawingId, uint256 oldValue, uint256 newValue);
    event GovernancePoolCapUpdated(uint256 indexed drawingId, uint256 oldValue, uint256 newValue);
    event DrawingDurationUpdated(uint256 indexed drawingId, uint256 oldValue, uint256 newValue);
    event BonusballMinUpdated(uint256 indexed drawingId, uint8 oldValue, uint8 newValue);
    event LpEdgeTargetUpdated(uint256 indexed drawingId, uint256 oldValue, uint256 newValue);
    event ReserveRatioUpdated(uint256 indexed drawingId, uint256 oldValue, uint256 newValue);
    event ReferralFeeUpdated(uint256 indexed drawingId, uint256 oldValue, uint256 newValue);
    event ReferralWinShareUpdated(uint256 indexed drawingId, uint256 oldValue, uint256 newValue);
    event ProtocolFeeAddressUpdated(uint256 indexed drawingId, address indexed oldAddress, address indexed newAddress);
    event TicketPriceUpdated(uint256 indexed drawingId, uint256 oldValue, uint256 newValue);
    event MaxReferrersUpdated(uint256 indexed drawingId, uint256 oldValue, uint256 newValue);
    event PayoutCalculatorUpdated(uint256 indexed drawingId, address oldPayoutCalculator, address newPayoutCalculator);
    event EntropyBaseGasLimitUpdated(uint256 indexed drawingId, uint32 oldValue, uint32 newValue);
    event EntropyVariableGasLimitUpdated(uint256 indexed drawingId, uint32 oldValue, uint32 newValue);
    event JackpotLocked(uint256 indexed drawingId);
    event JackpotUnlocked(uint256 indexed drawingId);
    event TicketPurchasesEnabled(uint256 indexed drawingId);
    event TicketPurchasesDisabled(uint256 indexed drawingId);
    event EntropyUpdated(uint256 indexed drawingId, address oldEntropy, address newEntropy);
    event EmergencyModeEnabled(uint256 indexed drawingId);
    event EmergencyModeDisabled(uint256 indexed drawingId);

    // =============================================================
    //                          CONSTANTS
    // =============================================================

    uint256 constant PRECISE_UNIT = 1e18;
    uint8 constant NORMAL_BALL_COUNT = 5;
    uint8 constant MAX_BIT_VECTOR_SIZE = 255;
    uint256 constant MAX_PROTOCOL_FEE = 25e16; // 25%

    // =============================================================
    //                       STATE VARIABLES
    // =============================================================

    // User and ticket mappings
    mapping(uint256 => TicketComboTracker.Tracker) internal drawingEntries; // drawing => TicketComboTracker
    mapping(uint256 => DrawingState) internal drawingState; // drawing => drawing state
    
    // Fee and LP mappings
    mapping(address => uint256) public referralFees;
    
    // Drawing and tier mappings
    mapping(bytes32 => ReferralScheme) internal referralSchemes;
    
    // Core state variables
    uint256 public currentDrawingId;

    // Used in between drawings - should be stored in each drawing's state in case admin
    // updates are made to params for next drawing (referralWinShare technically also needs
    // to be stored in each drawing's state but it is located in fees section)
    uint256 public ticketPrice;
    uint8 public normalBallMax;
    uint8 public bonusballMin;

    // Used at drawing settlement - do not need to be stored in each drawing's state
    uint256 public drawingDurationInSeconds; // Used in drawingTime
    uint256 public reserveRatio; // Used in prize pool and ticket calcs
    uint256 public lpEdgeTarget; // Used in edgePerTicket
    
    uint256 public governancePoolCap;

    // Fees
    uint256 public referralFee;
    uint256 public referralWinShare;
    uint256 public protocolFee;
    uint256 public protocolFeeThreshold;
    address public protocolFeeAddress;
    uint256 public maxReferrers;

    bool public initialized;
    bool public allowTicketPurchases;
    bool public emergencyMode;

    // Gas limits for entropy provider; base gas is the non-variable gas limit portion of the total gas
    // Variable gas is the amount of gas that needs to be added per bonusball used (drawingState.bonusballMax)
    uint32 public entropyBaseGasLimit;
    uint32 public entropyVariableGasLimit;
    
    // External contracts and contract settings
    IERC20 public usdc;
    IJackpotLPManager public jackpotLPManager;
    IJackpotTicketNFT public jackpotNFT;
    IScaledEntropyProvider public entropy;
    IPayoutCalculator public payoutCalculator;

    // =============================================================
    //                          MODIFIERS
    // =============================================================

    modifier onlyEntropy() {
        if (msg.sender != address(entropy)) revert JackpotErrors.UnauthorizedEntropyCaller();
        _;
    }

    modifier noEmergencyMode() {
        if (emergencyMode) revert JackpotErrors.EmergencyEnabled();
        _;
    }

    modifier onlyEmergencyMode() {
        if (!emergencyMode) revert JackpotErrors.EmergencyModeNotEngaged();
        _;
    }

    // =============================================================
    //                         CONSTRUCTOR
    // =============================================================

    /**
     * @notice Initializes the Jackpot contract with core jackpot parameters
     * @dev Sets initial jackpot configuration including ball ranges, fees, and timing.
     *      Most parameters can be updated later via admin functions. 
     *      The contract requires additional initialization via initialize(), initializeLPDeposits(), and initializeJackpot().
     * @param _drawingDurationInSeconds Time between jackpot drawings in seconds
     * @param _normalBallMax Maximum value for normal ball numbers (1 to this value)
     * @param _bonusballMin Minimum number of bonusball options (affects prize pool sizing)
     * @param _lpEdgeTarget Target profit margin for liquidity providers (in PRECISE_UNIT scale)
     * @param _reserveRatio Fraction of LP pool held in reserve (in PRECISE_UNIT scale)
     * @param _referralFee Fraction of ticket price paid as referral fees (in PRECISE_UNIT scale)
     * @param _referralWinShare Fraction of winnings shared with referrers (in PRECISE_UNIT scale)
     * @param _protocolFee Fraction of excess LP earnings taken as protocol fee (in PRECISE_UNIT scale)
     * @param _protocolFeeThreshold Minimum LP profit before protocol fees apply
     * @param _ticketPrice Price per ticket in USDC wei (6 decimals)
     * @param _maxReferrers Maximum number of referrers allowed per ticket purchase
     * @param _entropyBaseGasLimit Gas limit for entropy provider callback (uint32)
     * @custom:effects
     * - Sets all core jackpot parameters
     * - Sets deployer as initial owner and protocol fee recipient
     * - Contract remains uninitialized until initialize() is called
     */
    constructor(
        uint256 _drawingDurationInSeconds,
        uint8 _normalBallMax,
        uint8 _bonusballMin,
        uint256 _lpEdgeTarget,
        uint256 _reserveRatio,
        uint256 _referralFee,
        uint256 _referralWinShare,
        uint256 _protocolFee,
        uint256 _protocolFeeThreshold,
        uint256 _ticketPrice,
        uint256 _maxReferrers,
        uint32 _entropyBaseGasLimit
    ) Ownable(msg.sender) {
        drawingDurationInSeconds = _drawingDurationInSeconds;
        normalBallMax = _normalBallMax;
        bonusballMin = _bonusballMin;
        lpEdgeTarget = _lpEdgeTarget;
        reserveRatio = _reserveRatio;
        referralFee = _referralFee;
        referralWinShare = _referralWinShare;
        protocolFee = _protocolFee;
        protocolFeeThreshold = _protocolFeeThreshold;
        ticketPrice = _ticketPrice;
        maxReferrers = _maxReferrers;
        entropyBaseGasLimit = _entropyBaseGasLimit;

        entropyVariableGasLimit = uint32(250000);
        protocolFeeAddress = msg.sender;
    }

    // =============================================================
    //                      EXTERNAL FUNCTIONS
    // =============================================================

    /**
     * @notice Allows users to purchase jackpot tickets for the current drawing
     * @dev Validates tickets, processes referral fees, mints NFT tickets, and updates drawing state.
     *      Each ticket becomes an ERC-721 NFT that can be transferred or claimed for winnings.
     *      Duplicate tickets are allowed and tracked separately in the combo tracker. When a duplicate is purchased,
     *      prizePool increases by ticketPrice*(PRECISE_UNIT - lpEdgeTarget)/PRECISE_UNIT to preserve LP edge.
     * @param _tickets Array of ticket structs containing normal numbers (5) and bonusball number
     * @param _recipient Address that will receive the minted ticket NFTs
     * @param _referrers Array of referrer addresses for fee sharing (can be empty)
     * @param _referralSplit Array of PRECISE_UNIT-scaled referral weights (must sum to PRECISE_UNIT if provided)
     * @param _source Bytes32 identifier for tracking ticket purchase source (telemetry)
     * @return ticketIds Array of minted ticket IDs (NFT token IDs)
     * @custom:requirements
     * - Ticket purchases must be enabled (allowTicketPurchases == true)
     * - Drawing must not be locked (jackpotLock == false)
     * - Drawing must have an active prize pool (prizePool > 0)
     * - Tickets must have exactly 5 normal numbers and valid bonusball
     * - Normal numbers must be in range [1, ballMax] and unique
     * - Bonusball must be in range [1, bonusballMax]
     * - Referrer arrays must match in length and sum to PRECISE_UNIT
     * - Caller must have sufficient USDC balance and approval
     * - Emergency mode must not be active
     * @custom:emits TicketOrderProcessed, TicketPurchased (per ticket), ReferralFeeCollected (per referrer)
     * @custom:effects
     * - Transfers USDC from caller to contract
     * - Mints NFT tickets to recipient
     * - Updates drawing state (lpEarnings, globalTicketsBought, prizePool if duplicates)
     * - Distributes referral fees to referrers
     * - Stores tickets in combo tracker for scalable settlement calculations
     * @custom:security
     * - Reentrancy protection via nonReentrant modifier
     * - Input validation for all parameters
     * - Safe USDC transfers with approval checks
     */
    function buyTickets(
        Ticket[] memory _tickets,
        address _recipient,
        address[] memory _referrers,
        uint256[] memory _referralSplit,
        bytes32 _source
    )
        external
        nonReentrant
        noEmergencyMode
        returns (uint256[] memory ticketIds)
    {
        _validateBuyTicketInputs(_tickets, _recipient, _referrers, _referralSplit);

        DrawingState storage currentDrawingState = drawingState[currentDrawingId];
        
        uint256 numTicketsBought = _tickets.length;
        uint256 ticketsValue = numTicketsBought * currentDrawingState.ticketPrice;
        (uint256 referralFeeTotal, bytes32 referralSchemeId) = _validateAndTrackReferrals(_referrers, _referralSplit, ticketsValue);

        usdc.safeTransferFrom(msg.sender, address(this), ticketsValue);

        ticketIds = _validateAndStoreTickets(currentDrawingState, _tickets, _recipient, referralSchemeId, _source);

        currentDrawingState.lpEarnings += ticketsValue - referralFeeTotal;
        currentDrawingState.globalTicketsBought += numTicketsBought;

        emit TicketOrderProcessed(msg.sender, _recipient, currentDrawingId, numTicketsBought, ticketsValue - referralFeeTotal, referralFeeTotal);
    }

    /**
     * @notice Allows ticket holders to claim winnings from completed drawings
     * @dev Burns ticket NFTs, calculates winnings based on tier payouts, processes referral shares,
     *      and transfers net winnings to the caller. Only ticket owners can claim their winnings.
     * @param _userTicketIds Array of ticket IDs (NFT token IDs) to claim winnings for
     * @custom:requirements
     * - Caller must own all specified tickets (verified via ERC721.ownerOf)
     * - Tickets must be from completed drawings (drawingId < currentDrawingId)
     * - At least one ticket ID must be provided
     * - Drawing results must be finalized (scaledEntropyCallback completed)
     * @custom:emits TicketWinningsClaimed (per ticket), ReferralFeeCollected (per referrer share)
     * @custom:effects
     * - Burns the ticket NFTs (prevents double-claiming)
     * - Transfers net USDC winnings to caller
     * - If no referral scheme is set for the ticket, the referrer share of the winnings is added to current drawing's lpEarnings
     * - Updates referral fee balances for associated referrers
     * - Calculates tier payouts based on number matches
     * @custom:security
     * - Reentrancy protection via nonReentrant modifier
     * - Ownership verification for each ticket
     * - Drawing completion verification
     * - Automatic NFT burning to prevent double claims
     */
    function claimWinnings(uint256[] memory _userTicketIds) external nonReentrant {
        if (_userTicketIds.length == 0) revert JackpotErrors.NoTicketsToClaim();
        
        uint256 totalClaimAmount = 0;
        for (uint256 i = 0; i < _userTicketIds.length; i++) {
            uint256 ticketId = _userTicketIds[i];
            IJackpotTicketNFT.TrackedTicket memory ticketInfo = jackpotNFT.getTicketInfo(ticketId);
            uint256 drawingId = ticketInfo.drawingId;
            if (IERC721(address(jackpotNFT)).ownerOf(ticketId) != msg.sender) revert JackpotErrors.NotTicketOwner();
            if (drawingId >= currentDrawingId) revert JackpotErrors.TicketFromFutureDrawing();

            DrawingState memory winningDrawingState = drawingState[drawingId];
            uint256 tierId = _calculateTicketTierId(ticketInfo.packedTicket, winningDrawingState.winningTicket, winningDrawingState.ballMax);
            jackpotNFT.burnTicket(ticketId);
            
            uint256 winningAmount = payoutCalculator.getTierPayout(drawingId, tierId);
            uint256 referrerShare = _payReferrersWinnings(
                ticketInfo.referralScheme,
                winningAmount,
                winningDrawingState.referralWinShare
            );
            
            totalClaimAmount += winningAmount - referrerShare;
            emit TicketWinningsClaimed(
                msg.sender,
                drawingId,
                ticketId,
                tierId / 2,             // matches
                (tierId % 2) == 1,      // bonusball match
                winningAmount - referrerShare
            );
        }

        usdc.safeTransfer(msg.sender, totalClaimAmount);
    }

    /**
     * @notice Allows liquidity providers to deposit USDC into the prize pool
     * @dev Deposits are processed immediately but are not added to the prize pool until the next drawing. 
     *      LP shares are calculated based on the accumulator at the end of the current drawing.
     *      If the LP has a previous deposit from an earlier drawing, shares are consolidated before processing the new deposit.
     * @param _amountToDeposit The amount of USDC to deposit (in wei, 6 decimals for USDC)
     * @custom:requirements
     * - Drawing must not be locked (jackpotLock == false)
     * - Deposit amount must be greater than 0
     * - Total pool size after deposit must not exceed lpPoolCap
     * - Caller must have sufficient USDC balance and approval
     * - Emergency mode must not be active
     * @custom:emits LpDeposited (emitted by LPManager)
     * @custom:effects
     * - Transfers USDC from caller to contract
     * - Creates or updates LP position in current drawing
     * - May consolidate previous deposits from earlier drawings
     * - Updates total LP pool value
     * @custom:security
     * - Reentrancy protection via nonReentrant modifier
     * - Pool cap validation to prevent over-deposits
     * - Safe USDC transfers with approval checks
     */
    function lpDeposit(uint256 _amountToDeposit) external nonReentrant noEmergencyMode {
        if (drawingState[currentDrawingId].jackpotLock) revert JackpotErrors.JackpotLocked();
        if (_amountToDeposit == 0) revert JackpotErrors.DepositAmountZero();

        usdc.safeTransferFrom(msg.sender, address(this), _amountToDeposit);

        jackpotLPManager.processDeposit(currentDrawingId, msg.sender, _amountToDeposit);
    }

    /**
     * @notice Initiates withdrawal of LP shares from the liquidity pool
     * @dev Converts consolidated shares to pending withdrawal, which can be finalized after the current drawing.
     *      Automatically consolidates any previous deposits before processing the withdrawal.
     * @param _amountToWithdrawInShares Amount of LP shares to withdraw (in PRECISE_UNIT scale)
     * @custom:requirements
     * - Drawing must not be locked (jackpotLock == false)
     * - Withdrawal amount must be greater than 0
     * - Caller must have sufficient consolidated shares
     * - Emergency mode must not be active
     * @custom:emits LpWithdrawInitiated (emitted by LPManager)
     * @custom:effects
     * - Consolidates previous deposits if from earlier drawings
     * - Moves shares from consolidated to pending withdrawal
     * - Updates drawing state pending withdrawals
     * - Shares cannot be finalized until drawing completes
     * @custom:security
     * - Share balance validation
     * - Prevents withdrawals during locked drawings
     */
    function initiateWithdraw(uint256 _amountToWithdrawInShares) external noEmergencyMode {
        if (drawingState[currentDrawingId].jackpotLock) revert JackpotErrors.JackpotLocked();
        if (_amountToWithdrawInShares == 0) revert JackpotErrors.WithdrawAmountZero();

        jackpotLPManager.processInitiateWithdraw(currentDrawingId, msg.sender, _amountToWithdrawInShares);
    }

    /**
     * @notice Finalizes LP withdrawals and transfers USDC to the caller
     * @dev Converts pending withdrawal shares to USDC using the appropriate drawing accumulator,
     *      combines with any claimable withdrawals, and transfers the total amount.
     * @custom:requirements
     * - Caller must have pending withdrawals or claimable withdrawals
     * - Pending withdrawals must be from completed drawings
     * - Emergency mode must not be active
     * @custom:emits LpWithdrawFinalized (emitted by LPManager)
     * @custom:effects
     * - Transfers USDC equivalent of withdrawn shares to caller
     * - Resets claimable withdrawals and pending withdrawals to zero
     * - Uses historical accumulator values for accurate share pricing
     * @custom:security
     * - Reentrancy protection via nonReentrant modifier
     * - Share-to-USDC conversion using verified accumulator values
     * - Safe USDC transfers
     */
    function finalizeWithdraw() external nonReentrant noEmergencyMode {
        uint256 withdrawableAmount = jackpotLPManager.processFinalizeWithdraw(currentDrawingId, msg.sender);
        usdc.safeTransfer(msg.sender, withdrawableAmount);
    }

    /**
     * @notice Emergency withdrawal function for LPs when system is stuck, intended to be used if the jackpot cannot be transitioned to a new drawing
     * @dev Allows LPs to withdraw all their deposits when emergency mode is enabled.
     *      This bypasses normal withdrawal restrictions for system recovery.
     * @custom:requirements
     * - Emergency mode must be enabled
     * - Caller must have LP positions to withdraw
     * @custom:emits EmergencyWithdrawLP (emitted by LPManager)
     * @custom:effects
     * - Withdraws all LP positions for the caller
     * - Transfers USDC equivalent to caller
     * - Removes all LP tracking for the caller
     * @custom:security
     * - Only available in emergency mode
     * - Complete LP position removal
     */
    function emergencyWithdrawLP() external nonReentrant onlyEmergencyMode {
        uint256 withdrawableAmount = jackpotLPManager.emergencyWithdrawLP(currentDrawingId, msg.sender);
        usdc.safeTransfer(msg.sender, withdrawableAmount);
    }

    /**
     * @notice Allows ticket holders to receive refunds for their tickets from the current drawing during emergency mode
     * @dev Refunds tickets from the active drawing by burning the NFTs and transferring USDC back to holders.
     *      Refund amount is the full ticket price for tickets without referrals, or ticket price minus 
     *      referral fees for tickets purchased with referral schemes.
     *      Only tickets from the current drawing are eligible since past drawings have concluded normally.
     * @param _userTicketIds Array of ticket NFT IDs to refund from the current drawing
     * @custom:requirements
     * - Emergency mode must be active
     * - Caller must own all specified ticket NFTs
     * - Tickets must be from the current drawing only (not past drawings)
     * - At least one valid ticket must be provided
     * @custom:emits TicketRefunded for each successfully refunded ticket
     * @custom:effects
     * - Burns all specified ticket NFTs permanently
     * - Transfers total refund amount in USDC to caller
     * - Removes tickets from current drawing circulation
     * @custom:security
     * - Reentrancy protection via nonReentrant modifier
     * - Emergency mode enforcement prevents normal operation interference
     * - Ownership validation prevents unauthorized refunds
     * - Current drawing restriction ensures only active tickets are refunded
     * - Batch processing reduces gas costs for multiple ticket refunds
     */
    function emergencyRefundTickets(uint256[] memory _userTicketIds) external nonReentrant onlyEmergencyMode {
        if (_userTicketIds.length == 0) revert JackpotErrors.NoTicketsProvided();
        uint256 totalRefundAmount = 0;
        for (uint256 i = 0; i < _userTicketIds.length; i++) {
            uint256 ticketId = _userTicketIds[i];
            IJackpotTicketNFT.TrackedTicket memory ticketInfo = jackpotNFT.getTicketInfo(ticketId);

            if (ticketInfo.drawingId != currentDrawingId) revert JackpotErrors.TicketNotEligibleForRefund();
            if (IERC721(address(jackpotNFT)).ownerOf(ticketId) != msg.sender) revert JackpotErrors.NotTicketOwner();

            uint256 refundAmount = ticketInfo.referralScheme == bytes32(0) ? drawingState[ticketInfo.drawingId].ticketPrice 
                : drawingState[ticketInfo.drawingId].ticketPrice * (PRECISE_UNIT - referralFee) / PRECISE_UNIT;

            totalRefundAmount += refundAmount;

            jackpotNFT.burnTicket(ticketId);
            emit TicketRefunded(ticketId);
        }

        usdc.safeTransfer(msg.sender, totalRefundAmount);
    }

    /**
     * @notice Allows referrers to claim accumulated referral fees
     * @dev Transfers all pending referral fees to the caller and resets their balance to zero.
     *      Referral fees accumulate from ticket purchases and winning claims.
     * @custom:requirements
     * - Caller must have referral fees to claim (balance > 0)
     * @custom:emits ReferralFeesClaimed
     * @custom:effects
     * - Transfers USDC referral fees to caller
     * - Resets caller's referral fee balance to zero
     * @custom:security
     * - Reentrancy protection via nonReentrant modifier
     * - Balance validation before transfer
     * - Safe USDC transfers
     */
    function claimReferralFees() external nonReentrant {
        if (referralFees[msg.sender] == 0) revert JackpotErrors.NoReferralFeesToClaim();
        uint256 transferAmount = referralFees[msg.sender];
        delete referralFees[msg.sender];
        usdc.safeTransfer(msg.sender, transferAmount);
        emit ReferralFeesClaimed(msg.sender, transferAmount);
    }

    /**
     * @notice Executes the jackpot drawing by requesting randomness from the entropy provider
     * @dev Locks the current drawing, validates timing, and initiates the random number generation process.
     *      The drawing can only be executed after the drawing time has passed.
     * @custom:requirements
     * - Drawing time must have passed (strictly after scheduled drawingTime)
     * - Drawing must not already be locked
     * - Sufficient ETH must be provided for entropy provider fees
     * @custom:emits JackpotRunRequested
     * @custom:effects
     * - Locks the current drawing (prevents further ticket purchases)
     * - Requests scaled randomness from entropy provider
     * - Refunds excess ETH to caller
     * - Sets up callback for drawing completion
     * @custom:security
     * - Permissionless (any address may call)
     * - Timing validation prevents premature execution
     * - Entropy fee validation and refund mechanism
     * - Single execution per drawing via lock mechanism
     */
    function runJackpot() external payable nonReentrant noEmergencyMode {
        DrawingState storage currentDrawingState = drawingState[currentDrawingId];
        if (currentDrawingState.jackpotLock) revert JackpotErrors.JackpotLocked();
        if (currentDrawingState.drawingTime >= block.timestamp) revert JackpotErrors.DrawingNotDue();

        _lockJackpot();

        uint32 entropyGasLimit = _calculateEntropyGasLimit(currentDrawingState.bonusballMax);
        uint256 fee = entropy.getFee(entropyGasLimit);
        if (msg.value < fee) revert JackpotErrors.InsufficientEntropyFee();
        if (msg.value > fee) {
            (bool success, bytes memory returndata) = payable(msg.sender).call{value: msg.value - fee}("");
            if (!success) {
                if (returndata.length > 0) {
                    assembly {
                        revert(add(returndata, 32), mload(returndata))
                    }
                } else {
                    revert("Refund transfer failed");
                }
            }
        }

        IScaledEntropyProvider.SetRequest[] memory setRequests = new IScaledEntropyProvider.SetRequest[](2);
        setRequests[0] = IScaledEntropyProvider.SetRequest({
            samples: NORMAL_BALL_COUNT,
            minRange: uint256(1),
            maxRange: uint256(currentDrawingState.ballMax),
            withReplacement: false
        });
        setRequests[1] = IScaledEntropyProvider.SetRequest({
            samples: 1,
            minRange: uint256(1),
            maxRange: uint256(currentDrawingState.bonusballMax),
            withReplacement: false
        });

        entropy.requestAndCallbackScaledRandomness{value: fee}(
            entropyGasLimit,
            setRequests,
            this.scaledEntropyCallback.selector,
            bytes("")
        );

        emit JackpotRunRequested(currentDrawingId, entropyGasLimit, fee);
    }

    /**
     * @notice Callback function called by the entropy provider with random numbers
     * @dev Processes the random numbers to determine the total amount of winning payouts across all prize tiers. 
     *      Updates LP with new pool size by netting revenue from tickets sold during drawing, winning payouts, and deposits/withdrawals. 
     *      Finally calculates the params for the next drawing (with a particular focus on calculating the new bonusball).
     *      Note: the first callback parameter is the provider sequence ID and is ignored by Jackpot.
     * @param _randomNumbers Array of arrays containing random numbers (5 normal balls + 1 bonusball)
     * @custom:requirements
     * - Only entropy provider can call (verified via onlyEntropy modifier)
     * - Drawing must be locked (indicates runJackpot was called)
     * - Random numbers must be properly formatted
     * @custom:emits JackpotSettled, NewDrawingInitialized
     * @custom:effects
     * - Sets winning ticket numbers for the current drawing
     * - Calculates and stores tier payouts based on matches
     * - Updates drawing accumulator and LP values
     * - Creates next drawing state with new parameters
     * - Increments current drawing ID
     * - Unlocks the system for new ticket purchases
     * @custom:security
     * - Strict access control via entropy provider verification
     * - Single execution per drawing (prevented by lock state)
     * - Comprehensive state updates in single transaction
     */
    function scaledEntropyCallback(
        bytes32,
        uint256[][] memory _randomNumbers,
        bytes memory
    )
        external
        nonReentrant
        onlyEntropy
    {
        // Note: in previous versions we had an entropyCallbackLock to prevent double calls, but this is no longer needed
        // since we use the currentDrawingState - if the scaledEntropyCallback call succeeded then currentDrawingState
        // would be the next drawing and jackpotLock would be false
        DrawingState storage currentDrawingState = drawingState[currentDrawingId];
        if (!currentDrawingState.jackpotLock) revert JackpotErrors.JackpotNotLocked();

        (uint256 winningNumbers, uint256 drawingUserWinnings) = _calculateDrawingUserWinnings(currentDrawingState, _randomNumbers);
        currentDrawingState.winningTicket = winningNumbers;

        uint256 protocolFeeAmount = _transferProtocolFee(currentDrawingState.lpEarnings, drawingUserWinnings);

        (
            uint256 newLpValue,
            uint256 newAccumulatorValue
        ) = jackpotLPManager.processDrawingSettlement(
            currentDrawingId,
            currentDrawingState.lpEarnings,
            drawingUserWinnings,
            protocolFeeAmount
        );

        _setNewDrawingState(newLpValue, currentDrawingState.drawingTime + drawingDurationInSeconds);
        emit JackpotSettled(currentDrawingId - 1, currentDrawingState.globalTicketsBought, drawingUserWinnings, _randomNumbers[1][0].toUint8(), winningNumbers, newAccumulatorValue);
    }

    // =============================================================
    //                       INITIALIZATION FUNCTIONS
    // =============================================================
    
    /**
     * @notice Initializes the contract with external dependencies
     * @dev This is the first step in the contract initialization process. Must be called before initializeLPDeposits().
     *      Sets up references to all external contracts required for operation.
     * @param _usdc The USDC token contract address
     * @param _jackpotLPManager The LP manager contract address
     * @param _jackpotNFT The ticket NFT contract address
     * @param _entropy The scaled entropy provider contract address
     * @param _payoutCalculator The payout calculator contract address
     * @custom:requirements
     * - Contract must not already be initialized
     * - All contract addresses must not be zero address
     * - Only owner can call
     * @custom:effects
     * - Sets all external contract references
     * - Marks contract as initialized
     * @custom:security
     * - Owner-only access
     * - Zero address validation for all contracts
     * - Single initialization enforcement
     */
    function initialize(
        IERC20 _usdc,
        IJackpotLPManager _jackpotLPManager,
        IJackpotTicketNFT _jackpotNFT, 
        IScaledEntropyProvider _entropy, 
        IPayoutCalculator _payoutCalculator
    )
        external
        onlyOwner
    {
        if (initialized) revert JackpotErrors.ContractAlreadyInitialized();
        if (_entropy == IScaledEntropyProvider(address(0))) revert JackpotErrors.ZeroAddress();
        if (_usdc == IERC20(address(0))) revert JackpotErrors.ZeroAddress();
        if (_payoutCalculator == IPayoutCalculator(address(0))) revert JackpotErrors.ZeroAddress();
        if (_jackpotNFT == IJackpotTicketNFT(address(0))) revert JackpotErrors.ZeroAddress();
        if (_jackpotLPManager == IJackpotLPManager(address(0))) revert JackpotErrors.ZeroAddress();

        usdc = _usdc;
        jackpotLPManager = _jackpotLPManager;
        jackpotNFT = _jackpotNFT;
        entropy = _entropy;
        payoutCalculator = _payoutCalculator;
        initialized = true;
    }

    /**
     * @notice Initializes LP deposit functionality by setting pool cap and initial accumulator
     * @dev This is the second step in initialization. Calculates the maximum LP pool capacity based on
     *      the normal ball range and sets the initial drawing accumulator to PRECISE_UNIT.
     * @param _governancePoolCap The maximum LP pool capacity as defined by governance
     * @custom:requirements
     * - Contract must be initialized first
     * - LP deposits must not already be initialized (drawingAccumulator[0] must be 0)
     * - Governance pool cap must not be 0
     * - Only owner can call
     * @custom:effects
     * - Sets lpPoolCap based on calculated maximum allowable tickets and governance pool cap
     * - Sets drawingAccumulator[0] to PRECISE_UNIT
     * - Enables LP deposit functionality
     * @custom:security
     * - Requires prior initialization
     * - Single execution enforcement
     * - Mathematical validation of pool cap calculation
     */
    function initializeLPDeposits(uint256 _governancePoolCap) external onlyOwner {
        if (!initialized) revert JackpotErrors.ContractNotInitialized();
        if (jackpotLPManager.getDrawingAccumulator(0) != 0) revert JackpotErrors.LPDepositsAlreadyInitialized();
        if (_governancePoolCap == 0) revert JackpotErrors.InvalidGovernancePoolCap();

        // Set governance pool cap first so that it is available for lpPoolCap calculation
        governancePoolCap = _governancePoolCap;

        // Set lpPoolCap and drawingAccumulator to be able to start taking deposits
        jackpotLPManager.initializeLP();
        jackpotLPManager.setLPPoolCap(currentDrawingId, _calculateLpPoolCap(normalBallMax));
    }

    /**
     * @notice Finalizes jackpot initialization and starts the first drawing
     * @dev This is the final step in initialization. Enables ticket purchases and creates the first drawing state
     *      using any pending deposits as the initial LP value.
     * @param _initialDrawingTime Unix timestamp for when the first drawing should occur
     * @custom:requirements
     * - LP deposits must be initialized first
     * - Jackpot must not already be initialized (currentDrawingId must be 0)
     * - Only owner can call
     * @custom:effects
     * - Sets allowTicketPurchases to true
     * - Creates first drawing state with initial LP value
     * - Increments currentDrawingId to 1
     * - Starts the jackpot operation
     * @custom:security
     * - Sequential initialization requirement
     * - Single execution enforcement
     * - Proper state transition validation
     */
    function initializeJackpot(uint256 _initialDrawingTime) external onlyOwner {
        if (jackpotLPManager.getDrawingAccumulator(0) == 0) revert JackpotErrors.LPDepositsNotInitialized();
        if (currentDrawingId != 0) revert JackpotErrors.JackpotAlreadyInitialized();
        if (jackpotLPManager.getLPDrawingState(0).pendingDeposits == 0) revert JackpotErrors.NoLPDeposits();

        allowTicketPurchases = true;
        (
            uint256 newLpValue,
        ) = jackpotLPManager.processDrawingSettlement(0, 0, 0, 0);    // Drawing 0 and no winnings or lp earnings
        _setNewDrawingState(newLpValue, _initialDrawingTime);
    }

    // =============================================================
    //                       ADMIN FUNCTIONS
    // =============================================================

    /**
     * @notice Updates the maximum normal ball number and recalculates LP pool cap
     * @dev Changes the range of normal ball numbers, affecting ticket combinations and pool sizing.
     *      If the new lpPoolCap is less than current lpPoolTotal it will revert.
     * @param _normalBallMax New maximum value for normal balls (1 to this value)
     * @custom:requirements
     * - Only owner can call
     * - Value is automatically constrained by uint8 type (max 255)
     * - New pool cap must not be less than current total LP pool value
     * @custom:effects
     * - Updates normalBallMax state variable
     * - Recalculates and updates LP pool cap for current drawing
     * - Affects future drawing configurations
     * @custom:security
     * - Owner-only access
     * - Automatic LP pool cap recalculation maintains system integrity
     * - Pool size validation prevents system inconsistency
     */
    function setNormalBallMax(uint8 _normalBallMax) external onlyOwner {
        // Note: we do not need to check if _normalBallMax is greater than 255 because it is enforced by uint8 type
        uint8 oldNormalBallMax = normalBallMax;
        jackpotLPManager.setLPPoolCap(currentDrawingId, _calculateLpPoolCap(_normalBallMax));
        normalBallMax = _normalBallMax;
        
        emit NormalBallMaxUpdated(currentDrawingId, oldNormalBallMax, _normalBallMax);
    }

    /**
     * @notice Updates the protocol fee threshold
     * @dev Sets minimum LP profit required before protocol fees are collected
     * @param _protocolFeeThreshold New threshold amount in USDC wei
     * @custom:requirements
     * - Only owner can call
     * @custom:effects
     * - Updates protocolFeeThreshold state variable
     * - Affects future protocol fee calculations
     */
    function setProtocolFeeThreshold(uint256 _protocolFeeThreshold) external onlyOwner {
        uint256 oldProtocolFeeThreshold = protocolFeeThreshold;
        protocolFeeThreshold = _protocolFeeThreshold;
        
        emit ProtocolFeeThresholdUpdated(currentDrawingId, oldProtocolFeeThreshold, _protocolFeeThreshold);
    }

    /**
     * @notice Updates the protocol fee percentage
     * @dev Sets the fraction of excess LP earnings taken as protocol fee
     * @param _protocolFee New protocol fee in PRECISE_UNIT scale (e.g., 0.01e18 = 1%)
     * @custom:requirements
     * - Only owner can call
     * - Should be validated to be reasonable (< PRECISE_UNIT)
     * @custom:effects
     * - Updates protocolFee state variable
     * - Affects future protocol fee calculations
     */
    function setProtocolFee(uint256 _protocolFee) external onlyOwner {
        if (_protocolFee > MAX_PROTOCOL_FEE) revert JackpotErrors.InvalidProtocolFee();
        uint256 oldProtocolFee = protocolFee;
        protocolFee = _protocolFee;
        
        emit ProtocolFeeUpdated(currentDrawingId, oldProtocolFee, _protocolFee);
    }

    /**
     * @notice Updates the governance pool cap
     * @dev Sets the maximum LP pool capacity as defined by governance
     * @param _governancePoolCap New governance pool cap in USDC wei
     * @custom:requirements
     * - Only owner can call
     * - Governance pool cap must not be 0
     * @custom:effects
     * - Updates governancePoolCap state variable
     * - Affects future lpPoolCap calculations
     * @custom:security
     * - Zero value validation prevents invalid governance pool cap
     * - Automatic lpPoolCap recalculation maintains system integrity
     * - Pool size validation prevents system inconsistency
     */
    function setGovernancePoolCap(uint256 _governancePoolCap) external onlyOwner {
        if (_governancePoolCap == 0) revert JackpotErrors.InvalidGovernancePoolCap();

        uint256 oldGovernancePoolCap = governancePoolCap;
        governancePoolCap = _governancePoolCap;
        jackpotLPManager.setLPPoolCap(currentDrawingId, _calculateLpPoolCap(normalBallMax));
        
        emit GovernancePoolCapUpdated(currentDrawingId, oldGovernancePoolCap, _governancePoolCap);
    }

    /**
     * @notice Updates the time between jackpot drawings
     * @dev Changes how frequently drawings occur
     * @param _drawingDurationInSeconds New duration between drawings in seconds
     * @custom:requirements
     * - Only owner can call
     * - Duration must be greater than 0
     * @custom:effects
     * - Updates drawingDurationInSeconds state variable
     * - Affects future drawing scheduling
     * @custom:security
     * - Zero duration validation prevents system lock
     */
    function setDrawingDurationInSeconds(uint256 _drawingDurationInSeconds) external onlyOwner {
        if (_drawingDurationInSeconds == 0) revert JackpotErrors.InvalidDrawingDuration();
        uint256 oldDrawingDurationInSeconds = drawingDurationInSeconds;
        drawingDurationInSeconds = _drawingDurationInSeconds;
        
        emit DrawingDurationUpdated(currentDrawingId, oldDrawingDurationInSeconds, _drawingDurationInSeconds);
    }

    /**
     * @notice Updates the minimum bonusball range
     * @dev Sets the minimum number of bonusball options for drawings
     * @param _bonusballMin New minimum bonusball value
     * @custom:requirements
     * - Only owner can call
     * - Value must be greater than 0
     * @custom:effects
     * - Updates bonusballMin state variable
     * - Affects future drawing configurations
     * @custom:security
     * - Zero value validation prevents invalid bonusball ranges
     */
    function setBonusballMin(uint8 _bonusballMin) external onlyOwner {
        if (_bonusballMin == 0) revert JackpotErrors.InvalidBonusballMin();
        uint8 oldBonusballMin = bonusballMin;
        bonusballMin = _bonusballMin;
        
        emit BonusballMinUpdated(currentDrawingId, oldBonusballMin, _bonusballMin);
    }

    /**
     * @notice Updates the LP edge target percentage
     * @dev Sets the target profit margin for liquidity providers
     * @param _lpEdgeTarget New LP edge target in PRECISE_UNIT scale
     * @custom:requirements
     * - Only owner can call
     * - Value must be greater than 0 and less than PRECISE_UNIT
     * @custom:effects
     * - Updates lpEdgeTarget state variable
     * - Recalculates and updates LP pool cap
     * - Affects prize pool sizing and LP profitability
     * @custom:security
     * - Range validation ensures valid percentage values
     */
    function setLpEdgeTarget(uint256 _lpEdgeTarget) external onlyOwner {
        if (_lpEdgeTarget == 0 || _lpEdgeTarget >= PRECISE_UNIT) revert JackpotErrors.InvalidLpEdgeTarget();
        uint256 oldLpEdgeTarget = lpEdgeTarget;
        lpEdgeTarget = _lpEdgeTarget;

        jackpotLPManager.setLPPoolCap(currentDrawingId, _calculateLpPoolCap(normalBallMax));
        
        emit LpEdgeTargetUpdated(currentDrawingId, oldLpEdgeTarget, _lpEdgeTarget);
    }

    /**
     * @notice Updates the reserve ratio for LP pool
     * @dev Sets the fraction of LP pool held in reserve (not available as prize pool)
     * @param _reserveRatio New reserve ratio in PRECISE_UNIT scale
     * @custom:requirements
     * - Only owner can call
     * - Value must be less than PRECISE_UNIT
     * @custom:effects
     * - Updates reserveRatio state variable
     * - Recalculates and updates LP pool cap
     * - Affects prize pool sizing relative to LP pool
     * @custom:security
     * - Upper bound validation prevents invalid ratios
     */
    function setReserveRatio(uint256 _reserveRatio) external onlyOwner {
        if (_reserveRatio >= PRECISE_UNIT) revert JackpotErrors.InvalidReserveRatio();
        uint256 oldReserveRatio = reserveRatio;
        reserveRatio = _reserveRatio;

        jackpotLPManager.setLPPoolCap(currentDrawingId, _calculateLpPoolCap(normalBallMax));
        
        emit ReserveRatioUpdated(currentDrawingId, oldReserveRatio, _reserveRatio);
    }

    /**
     * @notice Updates the referral fee percentage
     * @dev Sets the fraction of ticket price paid as referral fees
     * @param _referralFee New referral fee in PRECISE_UNIT scale
     * @custom:requirements
     * - Only owner can call
     * - Value must not exceed PRECISE_UNIT (100%)
     * @custom:effects
     * - Updates referralFee state variable
     * - Affects referral fee calculations on ticket purchases
     * @custom:security
     * - Upper bound validation prevents excessive fees
     */
    function setReferralFee(uint256 _referralFee) external onlyOwner {
        if (_referralFee > PRECISE_UNIT) revert JackpotErrors.InvalidReferralFee();
        uint256 oldReferralFee = referralFee;
        referralFee = _referralFee;
        
        emit ReferralFeeUpdated(currentDrawingId, oldReferralFee, _referralFee);
    }

    /**
     * @notice Updates the referral win share percentage
     * @dev Sets the fraction of winnings shared with referrers
     * @param _referralWinShare New referral win share in PRECISE_UNIT scale
     * @custom:requirements
     * - Only owner can call
     * - Value must not exceed PRECISE_UNIT (100%)
     * @custom:effects
     * - Updates referralWinShare state variable
     * - Affects referral fee calculations on winnings claims
     * @custom:security
     * - Upper bound validation prevents excessive sharing
     */
    function setReferralWinShare(uint256 _referralWinShare) external onlyOwner {
        if (_referralWinShare > PRECISE_UNIT) revert JackpotErrors.InvalidReferralWinShare();
        uint256 oldReferralWinShare = referralWinShare;
        referralWinShare = _referralWinShare;
        
        emit ReferralWinShareUpdated(currentDrawingId, oldReferralWinShare, _referralWinShare);
    }

    /**
     * @notice Updates the protocol fee recipient address
     * @dev Changes where protocol fees are sent
     * @param _protocolFeeAddress New protocol fee recipient address
     * @custom:requirements
     * - Only owner can call
     * - Address must not be zero address
     * @custom:effects
     * - Updates protocolFeeAddress state variable
     * - Affects future protocol fee transfers
     * @custom:security
     * - Zero address validation prevents fee loss
     */
    function setProtocolFeeAddress(address _protocolFeeAddress) external onlyOwner {
        if (_protocolFeeAddress == address(0)) revert JackpotErrors.ZeroAddress();
        address oldProtocolFeeAddress = protocolFeeAddress;
        protocolFeeAddress = _protocolFeeAddress;
        
        emit ProtocolFeeAddressUpdated(currentDrawingId, oldProtocolFeeAddress, _protocolFeeAddress);
    }

    /**
     * @notice Updates the ticket price and recalculates LP pool cap
     * @dev Changes the cost per ticket and updates pool sizing accordingly.
     *      If the new lpPoolCap is less than current lpPoolTotal it will revert.
     * @param _ticketPrice New ticket price in USDC wei
     * @custom:requirements
     * - Only owner can call
     * - Price must be greater than 0
     * - New pool cap must not be less than current total LP pool value
     * @custom:effects
     * - Updates ticketPrice state variable
     * - Recalculates and updates LP pool cap for current drawing
     * - Affects future ticket purchases and pool sizing
     * @custom:security
     * - Zero price validation prevents free tickets
     * - Automatic pool cap recalculation maintains system integrity
     * - Pool size validation prevents system inconsistency
     */
    function setTicketPrice(uint256 _ticketPrice) external onlyOwner {
        if (_ticketPrice == 0) revert JackpotErrors.InvalidTicketPrice();
        uint256 oldTicketPrice = ticketPrice;
        ticketPrice = _ticketPrice;
        jackpotLPManager.setLPPoolCap(currentDrawingId, _calculateLpPoolCap(normalBallMax));
        
        emit TicketPriceUpdated(currentDrawingId, oldTicketPrice, _ticketPrice);
    }

    /**
     * @notice Updates the maximum number of referrers per ticket
     * @dev Sets the limit on referral chain length
     * @param _maxReferrers New maximum number of referrers
     * @custom:requirements
     * - Only owner can call
     * - Value must be greater than 0
     * @custom:effects
     * - Updates maxReferrers state variable
     * - Affects referral validation in ticket purchases
     * @custom:security
     * - Zero value validation ensures referrals remain functional
     */
    function setMaxReferrers(uint256 _maxReferrers) external onlyOwner {
        if (_maxReferrers == 0) revert JackpotErrors.InvalidMaxReferrers();
        uint256 oldMaxReferrers = maxReferrers;
        maxReferrers = _maxReferrers;
        
        emit MaxReferrersUpdated(currentDrawingId, oldMaxReferrers, _maxReferrers);
    }

    /**
     * @notice Updates the payout calculator contract
     * @dev Changes the contract responsible for calculating prize payouts
     * @param _payoutCalculator New payout calculator contract address
     * @custom:requirements
     * - Only owner can call
     * - Address must not be zero address
     * @custom:effects
     * - Updates payoutCalculator state variable
     * - Affects future payout calculations
     * @custom:security
     * - Zero address validation prevents calculation failures
     * - Contract interface compatibility assumed
     */
    function setPayoutCalculator(IPayoutCalculator _payoutCalculator) external onlyOwner {
        if (_payoutCalculator == IPayoutCalculator(address(0))) revert JackpotErrors.ZeroAddress();
        IPayoutCalculator oldPayoutCalculator = payoutCalculator;
        payoutCalculator = _payoutCalculator;

        emit PayoutCalculatorUpdated(currentDrawingId, address(oldPayoutCalculator), address(_payoutCalculator));
    }

    /**
     * @notice Updates the entropy provider contract
     * @dev Changes the contract responsible for providing randomness
     * @param _entropy New entropy provider contract address
     * @custom:requirements
     * - Only owner can call
     * - Address must not be zero address
     * @custom:effects
     * - Updates entropy state variable
     * - Affects future drawing executions
     * @custom:security
     * - Zero address validation prevents drawing failures
     * - Contract interface compatibility assumed
     */
    function setEntropy(IScaledEntropyProvider _entropy) external onlyOwner {
        if (_entropy == IScaledEntropyProvider(address(0))) revert JackpotErrors.ZeroAddress();
        IScaledEntropyProvider oldEntropy = entropy;
        entropy = _entropy;

        emit EntropyUpdated(currentDrawingId, address(oldEntropy), address(_entropy));
    }

    /**
     * @notice Updates the entropy gas limit for callbacks
     * @dev Sets the gas limit used when requesting entropy from the provider
     * @param _entropyBaseGasLimit New gas limit for entropy callbacks
     * @custom:requirements
     * - Only owner can call
     * @custom:effects
     * - Updates entropyBaseGasLimit state variable
     * - Affects future entropy requests
     */
    function setEntropyBaseGasLimit(uint32 _entropyBaseGasLimit) external onlyOwner {
        uint32 oldEntropyBaseGasLimit = entropyBaseGasLimit;
        entropyBaseGasLimit = _entropyBaseGasLimit;
        
        emit EntropyBaseGasLimitUpdated(currentDrawingId, oldEntropyBaseGasLimit, _entropyBaseGasLimit);
    }

    /**
     * @notice Updates the entropy variable gas limit - the amount of gas that needs to be added per
     * bonusball used (drawingState.bonusballMax)
     * @dev Sets the variable portion of the gas limit used when requesting entropy from the provider
     * @param _entropyVariableGasLimit New variable gas limit for entropy callbacks
     * @custom:requirements
     * - Only owner can call
     * @custom:effects
     * - Updates entropyVariableGasLimit state variable
     * - Affects future entropy requests
     */
    function setEntropyVariableGasLimit(uint32 _entropyVariableGasLimit) external onlyOwner {
        uint32 oldEntropyVariableGasLimit = entropyVariableGasLimit;
        entropyVariableGasLimit = _entropyVariableGasLimit;
        
        emit EntropyVariableGasLimitUpdated(currentDrawingId, oldEntropyVariableGasLimit, _entropyVariableGasLimit);
    }

    /**
     * @notice Enables emergency mode to halt normal operations
     * @dev Activates emergency mode for system recovery or maintenance
     * @custom:requirements
     * - Only owner can call
     * - Emergency mode must not already be enabled
     * @custom:effects
     * - Sets emergencyMode to true
     * - Disables normal ticket purchases and LP operations
     * - Enables emergency withdrawal functions
     * @custom:security
     * - Owner-only access
     * - Single activation enforcement
     */
    function enableEmergencyMode() external onlyOwner {
        if (emergencyMode) revert JackpotErrors.EmergencyModeAlreadyEnabled();
        emergencyMode = true;
        emit EmergencyModeEnabled(currentDrawingId);
    }

    /**
     * @notice Disables emergency mode to resume normal operations
     * @dev Deactivates emergency mode to restore normal functionality
     * @custom:requirements
     * - Only owner can call
     * - Emergency mode must be currently enabled
     * @custom:effects
     * - Sets emergencyMode to false
     * - Re-enables normal operations
     * - Disables emergency withdrawal functions
     * @custom:security
     * - Owner-only access
     * - State validation prevents invalid transitions
     */
    function disableEmergencyMode() external onlyOwner {
        if (!emergencyMode) revert JackpotErrors.EmergencyModeAlreadyDisabled();
        emergencyMode = false;
        emit EmergencyModeDisabled(currentDrawingId);
    }

    /**
     * @notice Manually locks the current drawing
     * @dev Prevents ticket purchases and LP operations for the current drawing
     * @custom:requirements
     * - Only owner can call
     * - Drawing must not already be locked
     * @custom:effects
     * - Sets jackpotLock to true for current drawing
     * - Prevents ticket purchases and deposits
     * @custom:security
     * - Owner-only access for emergency control
     * - State validation prevents double-locking
     */
    function lockJackpot() external onlyOwner {
        if (drawingState[currentDrawingId].jackpotLock) revert JackpotErrors.JackpotLocked();
        _lockJackpot();
    }

    /**
     * @notice Manually unlocks the current drawing
     * @dev Re-enables ticket purchases and LP operations for the current drawing
     * @custom:requirements
     * - Only owner can call
     * - Drawing must be currently locked
     * @custom:effects
     * - Sets jackpotLock to false for current drawing
     * - Re-enables ticket purchases and deposits
     * @custom:security
     * - Owner-only access for emergency control
     * - State validation prevents invalid unlocking
     */
    function unlockJackpot() external onlyOwner {
        if (!drawingState[currentDrawingId].jackpotLock) revert JackpotErrors.JackpotNotLocked();
        _unlockJackpot();
    }

    /**
     * @notice Enables ticket purchases globally
     * @dev Allows users to purchase tickets (used during initialization or after maintenance)
     * @custom:requirements
     * - Only owner can call
     * - Ticket purchases must not already be enabled
     * @custom:effects
     * - Sets allowTicketPurchases to true
     * - Enables global ticket purchasing functionality
     * @custom:security
     * - Owner-only access
     * - State validation prevents redundant enabling
     */
    function enableTicketPurchases() external onlyOwner {
        if (allowTicketPurchases) revert JackpotErrors.TicketPurchasesAlreadyEnabled();
        allowTicketPurchases = true;
        
        emit TicketPurchasesEnabled(currentDrawingId);
    }

    /**
     * @notice Disables ticket purchases globally
     * @dev Prevents users from purchasing tickets (used for maintenance or shutdown)
     * @custom:requirements
     * - Only owner can call
     * - Ticket purchases must be currently enabled
     * @custom:effects
     * - Sets allowTicketPurchases to false
     * - Disables global ticket purchasing functionality
     * @custom:security
     * - Owner-only access
     * - State validation prevents redundant disabling
     */
    function disableTicketPurchases() external onlyOwner {
        if (!allowTicketPurchases) revert JackpotErrors.TicketPurchasesAlreadyDisabled();
        allowTicketPurchases = false;
        
        emit TicketPurchasesDisabled(currentDrawingId);
    }

    // =============================================================
    //                      VIEW/PURE FUNCTIONS
    // =============================================================

    /**
     * @notice Returns the complete drawing state for a given drawing ID
     * @dev Provides read-only access to drawing configuration and results
     * @param _drawingId The drawing ID to query
     * @return DrawingState struct containing all drawing information
     */
    function getDrawingState(uint256 _drawingId) external view returns (DrawingState memory) {
        return drawingState[_drawingId];
    }

    /**
     * @notice Returns the referral scheme details for a given scheme ID
     * @dev Provides access to referrer addresses and split percentages
     * @param _referralSchemeId The keccak256 hash of referrers and splits
     * @return ReferralScheme struct containing referrer information
     */
    function getReferralScheme(bytes32 _referralSchemeId) external view returns (ReferralScheme memory) {
        return referralSchemes[_referralSchemeId];
    }

    /**
     * @notice Checks if specific tickets have been purchased in a drawing
     * @dev Useful for preventing duplicate purchases or checking availability
     * @param _drawingId The drawing to check
     * @param _tickets Array of tickets to check
     * @return Array of booleans indicating if each ticket was purchased
     */
    function checkIfTicketsBought(uint256 _drawingId, Ticket[] memory _tickets) external view returns (bool[] memory) {
        bool[] memory isBought = new bool[](_tickets.length);
        for (uint256 i = 0; i < _tickets.length; i++) {
            isBought[i] = TicketComboTracker.isDuplicate(drawingEntries[_drawingId], _tickets[i].normals, _tickets[i].bonusball);
        }
        return isBought;
    }

    /**
     * @notice Returns the count of tickets matching a subset of numbers
     * @dev Useful for analyzing ticket distribution and calculating probabilities.
     *      toNormalsBitVector can take any sized array of normals as long as ≤ 5 (the amount of normals in the ticket).
     *      This function can be used to see how many of a specific subset of normals have been bought.
     * @param _drawingId The drawing to check
     * @param _normals Array of normal numbers to match (can be partial)
     * @param _bonusball Bonusball number to match
     * @return ComboCount struct containing match statistics
     */
    function getSubsetCount(uint256 _drawingId, uint8[] memory _normals, uint8 _bonusball) external view returns (TicketComboTracker.ComboCount memory) {
        uint256 subset = TicketComboTracker.toNormalsBitVector(_normals, drawingState[_drawingId].ballMax);
        return drawingEntries[_drawingId].comboCounts[ _bonusball][subset];
    }

    
    /**
     * @notice Unpacks a packed ticket into normal numbers and bonusball
     * @dev Decodes the bit-packed ticket format used by the protocol:
     *      - Normal numbers are stored in bit positions [1..ballMax]
     *      - Bonusball is stored at position (ballMax + bonusball)
     *      Uses TicketComboTracker.unpackTicket to reconstruct the ticket.
     * @param _drawingId The drawing context providing `ballMax` for unpacking
     * @param _packedTicket The packed ticket bit vector to decode
     * @return normals Array of normal numbers in ascending order
     * @return bonusball The bonusball value for the ticket
     * @custom:effects
     * - Read-only operation with no state changes
     * @custom:security
     * - Assumes `_packedTicket` follows the protocol's packing scheme
     */
    function getUnpackedTicket(uint256 _drawingId, uint256 _packedTicket) external view returns (uint8[] memory normals, uint8 bonusball) {
        return TicketComboTracker.unpackTicket(_packedTicket, drawingState[_drawingId].ballMax);
    }

    /**
     * @notice Returns tier IDs for a list of ticket NFTs based on winning numbers
     * @dev For each ticket ID, fetches its packed ticket and drawing, then computes the tier:
     *      tierId = 2 * (matchedNormals) + (bonusballMatch ? 1 : 0), in the range [0..11].
     *      Relies on the drawing's stored `winningTicket` and `ballMax`.
     * @param _ticketIds Array of ticket NFT IDs to evaluate
     * @return tierIds Array of tier IDs aligned with `_ticketIds`
     * @custom:effects
     * - Read-only operation with no state changes
     * @custom:security
     * - Assumes tickets exist and their drawings have valid `winningTicket` values
     */
    function getTicketTierIds(uint256[] memory _ticketIds) external view returns (uint256[] memory tierIds) {
        tierIds = new uint256[](_ticketIds.length);
        for (uint256 i = 0; i < _ticketIds.length; i++) {
            IJackpotTicketNFT.TrackedTicket memory ticket = jackpotNFT.getTicketInfo(_ticketIds[i]);
            DrawingState memory ticketDrawingState = drawingState[ticket.drawingId];
            tierIds[i] = _calculateTicketTierId(ticket.packedTicket, ticketDrawingState.winningTicket, ticketDrawingState.ballMax);
        }
        return tierIds;
    }

    /**
     * @notice Returns the current ETH fee (in wei) required for the entropy callback
     * @dev Computes the callback gas limit for the current drawing as:
     *      `entropyGasLimit = entropyBaseGasLimit + entropyVariableGasLimit * bonusballMax`,
     *      then queries the entropy provider for the corresponding fee. The returned value is
     *      denominated in wei and reflects the provider’s current pricing. Callers may wish to
     *      include a small buffer when funding `runJackpot` to account for fee changes between calls.
     * @return fee The ETH amount in wei required by the entropy provider for the callback
     * @custom:effects
     * - Read-only operation with no state changes
     * @custom:security
     * - Depends on provider pricing; fee may change over time or with gas limit parameter updates
     */
    function getEntropyCallbackFee() external view returns (uint256 fee) {
        uint32 entropyGasLimit = _calculateEntropyGasLimit(drawingState[currentDrawingId].bonusballMax);
        return entropy.getFee(entropyGasLimit);
    }

    // =============================================================
    //                      INTERNAL FUNCTIONS
    // =============================================================
    function _calculateLpPoolCap(uint256 _normalBallMax) internal view returns (uint256) {
        // We use MAX_BIT_VECTOR_SIZE because that's the max number that can be packed in a uint256 bit vector
        uint256 maxAllowableTickets = Combinations.choose(_normalBallMax, NORMAL_BALL_COUNT) * (MAX_BIT_VECTOR_SIZE - _normalBallMax);
        uint256 maxPrizePool = maxAllowableTickets * ticketPrice * (PRECISE_UNIT - lpEdgeTarget) / PRECISE_UNIT;

        // We need to make sure that the lpPoolCap is not greater than the governance pool cap
        return Math.min(maxPrizePool * PRECISE_UNIT / (PRECISE_UNIT - reserveRatio), governancePoolCap);
    }

    function _setNewDrawingState(uint256 _newLpValue, uint256 _nextDrawingTime) internal {
        currentDrawingId++;

        jackpotLPManager.initializeDrawingLP(currentDrawingId, _newLpValue);

        DrawingState storage newDrawingState = drawingState[currentDrawingId];
        uint256 newPrizePool = _newLpValue * (PRECISE_UNIT - reserveRatio) / PRECISE_UNIT;
        newDrawingState.prizePool = newPrizePool;
        newDrawingState.ticketPrice = ticketPrice;
        newDrawingState.edgePerTicket = lpEdgeTarget * ticketPrice / PRECISE_UNIT;
        newDrawingState.globalTicketsBought = 0;
        newDrawingState.lpEarnings = 0;
        newDrawingState.ballMax = normalBallMax;
        newDrawingState.drawingTime = _nextDrawingTime;
        newDrawingState.jackpotLock = false;

        uint256 combosPerBonusball = Combinations.choose(normalBallMax, NORMAL_BALL_COUNT);
        uint256 minNumberTickets = newPrizePool * PRECISE_UNIT / ((PRECISE_UNIT - lpEdgeTarget) * ticketPrice);
        uint8 newBonusball = uint8(Math.max(bonusballMin, Math.ceilDiv(minNumberTickets, combosPerBonusball)));
        newDrawingState.bonusballMax = newBonusball;
        
        TicketComboTracker.init(drawingEntries[currentDrawingId], normalBallMax, newBonusball, NORMAL_BALL_COUNT);

        // Note: we want to set this when we set the payouts because it is important to the product that the targeted
        // guaranteed minimums are calculated net of the correct referral win share. It is grouped here with `setDrawingTierInfo`
        // to emphasize this relationship.
        newDrawingState.referralWinShare = referralWinShare;
        payoutCalculator.setDrawingTierInfo(currentDrawingId);

        emit NewDrawingInitialized(
            currentDrawingId,
            _newLpValue,
            newPrizePool,
            ticketPrice,
            normalBallMax,
            newBonusball,
            referralWinShare,
            _nextDrawingTime
        );
    }

    function _validateBuyTicketInputs(
        Ticket[] memory _tickets,
        address _recipient,
        address[] memory _referrers,
        uint256[] memory _referralSplit
    ) internal view {
        if (drawingState[currentDrawingId].jackpotLock) revert JackpotErrors.JackpotLocked();
        if (drawingState[currentDrawingId].prizePool == 0) revert JackpotErrors.NoPrizePool();
        if (!allowTicketPurchases) revert JackpotErrors.TicketPurchasesDisabled();
        if (_tickets.length == 0) revert JackpotErrors.InvalidTicketCount();
        if (_recipient == address(0)) revert JackpotErrors.InvalidRecipient();
        if (_referrers.length != _referralSplit.length) revert JackpotErrors.ReferralSplitLengthMismatch();
        if (_referrers.length > maxReferrers) revert JackpotErrors.TooManyReferrers();
    }

    function _validateAndTrackReferrals(
        address[] memory _referrers,
        uint256[] memory _referralSplit,
        uint256 _ticketsValue
    )
        internal
        returns (uint256 referralFeeTotal, bytes32 referralSchemeId)
    {
        if (_referrers.length > 0) {
            // Calculate total amount of referral fees for the order
            referralFeeTotal = _ticketsValue * referralFee / PRECISE_UNIT;
            // Calculate the referral scheme id for the order
            referralSchemeId = keccak256(abi.encode(_referrers, _referralSplit));

            uint256 referralSplitSum = 0;
            for (uint256 i = 0; i < _referrers.length; i++) {
                if (_referrers[i] == address(0)) revert JackpotErrors.ZeroAddress();
                if (_referralSplit[i] == 0) revert JackpotErrors.InvalidReferralSplitBps();
                // Add the referral fee to the referrer's balance
                uint256 referrerFee = referralFeeTotal * _referralSplit[i] / PRECISE_UNIT;
                referralFees[_referrers[i]] += referrerFee;
                referralSplitSum += _referralSplit[i];
                emit ReferralFeeCollected(_referrers[i], referrerFee);
            }
            if (referralSplitSum != PRECISE_UNIT) revert JackpotErrors.ReferralSplitSumInvalid();
            // If the referral scheme id is not already in the mapping, add it
            if (referralSchemes[referralSchemeId].referrers.length == 0) {
                referralSchemes[referralSchemeId] = ReferralScheme({
                    referrers: _referrers,
                    referralSplit: _referralSplit
                });

                emit ReferralSchemeAdded(referralSchemeId, _referrers, _referralSplit);
            }
        }
    }

    function _validateAndStoreTickets(
        DrawingState storage _currentDrawingState,
        Ticket[] memory _tickets,
        address _recipient,
        bytes32 _referralSchemeId,
        bytes32 _source
    )
        internal
        returns (uint256[] memory ticketIds)
    {
        TicketComboTracker.Tracker storage currentDrawingEntries = drawingEntries[currentDrawingId];

        ticketIds = new uint256[](_tickets.length);
        for (uint256 i = 0; i < _tickets.length; i++) {
            Ticket memory ticket = _tickets[i];
            if (ticket.normals.length != NORMAL_BALL_COUNT) revert JackpotErrors.InvalidNormalsCount();
            if (ticket.bonusball > _currentDrawingState.bonusballMax || ticket.bonusball == 0) revert JackpotErrors.InvalidBonusball();

            // Validation to make sure that normals are in range and no duplicates take place here
            (uint256 packedTicket, bool isDup) = TicketComboTracker.insert(currentDrawingEntries, ticket.normals, _tickets[i].bonusball);
            uint256 ticketId = uint256(keccak256(abi.encode(currentDrawingId, _currentDrawingState.globalTicketsBought + i + 1, packedTicket)));
            ticketIds[i] = ticketId;

            jackpotNFT.mintTicket(_recipient, ticketId, currentDrawingId, packedTicket, _referralSchemeId);

            if (isDup) {
                // We need to add to the prize pool because it is like an additional ticket is being minted. In order to guarantee the LP
                // edge we need to make sure that only (1-lpEdgeTarget) * ticketPrice is added to the prize pool.
                _currentDrawingState.prizePool += _currentDrawingState.ticketPrice - _currentDrawingState.edgePerTicket;
            }

            emit TicketPurchased(
                _recipient,
                currentDrawingId,
                _source,
                ticketId,
                ticket.normals,
                ticket.bonusball,
                _referralSchemeId
            );
        }
    }

    function _calculateDrawingUserWinnings(
        DrawingState storage _currentDrawingState,
        uint256[][] memory _unPackedWinningNumbers
    )
        internal
        returns(uint256 winningNumbers, uint256 drawingUserWinnings)
    {
        // Note that the total amount of winning tickets for a given tier is the sum of result and dupResult
        (
            uint256 winningTicket,
            uint256[] memory uniqueResult,
            uint256[] memory dupResult
        ) = TicketComboTracker.countTierMatchesWithBonusball(drawingEntries[currentDrawingId],
            _unPackedWinningNumbers[0].toUint8Array(),      // normal balls
            _unPackedWinningNumbers[1][0].toUint8()         // bonusball
        );

        winningNumbers = winningTicket;

        drawingUserWinnings = payoutCalculator.calculateAndStoreDrawingUserWinnings(
            currentDrawingId,
            _currentDrawingState.prizePool,
            _currentDrawingState.ballMax,
            _currentDrawingState.bonusballMax,
            uniqueResult,
            dupResult
        );

        emit WinnersCalculated(
            currentDrawingId,
            _unPackedWinningNumbers[0],
            _unPackedWinningNumbers[1][0],
            uniqueResult,
            dupResult
        );
    }

    function _calculateTicketTierId(uint256 _ticketNumbers, uint256 _winningNumbers, uint256 _normalBallMax) internal pure returns (uint256) {
        uint256 matches = 0;
        
        // Count matching normal numbers by checking overlapping bits
        uint256 matchingBits = _ticketNumbers & _winningNumbers;
        
        // Count the number of set bits (matches)
        matches = LibBit.popCount(matchingBits);
        
        // Extract bonusball from both ticket and winning numbers
        // Bonusball is stored in the highest bits after the normal numbers
        uint256 ticketBonusball = _ticketNumbers >> (_normalBallMax + 1);
        uint256 winningBonusball = _winningNumbers >> (_normalBallMax + 1);

        uint256 bonusballMatch = (ticketBonusball == winningBonusball) ? 1 : 0;

        // We count all matches including the bonusball so if the bonusball is a match we need to subtract it from matches
        return 2 * (matches - bonusballMatch) + bonusballMatch;
    }

    function _payReferrersWinnings(
        bytes32 _referralSchemeId,
        uint256 _winningAmount,
        uint256 _referralWinShare
    )
        internal
        returns (uint256)
    {
        uint256 referrerShare = _winningAmount * _referralWinShare / PRECISE_UNIT;
        // If referrer scheme is empty then the referrer share goes to LPs so we just add the amount to lpEarnings
        // in order to make sure our system accounts for it
        if (_referralSchemeId == bytes32(0)) {
            drawingState[currentDrawingId].lpEarnings += referrerShare;
            emit LpEarningsUpdated(currentDrawingId, referrerShare);
            return referrerShare;
        }

        ReferralScheme memory referralScheme = referralSchemes[_referralSchemeId];

        for (uint256 i = 0; i < referralScheme.referrers.length; i++) {
            // This is safe because we validate the referrers in _validateAndTrackReferrals and this function is only called after that
            address referrer = referralScheme.referrers[i];
            uint256 referrerFee = referrerShare * referralScheme.referralSplit[i] / PRECISE_UNIT;
            referralFees[referrer] += referrerFee;
            emit ReferralFeeCollected(referrer, referrerFee);
        }
        return referrerShare;
    }

    function _transferProtocolFee(
        uint256 _lpEarnings,
        uint256 _drawingUserWinnings
    )
        internal
        returns (uint256 protocolFeeAmount)
    {
        if (_lpEarnings > _drawingUserWinnings && _lpEarnings - _drawingUserWinnings > protocolFeeThreshold) {
            protocolFeeAmount = (_lpEarnings - _drawingUserWinnings - protocolFeeThreshold) * protocolFee / PRECISE_UNIT;
            usdc.safeTransfer(protocolFeeAddress, protocolFeeAmount);
        }

        emit ProtocolFeeCollected(currentDrawingId, protocolFeeAmount);
    }

    function _calculateEntropyGasLimit(uint8 _bonusballMax) internal view returns (uint32) {
        return entropyBaseGasLimit + entropyVariableGasLimit * uint32(_bonusballMax);
    }

    function _lockJackpot() internal {
        drawingState[currentDrawingId].jackpotLock = true;
        emit JackpotLocked(currentDrawingId);
    }

    function _unlockJackpot() internal {
        drawingState[currentDrawingId].jackpotLock = false;
        emit JackpotUnlocked(currentDrawingId);
    }
}
