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
import { IEntropyConsumer } from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import { IEntropyV2 } from "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";

import { FisherYatesRejection } from "./lib/FisherYatesWithRejection.sol";
import { IScaledEntropyProvider } from "./interfaces/IScaledEntropyProvider.sol";

/**
 * @title ScaledEntropyProvider
 * @notice Provides scaled random number generation using Pyth Network entropy with callback functionality
 * @dev Integrates with Pyth Network's entropy service to generate cryptographically secure random numbers:
 *      - Handles entropy requests with custom scaling and range parameters
 *      - Supports both sampling with and without replacement using Fisher-Yates algorithm
 *      - Provides callback mechanism for asynchronous random number delivery
 *      - Implements unbiased rejection sampling to prevent modulo bias
 *      - Manages fee payments to entropy providers
 *      - Stores pending requests and validates callback execution
 */
contract ScaledEntropyProvider is Ownable, IScaledEntropyProvider, IEntropyConsumer {
    // =============================================================
    //                           STRUCTS
    // =============================================================
    struct PendingRequest {
        address callback;
        bytes4 selector;
        bytes context;
        bytes32 userRandomNumber;
        SetRequest[] setRequests;
    }

    // =============================================================
    //                           EVENTS
    // =============================================================

    event ScaledRandomnessDelivered(uint64 indexed sequence, address indexed callback, uint256 samples);
    event EntropyFulfilled(uint64 indexed sequence, bytes32 randomNumber);

    // =============================================================
    //                           ERRORS
    // =============================================================
    error InvalidCallback();
    error CallbackFailed(bytes4 selector);
    error ZeroAddress();
    error InvalidSelector();
    error InvalidRequests();
    error InvalidRange();
    error InvalidSamples();
    error InsufficientFee();
    error UnknownSequence();

    // =============================================================
    //                       STATE VARIABLES
    // =============================================================

    IEntropyV2 private entropy;
    address private entropyProvider;
    mapping(uint64 => PendingRequest) private pending;

    // =============================================================
    //                         CONSTRUCTOR
    // =============================================================
    
    /**
     * @notice Initializes the ScaledEntropyProvider with Pyth Network entropy configuration
     * @dev Sets up connections to Pyth Network entropy contract and provider.
     *      Both addresses are validated and stored as immutable references.
     * @param _entropy Address of the Pyth Network entropy contract
     * @param _entropyProvider Address of the specific entropy provider to use
     * @custom:requirements
     * - Entropy contract address must not be zero
     * - Entropy provider address must not be zero
     * @custom:effects
     * - Sets immutable entropy contract reference
     * - Configures entropy provider for fee calculations
     * - Sets deployer as contract owner
     * @custom:security
     * - Address validation prevents zero address configuration
     * - Immutable references prevent unauthorized changes
     * - Owner-based access control for administrative functions
     */
    constructor(address _entropy, address _entropyProvider) Ownable(msg.sender) {
        if (_entropy == address(0)) revert ZeroAddress();
        if (_entropyProvider == address(0)) revert ZeroAddress();
        entropy = IEntropyV2(_entropy);
        entropyProvider = _entropyProvider;
    }

    // =============================================================
    //                      EXTERNAL FUNCTIONS
    // =============================================================

    /**
     * @notice Requests scaled random numbers from Pyth Network with callback delivery
     * @dev Submits entropy request to Pyth Network and stores callback details for async delivery.
     *      The callback will receive scaled random numbers according to the specified requests. Developer
     *      needs to ensure that the range is not too large to be able to build an array of the appropriate
     *      size in memory in order to avoid out of gas errors during Fisher-Yates sampling.
     *      IMPORTANT: The callback address is automatically set to msg.sender (the calling contract).
     * @param _gasLimit Gas limit for the entropy callback execution
     * @param _requests Array of SetRequest structs defining random number requirements
     * @param _selector Function selector for the callback method on the calling contract
     * @param _context Additional data to pass to the callback
     * @return sequence Unique identifier for tracking this entropy request
     * @custom:requirements
     * - Calling contract (msg.sender) must implement the callback function
     * - Provided fee (msg.value) must meet minimum requirements
     * - Function selector must not be zero
     * - All set requests must be valid (proper ranges and sample counts)
     * @custom:emits None (events emitted in callback)
     * @custom:effects
     * - Submits entropy request to Pyth Network
     * - Stores pending request details with msg.sender as callback address
     * - Transfers fee to entropy provider
     * @custom:security
     * - Callback address is restricted to msg.sender preventing unauthorized callbacks
     * - Fee validation ensures sufficient payment
     * - Request validation prevents invalid random number generation
     */
    function requestAndCallbackScaledRandomness(
        uint32 _gasLimit,
        SetRequest[] memory _requests,
        bytes4 _selector,
        bytes memory _context
    )
        external
        payable
        returns (uint64 sequence)
    {
        // We assume that the caller has already checked that the fee is sufficient
        if (msg.value < getFee(_gasLimit)) revert InsufficientFee();
        if (_selector == bytes4(0)) revert InvalidSelector();
        _validateRequests(_requests);

        sequence = entropy.requestV2{value: msg.value}(entropyProvider, _gasLimit);
        _storePendingRequest(sequence, _selector, _context, _requests);
    }

    /**
     * @notice Returns the fee required for an entropy request with specified gas limit
     * @dev Queries the Pyth Network entropy contract for current fee requirements.
     *      Fee covers entropy generation and callback execution costs.
     * @param _gasLimit Gas limit for the callback execution
     * @return Fee amount in wei required for the entropy request
     */
    function getFee(uint32 _gasLimit) public view returns (uint256) {
        return entropy.getFeeV2(entropyProvider, _gasLimit);
    }

    /**
     * @notice Returns the address of the Pyth Network entropy contract
     * @dev Provides access to the entropy contract address for integration purposes.
     * @return Address of the entropy contract
     */
    function getEntropyContract() external view returns (address) {
        return address(entropy);
    }

    /**
     * @notice Returns the address of the currently configured entropy provider
     * @dev Shows which entropy provider is being used for fee calculations and requests.
     * @return Address of the entropy provider
     */
    function getEntropyProvider() external view returns (address) {
        return entropyProvider;
    }

    /**
     * @notice Returns the details of a pending entropy request
     * @dev Retrieves stored request information for a specific sequence number.
     *      Useful for debugging and monitoring pending requests.
     * @param sequence Unique identifier of the entropy request
     * @return PendingRequest struct containing callback details and request parameters
     */
    function getPendingRequest(uint64 sequence) external view returns (PendingRequest memory) {
        return pending[sequence];
    }

    // =============================================================
    //                      ADMIN FUNCTIONS
    // =============================================================

    /**
     * @notice Updates the entropy provider address
     * @dev Changes which entropy provider is used for fee calculations and requests.
     *      Only affects future requests, not pending ones.
     * @param _entropyProvider New entropy provider address
     * @custom:requirements
     * - Only owner can call
     * - Provider address must not be zero
     * @custom:emits None
     * @custom:effects
     * - Updates entropy provider for future requests
     * - Changes fee calculations for new requests
     * @custom:security
     * - Owner-only access restriction
     * - Zero address validation
     */
    function setEntropyProvider(address _entropyProvider) external onlyOwner {
        if (_entropyProvider == address(0)) revert ZeroAddress();
        entropyProvider = _entropyProvider;
    }

    // =============================================================
    //                      INTERNAL FUNCTIONS
    // =============================================================

    /**
     * @notice Processes entropy callback from Pyth Network and delivers scaled random numbers
     * @dev Called by Pyth Network when entropy is available. Processes the raw entropy into scaled
     *      random numbers according to stored request parameters and delivers via callback.
     *      This is the core function that bridges Pyth entropy with application-specific randomness.
     * @param sequence Unique identifier for the entropy request
     * @param randomNumber Raw entropy value from Pyth Network (provider parameter ignored)
     * @custom:requirements
     * - Sequence must correspond to a valid pending request
     * - Callback execution must succeed
     * - Only called by Pyth Network entropy contract
     * @custom:emits EntropyFulfilled with sequence and raw random number
     * @custom:emits ScaledRandomnessDelivered with sequence, callback address, and sample count
     * @custom:effects
     * - Retrieves and deletes pending request data
     * - Generates scaled random numbers using Fisher-Yates or replacement sampling
     * - Executes callback with scaled results and original context
     * - Cleans up pending request storage
     * @custom:security
     * - Validates sequence corresponds to pending request
     * - Ensures callback execution succeeds before cleanup
     * - Uses unbiased sampling methods to prevent statistical attacks
     * - Immediate cleanup prevents replay attacks
     */
    function entropyCallback(uint64 sequence, address /*provider*/, bytes32 randomNumber) internal override {
        PendingRequest memory req = pending[sequence];
        if (req.callback == address(0)) revert UnknownSequence();
        
        delete pending[sequence];

        uint256[][] memory scaledRandomNumbers = _getScaledRandomness(randomNumber, req.setRequests);
        (bool success, ) = req.callback.call(abi.encodeWithSelector(req.selector, sequence, scaledRandomNumbers, req.context));
        if (!success) revert CallbackFailed(req.selector);

        emit EntropyFulfilled(sequence, randomNumber);
        emit ScaledRandomnessDelivered(sequence, req.callback, scaledRandomNumbers.length);
    }

    function _getScaledRandomness(
        bytes32 _randomNumber,
        SetRequest[] memory _setRequests
    )
        internal
        pure
        returns (uint256[][] memory requestsOutputs)
    {
        requestsOutputs = new uint256[][](_setRequests.length);
        
        for (uint256 i = 0; i < _setRequests.length; i++) {
            if (!_setRequests[i].withReplacement) {
                requestsOutputs[i] = FisherYatesRejection.draw(
                    _setRequests[i].minRange,
                    _setRequests[i].maxRange,
                    _setRequests[i].samples,
                    uint256(_randomNumber)
                );
            } else {
                requestsOutputs[i] = _drawWithReplacement(
                    _setRequests[i].minRange,
                    _setRequests[i].maxRange,
                    _setRequests[i].samples,
                    uint256(_randomNumber)
                );
            }
        }
    }

    function getEntropy() internal view override returns (address) {
        return address(entropy);
    }

    function _validateRequests(SetRequest[] memory _requests) internal pure {
        if (_requests.length == 0) revert InvalidRequests();
        for (uint256 i = 0; i < _requests.length; i++) {
            if (_requests[i].minRange > _requests[i].maxRange) revert InvalidRange();
            if (_requests[i].samples == 0) revert InvalidSamples();
        }
    }

    function _storePendingRequest(
        uint64 sequence,
        bytes4 _selector,
        bytes memory _context,
        SetRequest[] memory _setRequests
    ) internal {
        pending[sequence].callback = msg.sender;
        pending[sequence].selector = _selector;
        pending[sequence].context = _context;
        for (uint256 i = 0; i < _setRequests.length; i++) {
            pending[sequence].setRequests.push(_setRequests[i]);
        }
    }

    function _drawWithReplacement(
        uint256 _minRange,
        uint256 _maxRange,
        uint8 _samples,
        uint256 _randomNumber
    ) internal pure returns (uint256[] memory) {
        uint256[] memory result = new uint256[](_samples);
        uint256 range = _maxRange - _minRange + 1;
        uint256 nonce = 0;

        for (uint256 i = 0; i < _samples; i++) {
            uint256 rand;
            while (true) {
                rand = uint256(keccak256(abi.encode(_randomNumber, nonce)));
                uint256 limit = (type(uint256).max / range) * range;

                if (rand < limit) {
                    result[i] = uint256((rand % range) + _minRange); // [1..range]
                    break;
                }
                nonce++;
            }
            nonce++;
        }

        return result;
    }
}