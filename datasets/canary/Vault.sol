// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IVault.sol";

contract Vault is IVault {
    mapping(address => uint256) public balances;

    function deposit() external payable override {
        balances[msg.sender] += msg.value;
    }

    // Reentrancy: external call before state update
    function withdraw(uint256 amount) external override {
        require(balances[msg.sender] >= amount, "Insufficient balance");

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");

        balances[msg.sender] -= amount;
    }

    // Unchecked return value
    function withdrawUnsafe(address payable to, uint256 amount) external {
        require(balances[msg.sender] >= amount, "Insufficient balance");
        balances[msg.sender] -= amount;
        to.send(amount);
    }

    function getBalance(address account) external view override returns (uint256) {
        return balances[account];
    }
}
