//SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.28;

interface IJackpotLPManager {

    struct LPDrawingState {
        uint256 lpPoolTotal;
        uint256 pendingDeposits;
        uint256 pendingWithdrawals;
    }

    function processDeposit(uint256 _drawingId, address _lpAddress, uint256 _amount) external;

    function processInitiateWithdraw(uint256 _drawingId, address _lpAddress, uint256 _amountToWithdrawInShares) external;

    function processFinalizeWithdraw(uint256 _drawingId, address _lpAddress) external returns (uint256 withdrawableAmount);

    function processDrawingSettlement(
        uint256 _drawingId,
        uint256 _lpEarnings,
        uint256 _userWinnings,
        uint256 _protocolFeeAmount
    ) external returns (uint256 newLPValue, uint256 newAccumulator);

    function emergencyWithdrawLP(uint256 _drawingId, address _user) external returns (uint256 withdrawableAmount);

    function initializeDrawingLP(uint256 _drawingId, uint256 _initialLPValue) external;

    function setLPPoolCap(uint256 _drawingId, uint256 _lpPoolCap) external;

    function initializeLP() external;

    function getDrawingAccumulator(uint256 _drawingId) external view returns (uint256);
    function getLPDrawingState(uint256 _drawingId) external view returns (LPDrawingState memory);
}