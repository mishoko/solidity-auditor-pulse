Brix Money Findings & Analysis Report
PUBLISHED Feb 10, 2026
Overview
About C4
Code4rena (C4) is a competitive audit platform where security researchers, referred to as Wardens, review, audit, and analyze codebases for security vulnerabilities in exchange for bounties provided by sponsoring projects.

During the audit outlined in this document, C4 conducted an analysis of the Brix Money smart contract system. The audit took place from November 26 to December 03, 2025.

Final report assembled by Code4rena.

Summary
The C4 analysis yielded an aggregated total of 3 unique vulnerabilities. Of these vulnerabilities, 0 received a risk rating in the category of HIGH severity and 3 received a risk rating in the category of MEDIUM severity.

Additionally, C4 analysis included 33 QA reports compiling issues with a risk rating of LOW severity or informational.

All of the issues presented here are linked back to their original finding, which may include relevant context from the judge and Brix Money team.

Scope
The code under review can be found within the C4 Brix Money repository, and is composed of 15 smart contracts written in the Solidity programming language and includes 1324 lines of Solidity code.

The code in C4’s Brix Money repository was pulled from:

Repository: https://github.com/InverterNetwork/iTry-contracts
Commit hash: 390ba2d949881981f28baa1096e9fe2d66838e7d
Severity Criteria
C4 assesses the severity of disclosed vulnerabilities based on three primary risk categories: high, medium, and low/informational.

High-level considerations for vulnerabilities span the following key areas when conducting assessments:

Malicious Input Handling
Escalation of privileges
Arithmetic
Gas use
For more information regarding the severity criteria referenced throughout the submission review process, please refer to the documentation provided on the C4 website, specifically our section on Severity Categorization.

Medium Risk Findings (3)
[M-01] User can bypass staking restrictions through composer and deposit on another chain
Submitted by harry, also found by botdidy, curly, Dest1ny_rs, tobi0x18, and vangrim

Because the cross-chain wiTry flow lacks restriction verification, a user who has been restricted on the staking vault can still effectively stake via the composer and receive wiTRY on another chain. This breaks the intended regulatory restriction.

Root Cause
By intended design, SOFT_RESTRICTED_STAKER_ROLE should prevent an address from staking:

token/wiTRY/StakediTry.so #L27-L28

    /// @notice The role which prevents an address to stake

    bytes32 private constant SOFT_RESTRICTED_STAKER_ROLE = keccak256("SOFT_RESTRICTED_STAKER_ROLE");
However, due to the way wiTryOFTAdapter and wiTryVaultComposer are integrated, there is no effective check that propagates StakediTry’s restriction roles into the cross-chain path.

In the cross-chain wiTry flow, the LayerZero endpoint callback into wiTryVaultComposer, the call path for cross-chain deposits is: LayerZero Endpoint -> lzCompose() -> handleCompose() -> _depositAndSend()

When the message represents a cross-chain deposit, handleCompose() eventually triggers _depositAndSend():

token/wiTRY/crosschain/wiTryVaultComposer.sol #L61-L84
token/wiTRY/crosschain/libraries/VaultComposerSync.sol #L206-L220
    function _depositAndSend(

        bytes32 _depositor,

        uint256 _assetAmount,

        SendParam memory _sendParam,

        address _refundAddress

    ) internal virtual {

@>      uint256 shareAmount = _deposit(_depositor, _assetAmount);

        _assertSlippage(shareAmount, _sendParam.minAmountLD);


        _sendParam.amountLD = shareAmount;

        _sendParam.minAmountLD = 0;


        _send(SHARE_OFT, _sendParam, _refundAddress);

        emit Deposited(_depositor, _sendParam.to, _sendParam.dstEid, _assetAmount, shareAmount);

    }
The actual deposit into the staking vault is performed in _deposit(), where wiTryVaultComposer deposits into StakediTryCrosschain on behalf of itself:

token/wiTRY/crosschain/libraries/VaultComposerSync.sol #L228-L238

    function _deposit(

        bytes32,

        /*_depositor*/

        uint256 _assetAmount

    )

        internal

        virtual

        returns (uint256 shareAmount)

    {

@>      shareAmount = VAULT.deposit(_assetAmount, address(this));

    }
Here, VAULT is the StakediTryCrosschain contract. The vault does not enforce restriction checks on the composer contract address (address(this)). It does not check whether the recipient encoded in the OFT message has SOFT_RESTRICTED_STAKER_ROLE (and it also does not check FULL_RESTRICTED_STAKER_ROLE).

As a result, a user who is restricted on StakediTry can still route their position through the wiTry OFT path. By calling wiTryOFTAdapter.send() and going through the LayerZero compose flow, they can deposit iTRY into the vault via wiTryVaultComposer and mint wiTRY on another chain, effectively bypassing the staking restriction that was applied to their address on the hub vault.

Impact
Any user who has been restricted on the staking vault can still stake by going through the cross-chain wiTry flow. They can deposit iTRY via the OFT adapter and receive wiTRY on a spoke chain. This breaks the intended regulatory restriction.

Recommended mitigation steps
In wiTryVaultComposer._depositAndSend(), use the _depositor parameter and verify whether it has a restricted role before executing the VAULT.deposit() operation.

Proof of Concept
Scenario:

On Sepolia (hub chain), a user effectively controls 100e18 iTRY that can be deposited into the vault.
The admin assigns a restriction role to the user (via addToBlacklist() with SOFT_RESTRICTED_STAKER_ROLE) due to suspicious or illegal behavior, intending to block further staking.
Despite this, the user calls wiTryOFTAdapter.send(), going through the OFT adapter and LayerZero compose route, to deposit their iTRY and send the equivalent wiTRY to another chain.
On OP Sepolia (spoke chain), the restricted user receives the corresponding wiTRY and continues to hold a staked position, effectively bypassing the restriction on the hub vault.
To run the PoC, create test/crosschainTests/crosschain/PoC.t.sol, add the following code, and run:

forge test --mt test_RestrictedUserBypassViaComposer -vvvv

View detailed Proof of Concept

Output:

	...

    │   │   │   │   └─ ← [Return] MessagingReceipt({ guid: 0x84f3b896af5e826af7e7a0fd94198a09ee7813bb473d89d412dfd050b3a12068, nonce: 1, fee: MessagingFee({ nativeFee: 10816191207305 [1.081e13], lzTokenFee: 0 }) })

    │   │   │   ├─ emit OFTSent(guid: 0x84f3b896af5e826af7e7a0fd94198a09ee7813bb473d89d412dfd050b3a12068, dstEid: 40232 [4.023e4], fromAddress: wiTryVaultComposer: [0xC5231cb966A4F1DBB6be97EdaD19f5B27b14f9C7], amountSentLD: 100000000000000000000 [1e20], amountReceivedLD: 100000000000000000000 [1e20])

    │   │   │   └─ ← [Return] MessagingReceipt({ guid: 0x84f3b896af5e826af7e7a0fd94198a09ee7813bb473d89d412dfd050b3a12068, nonce: 1, fee: MessagingFee({ nativeFee: 10816191207305 [1.081e13], lzTokenFee: 0 }) }), OFTReceipt({ amountSentLD: 100000000000000000000 [1e20], amountReceivedLD: 100000000000000000000 [1e20] })

    │   │   ├─ emit Deposited(sender: 0x000000000000000000000000f94ca99493a6ca52b3f25bc26a38ffa2643b7534, recipient: 0x000000000000000000000000f94ca99493a6ca52b3f25bc26a38ffa2643b7534, dstEid: 40232 [4.023e4], assetAmt: 100000000000000000000 [1e20], shareAmt: 100000000000000000000 [1e20])

    │   │   └─ ← [Stop]

    │   ├─ emit Sent(guid: 0x939a39f977d7af96441985f1a8dc7e3c075eb3d5ff8625728c5e90e41d08a24a)

    │   └─ ← [Stop]

    └─ ← [Stop]


Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 29.92s (15.33s CPU time)
We can see that INITIAL_DEPOSIT (100e18) wiTRY is successfully sent from Sepolia (hub chain) to OP Sepolia (spoke chain).

[M-02] Cross-chain unstake and fast redeem operations fail due to minAmountLD not accounting for LayerZero dust removal
Submitted by jerry0422, also found by Albert, deeney, djshan_eden, hecker_trieu_tien, hodlturk, jo13, lufP, Manosh19, newspacexyz, odeili, saraswati, slvDev, Smacaud, tobi0x18, web3snr, and Wojack

token/wiTRY/crosschain/wiTryVaultComposer.sol #L267-L268
token/wiTRY/crosschain/wiTryVaultComposer.sol #L116-L117
Finding description
In wiTryVaultComposer, both _handleUnstake() and _fastRedeem() set minAmountLD equal to amountLD when constructing the SendParam for cross-chain token transfers:

_handleUnstake (lines 264-272):

SendParam memory _sendParam = SendParam({

    dstEid: _origin.srcEid,

    to: bytes32(uint256(uint160(user))),

    amountLD: assets,

    minAmountLD: assets,  // @audit problematic - not accounting for dust removal

    extraOptions: options,

    composeMsg: "",

    oftCmd: ""

});
_fastRedeem (lines 116-117):

_sendParam.amountLD = assets;

_sendParam.minAmountLD = assets;  // @audit problematic - not accounting for dust removal
LayerZero OFT implements a dust removal mechanism in _debitView() to handle decimal precision differences between chains. For tokens with 18 local decimals and 6 shared decimals (the default in OFTCore.sol), the decimalConversionRate is 10^12. The _removeDust() function truncates amounts:

// OFTCore.sol

function _removeDust(uint256 _amountLD) internal view virtual returns (uint256 amountLD) {

    return (_amountLD / decimalConversionRate) * decimalConversionRate;

}
After dust removal, the OFT performs a slippage check in _debitView():

function _debitView(uint256 _amountLD, uint256 _minAmountLD, uint32) 

    internal view virtual returns (uint256 amountSentLD, uint256 amountReceivedLD) {

    amountSentLD = _removeDust(_amountLD);

    amountReceivedLD = amountSentLD;

    

    if (amountReceivedLD < _minAmountLD) {

        revert SlippageExceeded(amountReceivedLD, _minAmountLD);

    }

}
When a user’s asset amount is not perfectly divisible by 10^12 (which is the common case for arbitrary amounts), the dust-removed amount will be less than the original, causing the slippage check to fail.

Example:

User unstakes 10000000000000000001 wei (10 ether + 1)
After _removeDust(): 10000000000000000000 (10 ether)
Slippage check: 10000000000000000000 < 10000000000000000001 → reverts with SlippageExceeded
Impact
Cross-chain unstaking and fast redemption functionality is broken for any asset amount containing dust (not divisible by 10^12). This affects approximately 69% of real-world transaction amounts including:

ERC4626 share-to-asset conversions with yield
Fee calculations (fast redeem fee deductions)
Any division operations
Users who have completed their cooldown period and attempt to unstake cross-chain will have their transactions fail, leaving their funds inaccessible through normal protocol operations until owner intervention via rescueToken().

Recommended mitigation steps
Set minAmountLD to 0 or calculate the dust-removed amount to use as the minimum:

Option 1: No slippage protection (recommended):

// Acceptable since amount is protocol-determined, not user-provided

_sendParam.minAmountLD = 0;
Option 2: Account for dust removal:

_sendParam.minAmountLD = (assets / 1e12) * 1e12;
For _handleUnstake():

SendParam memory _sendParam = SendParam({

    dstEid: _origin.srcEid,

    to: bytes32(uint256(uint160(user))),

    amountLD: assets,

-   minAmountLD: assets,

+   minAmountLD: 0,

    extraOptions: options,

    composeMsg: "",

    oftCmd: ""

});
For _fastRedeem()`:

_sendParam.amountLD = assets;

- _sendParam.minAmountLD = assets;

+ _sendParam.minAmountLD = 0;
Proof of Concept
Add DustRemovalRevert.t.sol file to the test folder:

View detailed Proof of Concept

Run the PoC:

forge test --match-contract DustRemovalRevertPOC -vv
Key test results:

test_POC_CoreIssue_DustRemovalCausesRevert - Confirms vulnerability with amounts containing dust
test_POC_ImpactScale_MostAmountsAffected - Shows 69% of realistic amounts fail (25/36 scenarios)
test_POC_ProofOfFix_MinAmountZero - Validates both fixes work correctly
test_POC_VulnerableCodePaths - Documents vulnerable locations and fix
The PoC demonstrates that any amount not perfectly divisible by 1,000,000,000,000 (1e12) will cause cross-chain operations to revert, breaking core protocol functionality.

[M-03] Incompatibility with Account Abstraction and Multisigs due to enforced address symmetry in cross chain unstaking
Submitted by KuwaTakushi, also found by Bobai23 and Tarnished

token/wiTRY/crosschain/UnstakeMessenger.sol #L120
token/wiTRY/crosschain/wiTryVaultComposer.sol #L266
Finding description
The UnstakeMessenger contract on the Spoke chain handles the initiation of cross chain unstaking requests. The unstake function constructs the cross chain payload but fails to allow the caller to specify a destination recipient address. It explicitly hardcodes the user field (the recipient of the funds on the Hub chain) to be msg.sender.

function unstake(uint256 returnTripAllocation) external payable nonReentrant returns (bytes32 guid) {

    ...

    bytes memory extraOptions = OptionsBuilder.newOptions();


    UnstakeMessage memory message = UnstakeMessage({

@>      user: msg.sender, 

        extraOptions: extraOptions

    });

    

    bytes memory payload = abi.encode(MSG_TYPE_UNSTAKE, message);

    ...

}
On the Hub chain, the wiTryVaultComposer receives this message and uses the user field as the destination for the withdrawn assets.

function _handleUnstake(Origin calldata _origin, bytes32 _guid, IUnstakeMessenger.UnstakeMessage memory unstakeMsg)

    internal

    virtual

{

    address user = unstakeMsg.user;

    ...

    SendParam memory _sendParam = SendParam({

        dstEid: _origin.srcEid,

@>      to: bytes32(uint256(uint160(user))), 

        amountLD: assets,

        minAmountLD: assets,

        extraOptions: options,

        composeMsg: "",

        oftCmd: ""

    });


    _send(ASSET_OFT, _sendParam, address(this));

    ...

}
This enforced address symmetry assumes that the user controls the same address on both chains. This assumption fails for Smart Contract Wallets, Account Abstraction (AA) wallets, and Multisigs (e.g., Gnosis Safe), as their addresses often differ across chains due to nonce mismatches.

Impact
Users with Account Abstraction (AA) wallets or Multisigs will permanently lose their assets.

Recommended mitigation steps
Update the unstake function in UnstakeMessenger to accept an optional _recipient parameter. This allows users to specify the destination address on the Hub chain.

- function unstake(uint256 returnTripAllocation, address _recipient) external payable nonReentrant returns (bytes32 guid) {

+ function unstake(uint256 returnTripAllocation) external payable nonReentrant returns (bytes32 guid) {

    if (peers[hubEid] == bytes32(0)) revert HubNotConfigured();

    if (returnTripAllocation == 0) revert InvalidReturnTripAllocation();


    address targetUser = _recipient == address(0) ? msg.sender : _recipient;


    bytes memory extraOptions = OptionsBuilder.newOptions();


    UnstakeMessage memory message = UnstakeMessage({

-        user: msg.sender,

+        user: targetUser, 

        extraOptions: extraOptions

    });

    

    bytes memory payload = abi.encode(MSG_TYPE_UNSTAKE, message);

    ...

}
Proof of Concept
Add this PoC to UnstakeMessenger.t.sol:

View detailed Proof of Concept

Logs:

forge test --match-test test_POC_HardcodedRecipient_Prevents_Multisig_Migration -vvv

[⠆] Compiling...

[⠆] Compiling 1 files with Solc 0.8.20

[⠰] Solc 0.8.20 finished in 18.04s

Compiler run successful with warnings:

Warning (2018): Function state mutability can be restricted to view

   --> test/crosschainTests/crosschain/UnstakeMessenger.t.sol:246:5:

    |

246 |     function test_Constructor_InitializesCorrectly() public {

    |     ^ (Relevant source part starts here and spans across multiple lines).


Ran 1 test for test/crosschainTests/crosschain/UnstakeMessenger.t.sol:UnstakeMessengerTest        

[PASS] test_POC_HardcodedRecipient_Prevents_Multisig_Migration() (gas: 491951)

Logs:

  -------------------------------------------------------

  [POC] Testing Forced Address Symmetry Vulnerability

  -------------------------------------------------------

  Sender (Spoke Chain):     0xE8B00b2fe39c1A1CF00DE5de5C14ac3A8db2B7eE

  Desired Recipient (Hub):  0x0eF6C1d0dbEd6836E84DF31f29B33C4EBDf71B4a

  Actual Forced Recipient:  0xE8B00b2fe39c1A1CF00DE5de5C14ac3A8db2B7eE

  -------------------------------------------------------


Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 2.66ms (816.20µs CPU time)


Ran 1 test suite in 59.29ms (2.66ms CPU time): 1 tests passed, 0 failed, 0 skipped (1 total tests)
Low Risk and Informational Issues
For this audit, 33 QA reports were submitted by wardens compiling low risk and informational issues. The QA report highlighted below by jerry0422 received the top score from the judge. 20 Low-severity findings were also submitted individually, and can be viewed here.

The following wardens also submitted QA reports: 0x97, 0xbrett8571, 0xFBI, 0xIconart, 0xki, 0xnija, 0xSeer, adecs, aman234, arunabha003, BlueSheep, Bobai23, Bube, BugNet, cosin3, czarcas7ic, Diavolo, felconsec, freebird0323, home1344, KKKKK, kmkm, legat, Polaris_Snowfall, PolarizedLight, slvDev, Sparrow, tobi0x18, valarislife, vangrim, y4y, and zcai.

[01] unstakeThroughComposer lacks cooldownDuration == 0 bypass, causing inconsistent behavior for cross-chain users when admin disables cooldown
token/wiTRY/StakediTryCrosschain.sol #L89
token/wiTRY/StakediTryCooldown.sol #L84
Finding description and impact
The base unstake() function in StakediTryCooldown.sol includes a bypass that allows users to claim their assets immediately when cooldownDuration is set to 0:

// StakediTryCooldown.sol:84

if (block.timestamp >= userCooldown.cooldownEnd || cooldownDuration == 0) {
The comment explicitly documents this design:

"unstake can be called after cooldown have been set to 0, to let accounts to be able to claim remaining assets locked at Silo"
However, unstakeThroughComposer() in StakediTryCrosschain.sol does not include this bypass:

// StakediTryCrosschain.sol:89

if (block.timestamp >= userCooldown.cooldownEnd) {
When the admin sets cooldownDuration = 0 to switch to ERC4626 standard mode, local users can immediately claim their pending cooldown assets via unstake(). Cross-chain users attempting to claim via unstakeThroughComposer() must still wait until their original cooldownEnd timestamp (up to 90 days).

This creates inconsistent behavior between local and cross-chain users during a legitimate protocol state transition. Cross-chain users experience degraded availability of their funds compared to local users under identical protocol conditions.

Recommended mitigation steps
Add the cooldownDuration == 0 bypass to unstakeThroughComposer():

function unstakeThroughComposer(address receiver)

    external

    onlyRole(COMPOSER_ROLE)

    nonReentrant

    returns (uint256 assets)

{

    if (receiver == address(0)) revert InvalidZeroAddress();


    UserCooldown storage userCooldown = cooldowns[receiver];

    assets = userCooldown.underlyingAmount;


-   if (block.timestamp >= userCooldown.cooldownEnd) {

+   if (block.timestamp >= userCooldown.cooldownEnd || cooldownDuration == 0) {

        userCooldown.cooldownEnd = 0;

        userCooldown.underlyingAmount = 0;


        silo.withdraw(msg.sender, assets);

    } else {

        revert InvalidCooldown();

    }


    emit UnstakeThroughComposer(msg.sender, receiver, assets);


    return assets;

}
[02] Missing access control in FastAccessVault.rebalanceFunds() enables griefing attacks
protocol/FastAccessVault.sol #L165-L181
protocol/interfaces/IFastAccessVault.sol #L140-L145
Finding description
The FastAccessVault.rebalanceFunds() function is declared as external without any access control modifier, contradicting its interface specification which explicitly states @dev is only callable by owner (line 141 of IFastAccessVault.sol).

// Interface specification (IFastAccessVault.sol:141)

* @dev Only callable by owner. Requests top-up from custodian if under target,

*      or transfers excess to custodian if over target


// Actual implementation (FastAccessVault.sol:165)

function rebalanceFunds() external {  // Missing onlyOwner modifier

    uint256 aumReferenceValue = _issuerContract.getCollateralUnderCustody();

    uint256 targetBalance = _calculateTargetBufferBalance(aumReferenceValue);

    uint256 currentBalance = _vaultToken.balanceOf(address(this));


    if (currentBalance < targetBalance) {

        emit TopUpRequestedFromCustodian(address(custodian), needed, targetBalance);

    } else if (currentBalance > targetBalance) {

        _vaultToken.transfer(custodian, excess);  // Anyone can trigger this

    }

}
Impact
Liquidity griefing: An attacker can repeatedly call rebalanceFunds() immediately after the custodian tops up the vault, forcing excess funds back to the custodian. This defeats the purpose of the “Fast Access Vault” by preventing it from maintaining buffer liquidity above the minimum target, forcing users to wait for slow custodian redemptions.

Recommended mitigation steps
Add the onlyOwner modifier to match the interface specification:

function rebalanceFunds() external onlyOwner {

    uint256 aumReferenceValue = _issuerContract.getCollateralUnderCustody();

    uint256 targetBalance = _calculateTargetBufferBalance(aumReferenceValue);

    uint256 currentBalance = _vaultToken.balanceOf(address(this));

    // ... rest of function

}
Alternatively, if automated rebalancing is desired, implement a keeper role or cooldown mechanism to prevent griefing.

[03] FULL_RESTRICTED_STAKER_ROLE users can bypass access controls via composer-created cooldowns
token/wiTRY/StakediTryCrosschain.sol #L171-L183
token/wiTRY/StakediTryCooldown.sol #L78-L95
Root Cause
The StakediTryCrosschain._startComposerCooldown() function creates cooldown entitlements for any redeemer address without validating whether the redeemer has FULL_RESTRICTED_STAKER_ROLE. When the function calls _withdraw(), it only validates the composer’s role status, not the redeemer’s:

function _startComposerCooldown(address composer, address redeemer, uint256 shares, uint256 assets) private {

    uint104 cooldownEnd = uint104(block.timestamp) + cooldownDuration;


    // _withdraw only checks: composer (caller), silo (receiver), composer (owner)

    // The redeemer parameter is NEVER validated for FULL_RESTRICTED_STAKER_ROLE

    _withdraw(composer, address(silo), composer, assets, shares);


    // Cooldown created for redeemer regardless of restriction status

    cooldowns[redeemer].cooldownEnd = cooldownEnd;

    cooldowns[redeemer].underlyingAmount += uint152(assets);


    emit ComposerCooldownInitiated(composer, redeemer, shares, assets, cooldownEnd);

}
The _withdraw() function in StakediTry.sol validates the FULL_RESTRICTED_STAKER_ROLE for caller, receiver, and _owner:

function _withdraw(address caller, address receiver, address _owner, uint256 assets, uint256 shares)

    internal

    override

    nonReentrant

    notZero(assets)

    notZero(shares)

{

    if (

        hasRole(FULL_RESTRICTED_STAKER_ROLE, caller) || hasRole(FULL_RESTRICTED_STAKER_ROLE, receiver)

            || hasRole(FULL_RESTRICTED_STAKER_ROLE, _owner)

    ) {

        revert OperationNotAllowed();

    }

    // ...

}
When _startComposerCooldown() calls _withdraw(composer, address(silo), composer, assets, shares), all three parameters are either the non-restricted composer or the silo contract, so the check passes. However, the redeemer parameter—who will ultimately claim the assets—is never validated.

Subsequently, when the restricted user calls unstake(), there are no role checks:

function unstake(address receiver) external {

    UserCooldown storage userCooldown = cooldowns[msg.sender];

    // ... timing validations only, no role checks ...

    silo.withdraw(receiver, assets);

}
Impact
This vulnerability allows FULL_RESTRICTED_STAKER_ROLE users to completely bypass access controls:

Defeats KYC/Compliance Mechanisms: Users who should be restricted from local withdrawals can claim iTRY tokens directly
Sanctions Bypass: Blacklisted/sanctioned addresses can withdraw funds they should never access
Impairs Rescue Operations: During security incidents or hacks, the protocol cannot freeze assets for restricted users who have cooldown entitlements
Breaks Core Invariant: Violates the stated requirement that “blacklist/whitelist bugs that would impair rescue operations in case of hacks or similar black swan events” are critical concerns
This directly addresses the sponsor’s concern: “Can the system deal with black swan scenarios?” and “Are the access controls effective?”

Attack Flow
Composer (legitimate role) calls cooldownSharesByComposer(shares, restrictedUserAddress).
_startComposerCooldown() validates only the composer, not the redeemer.
cooldowns[restrictedUserAddress] is populated with cooldown entitlement.
Time passes (cooldown period elapses).
Restricted user calls unstake(receiver) with no role validation.
Restricted user successfully withdraws iTRY tokens locally, bypassing all restrictions.
Recommended Mitigation Steps
Add validation in _startComposerCooldown() to reject restricted redeemers:

function _startComposerCooldown(address composer, address redeemer, uint256 shares, uint256 assets) private {

+   if (hasRole(FULL_RESTRICTED_STAKER_ROLE, redeemer)) {

+       revert OperationNotAllowed();

+   }

+

    uint104 cooldownEnd = uint104(block.timestamp) + cooldownDuration;

    _withdraw(composer, address(silo), composer, assets, shares);

    cooldowns[redeemer].cooldownEnd = cooldownEnd;

    cooldowns[redeemer].underlyingAmount += uint152(assets);

    emit ComposerCooldownInitiated(composer, redeemer, shares, assets, cooldownEnd);

}
Alternatively, add role checks in unstake():

function unstake(address receiver) external {

+   if (hasRole(FULL_RESTRICTED_STAKER_ROLE, msg.sender)) {

+       revert OperationNotAllowed();

+   }

    UserCooldown storage userCooldown = cooldowns[msg.sender];

    // ... rest of function

}
[04] burnExcessITry() burns from admin’s balance instead of from excess supply, requiring explicit token transfers
protocol/iTryIssuer.sol #L373-390

Finding description
The burnExcessITry() function is designed to remove excess iTRY from circulation when the accounting needs correction (e.g., after oracle price manipulation or accounting errors). However, the current implementation burns tokens from msg.sender (the admin) rather than providing a flexible mechanism to burn from any address or from the contract itself:

function burnExcessITry(uint256 iTRYAmount)

    public

    onlyRole(DEFAULT_ADMIN_ROLE)

    nonReentrant

{

    if (iTRYAmount == 0) revert CommonErrors.ZeroAmount();

    if (iTRYAmount > _totalIssuedITry) {

        revert AmountExceedsITryIssuance(iTRYAmount, _totalIssuedITry);

    }

    

    _burn(msg.sender, iTRYAmount);  // Burns from admin only

    

    emit excessITryRemoved(iTRYAmount, _totalIssuedITry);

}
The _burn() function calls iTryToken.burnFrom(from, amount), which inherits from OpenZeppelin’s ERC20BurnableUpgradeable. This requires either:

The caller owns the tokens (msg.sender == from).
The caller has sufficient allowance from the from address.
Impact
Operational friction: Admin must first acquire the excess iTRY tokens (via transfer or other means) before burning them.
Semantic confusion: The function name suggests burning “excess supply”, but actually burns from admin’s personal holdings.
Incomplete emergency response: If excess iTRY is distributed across multiple addresses (e.g., from yield distribution errors), the admin cannot directly burn it without users first transferring tokens.
Gas inefficiency: Requires two transactions (transfer to admin, then burn) instead of one.
Example scenario
Oracle manipulation causes 1M excess iTRY to be minted as yield to yieldReceiver.
Admin wants to burn this excess.
Current implementation: Admin must first get yieldReceiver to transfer 1M iTRY, then call burnExcessITry().
Expected: Admin should be able to burn from yieldReceiver directly (with proper authorization).
Recommended mitigation steps
Add a from parameter to allow burning from any address (with proper access control):

function burnExcessITry(address from, uint256 iTRYAmount)

    public

    onlyRole(DEFAULT_ADMIN_ROLE)

    nonReentrant

{

    if (from == address(0)) revert CommonErrors.ZeroAddress();

    if (iTRYAmount == 0) revert CommonErrors.ZeroAmount();

    if (iTRYAmount > _totalIssuedITry) {

        revert AmountExceedsITryIssuance(iTRYAmount, _totalIssuedITry);

    }

    

    _burn(from, iTRYAmount);

    

    emit excessITryRemoved(from, iTRYAmount, _totalIssuedITry);

}
[05] Blacklist mechanism enables owner to confiscate user funds via redistributeLockedAmount()
token/wiTRY/StakediTry.sol #L168-L183

Finding description
The StakediTry contract implements a blacklist mechanism through FULL_RESTRICTED_STAKER_ROLE that goes beyond typical freeze functionality - it enables full confiscation of user funds. The redistributeLockedAmount() function allows the DEFAULT_ADMIN_ROLE owner to burn all wiTRY shares from a blacklisted user and mint them to any arbitrary address, including the owner themselves.

function redistributeLockedAmount(address from, address to) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {

    if (hasRole(FULL_RESTRICTED_STAKER_ROLE, from) && !hasRole(FULL_RESTRICTED_STAKER_ROLE, to)) {

        uint256 amountToDistribute = balanceOf(from);

        uint256 iTryToVest = previewRedeem(amountToDistribute);

        _burn(from, amountToDistribute);

        _checkMinShares();

        // to address of address(0) enables burning

        if (to == address(0)) {

            _updateVestingAmount(iTryToVest);

        } else {

            _mint(to, amountToDistribute);  // Owner can mint to themselves

        }


        emit LockedAmountRedistributed(from, to, amountToDistribute);

    }

}
This creates significant centralization risk as the owner has unilateral power to:

Blacklist any user at any time via addToBlacklist(user, true).
Immediately confiscate their entire wiTRY balance via redistributeLockedAmount(user, owner).
Transfer the confiscated funds to any address without user consent or recourse.
Unlike traditional blacklist implementations (e.g., USDC) that only freeze funds pending legal resolution, this mechanism enables outright confiscation. Users have no protection against potential owner compromise, governance attacks, or malicious actions.

Impact
Loss of user funds through administrative privilege abuse. Users cannot protect themselves as the owner can blacklist and confiscate at any time without notice.

Recommended mitigation steps
Remove confiscation capability: Change redistributeLockedAmount() to only allow burning to address(0) (returning funds to the yield pool), not minting to arbitrary addresses:
function redistributeLockedAmount(address from) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {

    if (hasRole(FULL_RESTRICTED_STAKER_ROLE, from)) {

        uint256 amountToDistribute = balanceOf(from);

        uint256 iTryToVest = previewRedeem(amountToDistribute);

        _burn(from, amountToDistribute);

        _checkMinShares();

        _updateVestingAmount(iTryToVest);  // Always return to pool

        

        emit LockedAmountRedistributed(from, address(0), amountToDistribute);

    }

}
Add timelock: Implement a mandatory timelock period between blacklisting and redistribution to give users time to exit positions or dispute the action.
Require multisig: Use a multisig wallet with multiple independent signers for the DEFAULT_ADMIN_ROLE to prevent unilateral confiscation.
[06] YieldForwarder.rescueToken() lacks protection against rescuing yieldToken, enabling owner to divert yield
protocol/YieldForwarder.sol #L164-L177

Finding description and impact
The YieldForwarder contract implements a rescueToken() function intended for emergency recovery of accidentally sent tokens. However, unlike similar rescue functions in other protocol contracts (e.g., StakediTry.rescueTokens() which explicitly blocks rescuing the asset()), this function lacks any safeguard preventing the rescue of the operational yieldToken.

function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {

    if (to == address(0)) revert CommonErrors.ZeroAddress();

    if (amount == 0) revert CommonErrors.ZeroAmount();


    if (token == address(0)) {

        // Rescue ETH

        (bool success,) = to.call{value: amount}("");

        if (!success) revert CommonErrors.TransferFailed();

    } else {

        // Rescue ERC20 tokens

        IERC20(token).safeTransfer(to, amount); // @audit No check for yieldToken

    }


    emit TokensRescued(token, to, amount);

}
This creates a centralization risk where the owner can divert yield intended for the yieldRecipient by calling rescueToken(address(yieldToken), owner, amount). While this requires intentional owner action, it represents a deviation from the protocol’s design pattern of protecting operational tokens and creates an attack vector for malicious or compromised owner keys.

Recommended mitigation steps
Add a validation check to prevent rescuing the operational yieldToken, consistent with the pattern used in StakediTry.rescueTokens():

function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {

+   if (token == address(yieldToken)) revert InvalidToken();

    if (to == address(0)) revert CommonErrors.ZeroAddress();

    if (amount == 0) revert CommonErrors.ZeroAmount();


    if (token == address(0)) {

        // Rescue ETH

        (bool success,) = to.call{value: amount}("");

        if (!success) revert CommonErrors.TransferFailed();

    } else {

        // Rescue ERC20 tokens

        IERC20(token).safeTransfer(to, amount);

    }


    emit TokensRescued(token, to, amount);

}
This ensures the rescue function serves only its intended emergency purpose without enabling yield diversion.

Disclosures
C4 audits incentivize the discovery of exploits, vulnerabilities, and bugs in smart contracts. Security researchers are rewarded at an increasing rate for finding higher-risk issues. Audit submissions are judged by a knowledgeable security researcher and disclosed to sponsoring developers. C4 does not conduct formal verification regarding the provided code but instead provides final verification.

C4 does not provide any guarantee or warranty regarding the security of this project. All smart contract software should be used at the sole risk and responsibility of users.