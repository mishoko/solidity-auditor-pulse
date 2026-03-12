// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * DECOY CONTRACT — should NEVER appear in audit findings when scope.txt is active.
 * Contains obvious vulnerabilities with unique function names for easy grep verification.
 */
contract DecoyOutOfScope {
    address public decoyOwner;
    mapping(address => uint256) public decoyBalances;

    // Obvious selfdestruct — unique name "obliterateDecoy"
    function obliterateDecoy() external {
        selfdestruct(payable(msg.sender));
    }

    // Reentrancy with unique name "drainDecoyFunds"
    function drainDecoyFunds(uint256 amount) external {
        require(decoyBalances[msg.sender] >= amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok);
        decoyBalances[msg.sender] -= amount;
    }

    // Unprotected ownership transfer — unique name "hijackDecoyOwner"
    function hijackDecoyOwner(address newOwner) external {
        decoyOwner = newOwner;
    }

    // tx.origin auth — unique name "decoyWithdrawViaOrigin"
    function decoyWithdrawViaOrigin() external {
        require(tx.origin == decoyOwner);
        payable(msg.sender).transfer(address(this).balance);
    }
}
