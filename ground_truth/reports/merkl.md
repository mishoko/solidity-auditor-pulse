https://code4rena.com/audits/2025-11-merkl

Merkl Findings & Analysis Report
PUBLISHED Jan 27, 2026
Overview
About C4
Code4rena (C4) is a competitive audit platform where security researchers, referred to as Wardens, review, audit, and analyze codebases for security vulnerabilities in exchange for bounties provided by sponsoring projects.

During the audit outlined in this document, C4 conducted an analysis of the Merkl smart contract system. The audit took place from November 25 to December 01, 2025.

Final report assembled by Code4rena.

Summary
The C4 analysis yielded an aggregated total of 3 unique vulnerabilities. Of these vulnerabilities, 0 received a risk rating in the category of HIGH severity and 3 received a risk rating in the category of MEDIUM severity.

Additionally, C4 analysis included 58 QA reports compiling issues with a risk rating of LOW severity or informational.

All of the issues presented here are linked back to their original finding, which may include relevant context from the judge and Merkl team.

Scope
The code under review can be found within the C4 Merkl repository, and is composed of 2 smart contracts written in the Solidity programming language and includes 604 lines of Solidity code.

The code in C4’s Merkl repository was pulled from:

Repository: https://github.com/AngleProtocol/merkl-contracts
Commit hash: b7bd0e65a3f366e4041bc83494cbd981f8852b16
Severity Criteria
C4 assesses the severity of disclosed vulnerabilities based on three primary risk categories: high, medium, and low/informational.

High-level considerations for vulnerabilities span the following key areas when conducting assessments:

Malicious Input Handling
Escalation of privileges
Arithmetic
Gas use
For more information regarding the severity criteria referenced throughout the submission review process, please refer to the documentation provided on the C4 website, specifically our section on Severity Categorization.

Medium Risk Findings (4)
[M-01] Minimum Reward-Per-Hour Validation Applied to Gross Instead of Net Amount
Found by V12; also found by blockace, felconsec, Glitchunter, hezze, KINGWEST, lonelybones, LonelyWolfDemon, N0nce, nachin, odeili, Scout007, slavina, SpicyMeatball, th3_hybrid, and Valves

Contract: DistributionCreator.sol #L526
Function: _createCampaign (DistributionCreator)
The contract’s minimum reward-per-hour check is applied to the campaign’s gross amount before deducting protocol fees. After the check passes, fees are subtracted, reducing the net tokens distributed per hour below the required minimum. Because there is no re-validation after fee deduction, campaigns can appear compliant on-chain while actually underpaying recipients.

Root cause
The code performs the minimum reward-per-hour validation against newCampaign.amount (gross) prior to computing and deducting fees. It never re-checks the threshold against the fee-adjusted (net) distribution amount.

Impact
Campaign creators can deploy campaigns that meet the on-chain minimum rate check but pay out at a lower rate than advertised. This undermines participant incentives, violates expected protocol guarantees, and can deceive users into accepting lower rewards.

[M-02] Improper Error Handling of onClaim Callback in _claim Function
Found by V12; also found by Ahmerdrarerh, ayushblock, Bala1796, dantehrani, fathomhewclaim, grey, Guilherme, mrdafidi, Obito, rox_k, SpicyMeatball, and Supheli

Contract: Distributor.sol #L425
Function: _claim (Distributor)
The Distributor contract’s internal _claim function uses a try/catch to isolate failures in an external onClaim callback, but misplaces and asymmetrically handles reverts and invalid return values. As implemented, successful external calls that return an unexpected magic value trigger a revert inside the try block (uncaught), while genuine external call failures are silently swallowed in the empty catch. This leads to inconsistent and undesirable outcomes: a malformed or malicious recipient can either block the entire batch or bypass critical post-claim logic.

Root cause
The try/catch surrounding the IClaimRecipient.onClaim callback is scoped only to the external call. Reverts or invalid returns detected inside the try success handler are not caught by the empty catch, and genuine external call failures are suppressed, resulting in both swallowed errors and uncaught reverts.

Impact
A malicious or buggy onClaim implementation can return an incorrect value, triggering an uncaught revert that aborts the entire claim batch and undoes successful token transfers (DOS risk and user fund rollback).
Conversely, a reverting onClaim call is silently ignored, allowing recipients to bypass intended callback logic (e.g., audit hooks or state updates), undermining protocol invariants.
[M-03] Multi-step campaign overrides are anchored to the original campaign, making later overrides impossible
Submitted by v2110, also found by ahahaHard1k, araj, arturtoros, drdee, kovacs7, peazzycole, phoenixV110, and slavina

Contract: DistributionCreator.sol #L237

overrideCampaign always validates a new override against the original campaign parameters stored in campaignList, not against any previously stored override. As a result, once a campaign has been overridden, any later override is still constrained by the original startTimestamp / duration, not by the latest override.

The override mechanism effectively becomes single-use in many realistic scenarios:

Suppose a creator:
Creates a campaign with startTimestamp = 1000, duration = 3600.
Before the original start, calls overrideCampaign to move the start to 2000 and extend duration to 7200.
Later, at block.timestamp = 1500, the creator (or operator) wants to adjust parameters again (e.g., tweak duration or start).
Because the validation is still comparing against the original: block.timestamp > _campaign.startTimestamp (1500 > 1000) is true.

If newCampaign.startTimestamp != _campaign.startTimestamp (e.g., 2000 vs original 1000), the condition: (newCampaign.startTimestamp != _campaign.startTimestamp && block.timestamp > _campaign.startTimestamp) becomes true and the transaction reverts with InvalidOverride.

Even though the effective campaign (in the off-chain engine) hasn’t started yet (new start at 2000), the contract refuses a new override due to the original start being in the past.

This leads to:

Creators being unable to adjust campaigns in multiple steps.
Operators seeing a revert even when, from a business perspective, the campaign should still be modifiable.
Given Merkl’s model where campaign creators should have flexible control over their campaigns, this is a meaningful functional break, not just cosmetic.

Recommended mitigation steps
Change overrideCampaign to validate against the effective campaign parameters:

When there is an override:

CampaignParameters memory base = campaignOverrides[_campaignId].campaignId == _campaignId

? campaignOverrides[_campaignId]

: campaignList[campaignLookup(_campaignId)];
Use base for all validation instead of the original campaignList entry.
This aligns on-chain constraints with how off-chain logic is expected to interpret campaigns.
View detailed Proof of Concept

Low Risk and Informational Issues
For this audit, 58 QA reports were submitted by wardens compiling low risk and informational issues. The QA report highlighted below by slvDev received the top score from the judge. 15 Low-severity findings were also submitted individually, and can be viewed here.

The following wardens also submitted QA reports: 0xBug_X, 0xD4n13l, 0xFBI, 0xnija, 0xpetern, 0xsai, 0xscater, 0xzerpa, AasifUsmani, Ahmerdrarerh, ameng, Aristos, arunabha003, aua_oo7, Ayomiposi233, Bobai23, Bube, desaperh, Diavolo, farismaulana, felconsec, francoHacker, grey, hezze, holtzzx, home1344, iam_emptyset, inh3l, itsravin0x, jerry0422, kestyvickky, khaye26, kovacs7, kwad, mahdifa, Manvita, Meks079, Oxhsn, oziajibogu, pfapostol, phoenixV110, PriorToHuman, rare_one, redfox, renacoder, Rikka, s4bot3ur, Shawon, Sparrow, sudais_b, The_Amazing_One, TheCarrot, unnamed, Volleyking, Yuubee, ZeronautX, and zulkifilu01.

[L-01] resolveDispute reverts when disputer is blacklisted causing dispute resolution deadlock
When disputer address becomes blacklisted (e.g. USDC blacklist), the resolveDispute(true) function reverts because it cannot transfer tokens back to disputer. This creates deadlock where Governor cannot validate legitimate dispute and also cannot call revokeTree() due to unresolved dispute check.

Finding description and impact
The Distributor contract uses push pattern for returning dispute deposits. When Governor resolves dispute as valid, the contract tries to transfer disputeAmount back to disputer:

function resolveDispute(bool valid) external onlyGovernor {

    if (disputer == address(0)) revert Errors.NoDispute();

    if (valid) {

        IERC20(disputeToken).safeTransfer(disputer, disputeAmount);  // reverts if blacklisted

        _revokeTree();

    } else {

        IERC20(disputeToken).safeTransfer(msg.sender, disputeAmount);

        endOfDisputePeriod = _endOfDisputePeriod(uint48(block.timestamp));

    }

    disputer = address(0);

    emit DisputeResolved(valid);

}
If disputer is blacklisted by token issuer (like Circle for USDC), the safeTransfer will revert. Governor then tries to call revokeTree() directly but this also fails:

function revokeTree() external onlyGovernor {

    if (disputer != address(0)) revert Errors.UnresolvedDispute();  // blocked!

    _revokeTree();

}
This is problematic because:

USDC is very common token and likely to be used as dispute token
Any address can get blacklisted for compliance reasons (not always user fault)
Attacker who submits malicious tree could try to get legitimate disputer blacklisted
Governor is stuck - cannot validate dispute, cannot revoke tree directly
The only option left for Governor is resolveDispute(false) which:

Sends deposit to Governor instead of disputer (unfair to honest disputer)
Does NOT revoke the potentially malicious tree
Extends dispute period instead of fixing the issue
Recommended mitigation steps
Use pull pattern instead of push for dispute refunds:

mapping(address => uint256) public pendingRefunds;


function resolveDispute(bool valid) external onlyGovernor {

    if (disputer == address(0)) revert Errors.NoDispute();

    if (valid) {

        pendingRefunds[disputer] += disputeAmount;  // store for withdrawal

        _revokeTree();

    } else {

        IERC20(disputeToken).safeTransfer(msg.sender, disputeAmount);

        endOfDisputePeriod = _endOfDisputePeriod(uint48(block.timestamp));

    }

    disputer = address(0);

    emit DisputeResolved(valid);

}


function claimRefund() external {

    uint256 amount = pendingRefunds[msg.sender];

    pendingRefunds[msg.sender] = 0;

    IERC20(disputeToken).safeTransfer(msg.sender, amount);

}
This way resolveDispute(true) always succeeds and disputer can claim refund when they are able to recieve tokens.

[L-02] overrideCampaign end timestamp validation uses wrong variable allowing past campaign timestamps
The overrideCampaign function in DistributionCreator contract has a validation bug on line 244. The code comment says “End timestamp should be in the future” but the check uses wrong variable - it uses _campaign.startTimestamp (old/original value) instead of newCampaign.startTimestamp (new value being set):

function overrideCampaign(bytes32 _campaignId, CampaignParameters memory newCampaign) external {

    CampaignParameters memory _campaign = campaign(_campaignId);

    _isValidOperator(_campaign.creator);

    if (

        newCampaign.rewardToken != _campaign.rewardToken ||

        newCampaign.amount != _campaign.amount ||

        (newCampaign.startTimestamp != _campaign.startTimestamp && block.timestamp > _campaign.startTimestamp) ||

        // End timestamp should be in the future

        newCampaign.duration + _campaign.startTimestamp <= block.timestamp  // BUG: uses OLD start

    ) revert Errors.InvalidOverride();

    // ...

}
The check should be:

newCampaign.duration + newCampaign.startTimestamp <= block.timestamp  // CORRECT: uses NEW start
Because of this bug, campaign creator can set both startTimestamp and end time to the past. Attack works like this:

Creator makes campaign with future start (e.g. block.timestamp + 10 days)
Creator calls override with past start (e.g. block.timestamp - 10000) and short duration
Validation passes because it checks newDuration + OLD_startTimestamp which is still in future
Campaign now has start and end timestamps both in the past
The impact is limited because:

reallocateCampaignRewards function uses original timestamps from campaign() getter, not from override
NatSpec says “invalid overrides are ignored” by off-chain Merkl engine
Creator cannot directly extract funds back
However this violates the intended invariant that “End timestamp should be in the future” and could confuse off-chain processing if engine doesnt validate timestamps properly.

Recommended mitigation steps
Fix the validation to use the new startTimestamp value:

function overrideCampaign(bytes32 _campaignId, CampaignParameters memory newCampaign) external {

    CampaignParameters memory _campaign = campaign(_campaignId);

    _isValidOperator(_campaign.creator);

    if (

        newCampaign.rewardToken != _campaign.rewardToken ||

        newCampaign.amount != _campaign.amount ||

        (newCampaign.startTimestamp != _campaign.startTimestamp && block.timestamp > _campaign.startTimestamp) ||

        // End timestamp should be in the future - use NEW startTimestamp

        newCampaign.duration + newCampaign.startTimestamp <= block.timestamp

    ) revert Errors.InvalidOverride();


    newCampaign.campaignId = _campaignId;

    newCampaign.creator = _campaign.creator;

    campaignOverrides[_campaignId] = newCampaign;

    campaignOverridesTimestamp[_campaignId].push(block.timestamp);

    emit CampaignOverride(_campaignId, newCampaign);

}
[L-03 ]overrideCampaign missing reward rate validation allows bypass of minimum amount restriction
The DistributionCreator contract has a mechanism to enforce minimum reward rates per epoch through rewardTokenMinAmounts mapping. This check is properly implemented in _createCampaign function:

function _createCampaign(CampaignParameters memory newCampaign) internal returns (bytes32) {

    uint256 rewardTokenMinAmount = rewardTokenMinAmounts[newCampaign.rewardToken];

    // if the campaign doesn't last at least one hour

    if (newCampaign.duration < HOUR) revert Errors.CampaignDurationBelowHour();

    // if the reward token is not whitelisted as an incentive token

    if (rewardTokenMinAmount == 0) revert Errors.CampaignRewardTokenNotWhitelisted();

    // if the amount distributed is too small with respect to what is allowed

    if ((newCampaign.amount * HOUR) / newCampaign.duration < rewardTokenMinAmount) revert Errors.CampaignRewardTooLow();

    // ...

}
However, the overrideCampaign function allows campaign creators to modify the duration parameter without re-validating this minimum rate check:

function overrideCampaign(bytes32 _campaignId, CampaignParameters memory newCampaign) external {

    CampaignParameters memory _campaign = campaign(_campaignId);

    _isValidOperator(_campaign.creator);

    if (

        newCampaign.rewardToken != _campaign.rewardToken ||

        newCampaign.amount != _campaign.amount ||

        (newCampaign.startTimestamp != _campaign.startTimestamp && block.timestamp > _campaign.startTimestamp) ||

        newCampaign.duration + _campaign.startTimestamp <= block.timestamp

    ) revert Errors.InvalidOverride();


    newCampaign.campaignId = _campaignId;

    newCampaign.creator = _campaign.creator;

    campaignOverrides[_campaignId] = newCampaign;

    // ...

}
The function validates that rewardToken and amount cannot change, but it does not check if the new duration value would result in reward rate below the minimum threshold.

A user can exploit this by:

Creating campaign with compliant rate (e.g., 1.8e8 tokens for 1 hour = 1.8e8/epoch rate)
Calling overrideCampaign to extend duration to 10 hours
New rate becomes 1.8e7/epoch which is below minimum of 1e8/epoch
This bypass allows creation of “dust” campaigns that distribute very small amounts per epoch, which the rewardTokenMinAmounts restriction was designed to prevent. The governance-set spam protection is rendered ineffective through this two-step process.

Recommended mitigation steps
Add the minimum reward rate validation to overrideCampaign function:

function overrideCampaign(bytes32 _campaignId, CampaignParameters memory newCampaign) external {

    CampaignParameters memory _campaign = campaign(_campaignId);

    _isValidOperator(_campaign.creator);

    if (

        newCampaign.rewardToken != _campaign.rewardToken ||

        newCampaign.amount != _campaign.amount ||

        (newCampaign.startTimestamp != _campaign.startTimestamp && block.timestamp > _campaign.startTimestamp) ||

        newCampaign.duration + _campaign.startTimestamp <= block.timestamp

    ) revert Errors.InvalidOverride();


    // Add minimum rate validation

    uint256 rewardTokenMinAmount = rewardTokenMinAmounts[newCampaign.rewardToken];

    if ((newCampaign.amount * HOUR) / newCampaign.duration < rewardTokenMinAmount)

        revert Errors.CampaignRewardTooLow();


    newCampaign.campaignId = _campaignId;

    newCampaign.creator = _campaign.creator;

    campaignOverrides[_campaignId] = newCampaign;

    campaignOverridesTimestamp[_campaignId].push(block.timestamp);

    emit CampaignOverride(_campaignId, newCampaign);

}
[L-04] _createCampaign validates minimum rate on gross amount before fee deduction
The _createCampaign function in DistributionCreator.sol validates that campaign reward rate meets the minimum requirement set by governance. However, this validation is performed on the gross amount (before fees) while the actual stored amount is the net amount (after fees are deducted).

function _createCampaign(CampaignParameters memory newCampaign) internal returns (bytes32) {

    uint256 rewardTokenMinAmount = rewardTokenMinAmounts[newCampaign.rewardToken];

    // ...

    // if the amount distributed is too small with respect to what is allowed

    if ((newCampaign.amount * HOUR) / newCampaign.duration < rewardTokenMinAmount) revert Errors.CampaignRewardTooLow();

    // Computing fees and pulling tokens

    uint256 campaignAmountMinusFees = _computeFees(newCampaign.campaignType, newCampaign.amount);

    // ...

    newCampaign.amount = campaignAmountMinusFees;  // NET amount stored

    // ...

}
The problem is that minimum rate check at line 533 uses newCampaign.amount which is gross amount before fees. But after _computeFees is called, the newCampaign.amount gets overwritten with net amount at line 538. This means campaigns can be created with actual reward rate below the governance-set minimum.

Example with 10% protocol fees:

Governance sets rewardTokenMinAmount = 1e8 for a token
User creates 1-hour campaign with exactly amount = 1e8
Validation passes: (1e8 * 3600) / 3600 = 1e8 >= 1e8
After 10% fees deducted: campaignAmountMinusFees = 0.9e8
Campaign is stored with rate of 0.9e8 per epoch, which is 10% below minimum
The rewardTokenMinAmounts mapping exists to prevent dust campaigns that spam the system. This validation order allows campaigns to bypass this protection by the exact fee percentage amount.

Recommended mitigation steps
Move the minimum rate validation after fee calculation so it checks the net amount:

function _createCampaign(CampaignParameters memory newCampaign) internal returns (bytes32) {

    uint256 rewardTokenMinAmount = rewardTokenMinAmounts[newCampaign.rewardToken];

    if (newCampaign.duration < HOUR) revert Errors.CampaignDurationBelowHour();

    if (rewardTokenMinAmount == 0) revert Errors.CampaignRewardTokenNotWhitelisted();


    // Computing fees first

    uint256 campaignAmountMinusFees = _computeFees(newCampaign.campaignType, newCampaign.amount);


    // Then validate minimum on NET amount

    if ((campaignAmountMinusFees * HOUR) / newCampaign.duration < rewardTokenMinAmount)

        revert Errors.CampaignRewardTooLow();


    if (newCampaign.creator == address(0)) newCampaign.creator = msg.sender;

    _pullTokens(newCampaign.creator, newCampaign.rewardToken, newCampaign.amount, campaignAmountMinusFees);

    newCampaign.amount = campaignAmountMinusFees;

    // ...

}
[L-05] getMerkleRoot returns old tree during dispute period allowing claims at stale rates
When admin submits corrected merkle tree to fix erroneous rewards, the getMerkleRoot() function still returns old tree root during dispute period. Users can exploit this window to claim rewards at old (incorrect) rates before correction takes effect.

Finding description and impact
The Distributor contract uses dispute period mechanism to protect against malicious tree updates. When new tree is submitted via updateTree(), the old tree becomes lastTree and new tree is stored in tree. During dispute period, getMerkleRoot() returns lastTree.merkleRoot instead of new one:

function getMerkleRoot() public view returns (bytes32) {

    if (block.timestamp >= endOfDisputePeriod && disputer == address(0))

        return tree.merkleRoot;

    else

        return lastTree.merkleRoot;  // returns OLD tree during dispute

}
This design assume old tree is always good and new tree might be bad. But when scenario is reversed - old tree has errors (like inflated rewards from off-chain computation bug) and new tree is the fix - users can front-run correction by claiming at old inflated rates.

The flow is:

Erroneous tree published with inflated rewards (e.g. alice gets 100 tokens)
Admin discovers error, submits corrected tree (alice should get 10 tokens)
During dispute period getMerkleRoot() still returns old root
Alice claims 100 tokens using old tree proofs
When dispute ends, alice already took 90 extra tokens
Impact is limited because:

Requires off-chain computation error first (not contract bug)
Governor can mitigate by doing double-update or draining funds via recoverERC20
This is design limitation, not vulnerability
However if admin does not react fast enough, users can drain more funds than they entitled to.

Recommended mitigation steps
Governor should be aware that setDisputePeriod() does not affect current pending tree and corrections cannot be applied instantly. When erroneous tree is discovered, governor should either:

Use double-update pattern - submit correction twice so corrected tree becomes lastTree
Drain funds via recoverERC20() to prevent claims during investigation
Consider adding emergency freeze mechanism for claims (but this adds centralization risk)
Alternative is to add function that allows governor to skip dispute period for specific tree update when fixing errors, but this reduces security guarantees of dispute mechanism.

Detailed Proofs of Concept for the above-listed Low-severity issues may be viewed here.

Disclosures
C4 audits incentivize the discovery of exploits, vulnerabilities, and bugs in smart contracts. Security researchers are rewarded at an increasing rate for finding higher-risk issues. Audit submissions are judged by a knowledgeable security researcher and disclosed to sponsoring developers. C4 does not conduct formal verification regarding the provided code but instead provides final verification.

C4 does not provide any guarantee or warranty regarding the security of this project. All smart contract software should be used at the sole risk and responsibility of users.