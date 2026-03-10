// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TokenSale {
    mapping(address => uint256) public tokenBalance;
    uint256 public tokenPrice = 1 ether;
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    // Integer overflow in older compilers; tx.origin auth
    function buy(uint256 numTokens) external payable {
        require(msg.value == numTokens * tokenPrice, "Wrong ETH amount");
        tokenBalance[msg.sender] += numTokens;
    }

    // tx.origin instead of msg.sender — phishing vulnerability
    function withdrawFunds() external {
        require(tx.origin == owner, "Not owner");
        (bool success, ) = owner.call{value: address(this).balance}("");
        require(success);
    }

    // Missing access control
    function setPrice(uint256 newPrice) external {
        tokenPrice = newPrice;
    }
}
