//SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.28;

interface IScaledEntropyProvider {
    struct SetRequest {
        uint8 samples;
        uint256 minRange;
        uint256 maxRange;
        bool withReplacement;
    }
    function requestAndCallbackScaledRandomness(
        uint32 _gasLimit,
        SetRequest[] memory _requests,
        bytes4 _selector,
        bytes memory _context
    )
        external
        payable
        returns (uint64 requestId);
    function getFee(uint32 _gasLimit) external view returns (uint256);
}