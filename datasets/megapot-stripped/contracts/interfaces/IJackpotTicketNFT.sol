//SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.28;

interface IJackpotTicketNFT {

    struct TrackedTicket {
        uint256 drawingId;
        uint256 packedTicket;
        bytes32 referralScheme;
    }

    struct ExtendedTrackedTicket {
        uint256 ticketId;
        TrackedTicket ticket;
        uint8[] normals;
        uint8 bonusball;
    }

    function mintTicket(
        address recipient, 
        uint256 ticketId, 
        uint256 drawingId,
        uint256 packedTicket, 
        bytes32 referralScheme
    ) external;
    
    function burnTicket(uint256 ticketId) external;
    function getTicketInfo(uint256 ticketId) external view returns (TrackedTicket memory);
    function getUserTickets(address user, uint256 drawingId) external view returns (ExtendedTrackedTicket[] memory);
}