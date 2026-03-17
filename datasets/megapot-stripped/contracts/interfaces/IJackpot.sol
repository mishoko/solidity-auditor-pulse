//SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.28;

interface IJackpot {

    struct Ticket {
        uint8[] normals;
        uint8 bonusball;
    }

    function buyTickets(
        Ticket[] memory _tickets,
        address _recipient,
        address[] memory _referrers,
        uint256[] memory _referralSplitBps,
        bytes32 _source
    )
        external
        returns (uint256[] memory ticketIds);

    function claimWinnings(
        uint256[] memory _userTicketIds
    )
        external;

    function ticketPrice() external view returns (uint256);
    function currentDrawingId() external view returns (uint256);
    function getUnpackedTicket(uint256 _drawingId, uint256 _packedTicket) external view returns (uint8[] memory, uint8);
}