//SPDX-License-Identifier: UNLICENSED

/*
Copyright (C) 2025 Coordination Inc.
Use of this software is govered by the Business Source License included in the LICENSE.TXT file and at www.mariadb.com/bsl11.

Change Date: 2029-12-01

On the date above, in accordance with the Business Source License, use of this software will be governed by the open source license specified in the LICENSE.TXT file.
*/

pragma solidity ^0.8.28;

interface IPayoutCalculator {
    function calculateAndStoreDrawingUserWinnings(
        uint256 _drawingId,
        uint256 _prizePool,
        uint8 _ballMax,
        uint8 _bonusballMax,
        uint256[] memory _result,
        uint256[] memory _dupResult
    ) external returns (uint256);

    function setDrawingTierInfo(uint256 _drawingId) external;

    function getTierPayout(uint256 _drawingId, uint256 _tierId) external view returns (uint256);
}