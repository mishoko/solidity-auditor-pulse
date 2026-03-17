//SPDX-License-Identifier: UNLICENSED

/*
Copyright (C) 2025 Coordination Inc.
All rights reserved.

This software is proprietary and confidential. Unauthorized copying,
distribution, or use is strictly prohibited and may result in legal action.

For licensing inquiries: legal@coordinationlabs.com
*/

pragma solidity ^0.8.28;

import { ERC721 } from "solady/src/tokens/ERC721.sol";

import { IJackpot } from "./interfaces/IJackpot.sol";
import { IJackpotTicketNFT } from "./interfaces/IJackpotTicketNFT.sol";


/**
 * @title JackpotTicketNFT
 * @notice ERC-721 implementation for jackpot tickets with tracking and transfer functionality
 * @dev Implements jackpot tickets as transferable NFTs with:
 *      - Packed ticket number storage for efficient gas usage
 *      - User ticket tracking per drawing for easy querying
 *      - Referral scheme association for winnings distribution
 *      - Automatic ticket list management on transfers
 *      - Integration with Jackpot contract for minting and burning
 */
contract JackpotTicketNFT is ERC721, IJackpotTicketNFT {

    // =============================================================
    //                           STRUCTS
    // =============================================================
    struct UserTickets {
        uint256 totalTicketsBought;
        mapping(uint256 => uint256) ticketIds;
        mapping(uint256 => uint256) indexOfTicketId;
    }

    // =============================================================
    //                       ERRORS
    // =============================================================

    error UnauthorizedCaller();

    // =============================================================
    //                       STATE VARIABLES
    // =============================================================

    // User and ticket mappings
    mapping(address => mapping(uint256 => UserTickets)) internal userTickets; // user address => drawing => UserTickets
    mapping(uint256 => TrackedTicket) public tickets; // ticketId → ticket info

    IJackpot public immutable jackpot;

    // =============================================================
    //                       MODIFIERS
    // =============================================================

    modifier onlyJackpot() {
        if (msg.sender != address(jackpot)) revert UnauthorizedCaller();
        _;
    }

    // =============================================================
    //                       CONSTRUCTOR
    // =============================================================

    /**
     * @notice Initializes the JackpotTicketNFT with the Jackpot contract reference
     * @dev Sets up the connection to the main Jackpot contract that will mint and burn tickets
     * @param _jackpot Address of the main Jackpot contract
     * @custom:effects
     * - Sets jackpot contract reference as immutable
     * - Inherits ERC721 functionality for NFT operations
     * @custom:security
     * - Immutable jackpot reference prevents unauthorized contract changes
     */
    constructor(IJackpot _jackpot) {
        jackpot = _jackpot;
    }

    // =============================================================
    //                       EXTERNAL FUNCTIONS
    // =============================================================

    /**
     * @notice Mints a new ticket NFT with jackpot information
     * @dev Creates an ERC-721 token representing a jackpot ticket with embedded metadata.
     *      Automatically adds ticket to user's ticket list for the drawing.
     * @param _recipient Address to receive the minted ticket
     * @param _ticketId Unique identifier for the ticket (used as token ID)
     * @param _drawingId Drawing the ticket is for
     * @param _packedTicket Packed ticket numbers (normal numbers + bonusball)
     * @param _referralScheme Hash of referral scheme used for this ticket
     * @custom:requirements
     * - Only Jackpot contract can call
     * - Ticket ID must be unique (ERC721 enforces this)
     * - Recipient address must not be zero (ERC721 enforces this)
     * @custom:emits Transfer (ERC-721 standard)
     * @custom:effects
     * - Mints ERC-721 token to specified address
     * - Stores ticket metadata in contract storage
     * - Adds ticket to user's ticket list via _afterTokenTransfer
     * @custom:security
     * - Access restricted to Jackpot contract
     * - Unique ticket ID enforcement via ERC721
     * - Automatic user ticket tracking
     */
    function mintTicket(
        address _recipient,
        uint256 _ticketId,
        uint256 _drawingId,
        uint256 _packedTicket,
        bytes32 _referralScheme
    ) external onlyJackpot {
        tickets[_ticketId] = TrackedTicket({
            drawingId: _drawingId,
            packedTicket: _packedTicket,
            referralScheme: _referralScheme
        });

        _mint(_recipient, _ticketId);
    }

    function burnTicket(uint256 _ticketId) external onlyJackpot {
        _burn(_ticketId);
    }

    // =============================================================
    //                       VIEW FUNCTIONS
    // =============================================================

    function getUserTickets(address _userAddress, uint256 _drawingId) external view returns (ExtendedTrackedTicket[] memory) {
        UserTickets storage userDrawingTickets = userTickets[_userAddress][_drawingId];
        ExtendedTrackedTicket[] memory userTicketsList = new ExtendedTrackedTicket[](userDrawingTickets.totalTicketsBought);
        for (uint256 i = 0; i < userDrawingTickets.totalTicketsBought; i++) {
            uint256 ticketId = userDrawingTickets.ticketIds[i];
            userTicketsList[i] = _getExtendedTicketInfo(ticketId);
        }
        return userTicketsList;
    }

    function getTicketInfo(uint256 _ticketId) external view returns (TrackedTicket memory) {
        return tickets[_ticketId];
    }

    function getExtendedTicketInfo(uint256 _ticketId) external view returns (ExtendedTrackedTicket memory) {
        return _getExtendedTicketInfo(_ticketId);
    }
    
    function name() public pure override returns (string memory) {
        return "Jackpot";
    }

    function symbol() public pure override returns (string memory) {
        return "JACKPOT";
    }

    function tokenURI(uint256 /* tokenId */) public pure override returns (string memory) {
        return "";
    }

    // =============================================================
    //                       INTERNAL FUNCTIONS
    // =============================================================

    function _beforeTokenTransfer(address _from, address /* _to */, uint256 _tokenId) internal override {
        if (_from != address(0)) {
            TrackedTicket memory ticketInfo = tickets[_tokenId];
            UserTickets storage fromTickets = userTickets[_from][ticketInfo.drawingId];
            uint256 idx = fromTickets.indexOfTicketId[_tokenId];
            uint256 lastIdx = fromTickets.totalTicketsBought - 1;
            if (idx != lastIdx) {
                uint256 swapId = fromTickets.ticketIds[lastIdx];
                fromTickets.ticketIds[idx] = swapId;
                fromTickets.indexOfTicketId[swapId] = idx;
            }
            delete fromTickets.ticketIds[lastIdx];
            delete fromTickets.indexOfTicketId[_tokenId];
            fromTickets.totalTicketsBought -= 1;
        }
    }

    function _afterTokenTransfer(address /* _from */, address _to, uint256 _tokenId) internal override {
        if (_to != address(0)) {
            TrackedTicket memory ticketInfo = tickets[_tokenId];
            UserTickets storage toTickets = userTickets[_to][ticketInfo.drawingId];
            uint256 newIdx = toTickets.totalTicketsBought;
            toTickets.ticketIds[newIdx] = _tokenId;
            toTickets.indexOfTicketId[_tokenId] = newIdx;
            toTickets.totalTicketsBought += 1;
        }
    }

    function _getExtendedTicketInfo(uint256 _ticketId) internal view returns (ExtendedTrackedTicket memory) {
        (uint8[] memory normals, uint8 bonusball) = jackpot.getUnpackedTicket(tickets[_ticketId].drawingId, tickets[_ticketId].packedTicket);
        return ExtendedTrackedTicket({
            ticketId: _ticketId,
            ticket: tickets[_ticketId],
            normals: normals,
            bonusball: bonusball
        });
    }
}