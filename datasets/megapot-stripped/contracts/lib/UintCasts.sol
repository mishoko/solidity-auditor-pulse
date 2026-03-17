//SPDX-License-Identifier: UNLICENSED

/*
Copyright (C) 2025 Coordination Inc.
All rights reserved.

This software is proprietary and confidential. Unauthorized copying,
distribution, or use is strictly prohibited and may result in legal action.

For licensing inquiries: legal@coordinationlabs.com
*/

pragma solidity ^0.8.28;

/**
 * @title UintCasts
 * @notice Minimal helpers for safely downcasting uint256 values to uint8.
 * @dev Reverts with Uint8OutOfBounds() if a value exceeds uint8's max (255).
 */
library UintCasts {
    /// @notice Raised when a value cannot be represented as uint8 (value > 255)
    error Uint8OutOfBounds();

    /**
     * @notice Safely cast a uint256 to uint8.
     * @param _value The value to cast.
     * @return out The value as uint8 (reverts if out of range).
     */
    function toUint8(uint256 _value) internal pure returns (uint8) {
        if (_value > type(uint8).max) revert Uint8OutOfBounds();
        return uint8(_value);
    }

    /**
     * @notice Safely cast an array of uint256 to uint8[] element-wise.
     * @param _values The array of values to cast.
     * @return out The cast array (reverts if any element is out of range).
     */
    function toUint8Array(uint256[] memory _values) internal pure returns (uint8[] memory) {
        uint256 len = _values.length;
        uint8[] memory out = new uint8[](len);
        for (uint256 i = 0; i < len; ) {
            out[i] = toUint8(_values[i]);
            unchecked { ++i; }
        }
        return out;
    }
}
