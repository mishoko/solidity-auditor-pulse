//SPDX-License-Identifier: UNLICENSED

/*
Copyright (C) 2025 Coordination Inc.
All rights reserved.

This software is proprietary and confidential. Unauthorized copying,
distribution, or use is strictly prohibited and may result in legal action.

For licensing inquiries: legal@coordinationlabs.com
*/

pragma solidity ^0.8.28;

library JackpotErrors {
    // =============================================================
    //                            ERRORS
    // =============================================================

    error JackpotLocked();
    error DrawingNotDue();
    error InvalidRecipient();
    error InvalidTicketCount();
    error ReferralSplitLengthMismatch();
    error TooManyReferrers();
    error ReferralSplitSumInvalid();
    error InvalidBonusball();
    error TicketAlreadyMinted();
    error NoTicketsToClaim();
    error NotTicketOwner();
    error TicketFromFutureDrawing();
    error DepositAmountZero();
    error ExceedsPoolCap();
    error WithdrawAmountZero();
    error InsufficientShares();
    error NothingToWithdraw();
    error UnauthorizedEntropyCaller();
    error EntropyAlreadyCalled();
    error JackpotNotLocked();
    error ContractAlreadyInitialized();
    error ZeroAddress();
    error ContractNotInitialized();
    error LPDepositsAlreadyInitialized();
    error LPDepositsNotInitialized();
    error JackpotAlreadyInitialized();
    error TicketPurchasesDisabled();
    error InvalidTierWeights();
    error InvalidReferralSplitBps();
    error InvalidNormalsCount();
    error InsufficientEntropyFee();
    error NoReferralFeesToClaim();
    error NoPrizePool();
    error TicketPurchasesAlreadyEnabled();
    error TicketPurchasesAlreadyDisabled();
    error InvalidNormalBallMax();
    error InvalidDrawingDuration();
    error InvalidBonusballMin();
    error InvalidLpEdgeTarget();
    error InvalidReserveRatio();
    error InvalidReferralFee();
    error InvalidReferralWinShare();
    error InvalidTicketPrice();
    error InvalidMaxReferrers();
    error EmergencyEnabled();
    error EmergencyModeNotEngaged();
    error EmergencyModeAlreadyEnabled();
    error EmergencyModeAlreadyDisabled();
    error NoLPDeposits();
    error InvalidProtocolFee();
    error InvalidGovernancePoolCap();
    error TicketNotEligibleForRefund();
    error NoTicketsProvided();
}