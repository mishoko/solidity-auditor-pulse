https://code4rena.com/audits/2025-11-megapot

Megapot Findings & Analysis Report
PUBLISHED Jan 05, 2026
Overview
About C4
Code4rena (C4) is a competitive audit platform where security researchers, referred to as Wardens, review, audit, and analyze codebases for security vulnerabilities in exchange for bounties provided by sponsoring projects.

During the audit outlined in this document, C4 conducted an analysis of the Megapot smart contract system. The audit took place from November 03 to November 13, 2025.

Final report assembled by Code4rena.

Summary
The C4 analysis yielded an aggregated total of 11 unique vulnerabilities. Of these vulnerabilities, 3 received a risk rating in the category of HIGH severity and 8 received a risk rating in the category of MEDIUM severity.

Additionally, C4 analysis included 65 reports detailing issues with a risk rating of LOW severity or non-critical.

All of the issues presented here are linked back to their original finding, which may include relevant context from the judge and Megapot team.

Considering the number of issues identified, it is statistically likely that there are more complex bugs still present that could not be identified given the time-boxed nature of this engagement. It is recommended that a follow-up audit and development of a more complex stateful test suite be undertaken prior to continuing to deploy significant monetary capital to production.

Scope
The code under review can be found within the C4 Megapot repository, and is composed of 16 smart contracts written in the Solidity programming language and includes 1709 lines of Solidity code.

The code in C4’s Megapot repository was pulled from:

Repository: https://github.com/coordinationlabs/megapot-v2-contracts
Commit hash: 707cd7f53762ebaca8cc8dac92f20776f6988180
Severity Criteria
C4 assesses the severity of disclosed vulnerabilities based on three primary risk categories: high, medium, and low/non-critical.

High-level considerations for vulnerabilities span the following key areas when conducting assessments:

Malicious Input Handling
Escalation of privileges
Arithmetic
Gas use
For more information regarding the severity criteria referenced throughout the submission review process, please refer to the documentation provided on the C4 website, specifically our section on Severity Categorization.

High Risk Findings (3)
[H-01] Attacker can steal JackpotTicketNFT’s from JackpotBridgeManager.sol
Submitted by 0xG0P1, also found by axelot, dan__vinci, frndz0ne, gizzy, montecristo, mrdafidi, mrudenko, player, prk0, random1106, and SpicyMeatball

https://github.com/code-423n4/2025-11-megapot/blob/f0a7297d59c376e38b287b2c56740617dbbfbdc7/contracts/JackpotBridgeManager.sol#L225-L243

https://github.com/code-423n4/2025-11-megapot/blob/f0a7297d59c376e38b287b2c56740617dbbfbdc7/contracts/JackpotBridgeManager.sol#L345-L362

Finding Description
The JackpotBridgeManager contract facilitates cross-chain ticket purchases and winnings claims for the Jackpot system. It acts as a custodian for NFTs representing tickets that are purchased from other chains. However, NFTs held by JackpotBridgeManager can be stolen due to an unsafe external call pattern.

Cross-chain users purchase tickets through the JackpotBridgeManager::buyTickets function. This function interacts with the Jackpot contract to mint tickets (NFTs), which are held in custody by JackpotBridgeManager. The contract internally tracks ownership of these NFTs to ensure users from different chains can later claim their winnings.

After the Jackpot draw concludes, users can claim their winnings by calling JackpotBridgeManager::claimWinnings. This function retrieves the claimed winnings from the Jackpot contract, then bridges the funds to the destination chain via the _bridgeFunds function.

The vulnerability arises in the _bridgeFunds function:

function _bridgeFunds(RelayTxData memory _bridgeDetails, uint256 _claimedAmount) private {

    if (_bridgeDetails.approveTo != address(0)) {

        usdc.approve(_bridgeDetails.approveTo, _claimedAmount);

    }


    uint256 preUSDCBalance = usdc.balanceOf(address(this));

    (bool success,) = _bridgeDetails.to.call(_bridgeDetails.data);


    if (!success) revert BridgeFundsFailed();

    uint256 postUSDCBalance = usdc.balanceOf(address(this));


    if (preUSDCBalance - postUSDCBalance != _claimedAmount) revert NotAllFundsBridged();


    emit FundsBridged(_bridgeDetails.to, _claimedAmount);

}
The _bridgeFunds function performs an external call to _bridgeDetails.to, which is user-controlled. This allows an attacker to craft arbitrary call data that executes malicious logic. By leveraging this external call, an attacker can manipulate contract state and steal NFTs held by JackpotBridgeManager.

Exploitation Scenario
The attacker purchases two tickets via JackpotBridgeManager::buyTickets.
Assume the JackpotBridgeManager is already holding multiple NFTs on behalf of legitimate cross-chain users.
After the jackpot draw, the attacker has some legitimate winning tickets but identifies a winning NFT held on behalf of a victim.
The attacker crafts a malicious claimWinnings transaction as follows:

_userTicketIds: Attacker’s own ticket IDs.
_bridgeDetails:
approveTo: Address of an attacker-controlled exploit contract.
to: Address of the jackpotNFT contract.
data: Encoded call data for safeTransferFrom(address from, address to, uint256 tokenId, bytes data),
transferring the victim’s NFT from JackpotBridgeManager to the exploit contract.
Attack Flow
The attacker calls claimWinnings, causing JackpotBridgeManager to approve the attacker’s contract for _claimedAmount.
The _bridgeFunds function then executes an external call to the jackpotNFT contract using attacker-supplied data.
This triggers safeTransferFrom, transferring the victim’s NFT to the attacker’s exploit contract.
During the transfer, the onERC721Received function in the exploit contract executes, which immediately pulls the approved USDC from JackpotBridgeManager, ensuring the USDC balance decreases by exactly _claimedAmount.
As a result, the post-call balance check

if (preUSDCBalance - postUSDCBalance != _claimedAmount) revert NotAllFundsBridged();
passes successfully, allowing the transaction to complete without reverting.

The victim’s NFT is now transferred to the attacker’s contract, resulting in loss of user assets.
Recommended mitigation steps
Validate RelayTxData before performing the external call or perform external call only on whitelisted addresses.

Expand for detailed Proof of Concept
[H-02] Unoptimized subset matches counting implementation will exceed tx gas limit on base chain
Submitted by montecristo, also found by 0xscater, anchabadze, fullstop, harry, romans, sl1, and touristS

https://github.com/code-423n4/2025-11-megapot/blob/f0a7297d59c376e38b287b2c56740617dbbfbdc7/contracts/lib/TicketComboTracker.sol#L157-L160

Finding description and impact
During a drawing settlement, there is a very expensive calculation that counts all subset matches:

The stacktrace is displayed here:

File: 2025-11-megapot/contracts/Jackpot.sol

717:     function scaledEntropyCallback(

718:         bytes32,

719:         uint256[][] memory _randomNumbers,

720:         bytes memory

721:     )

722:         external

723:         nonReentrant

724:         onlyEntropy

725:     {

... // @audit trace 1

732:@>       (uint256 winningNumbers, uint256 drawingUserWinnings) = _calculateDrawingUserWinnings(currentDrawingState, _randomNumbers);

...

1614:     function _calculateDrawingUserWinnings(

1615:         DrawingState storage _currentDrawingState,

1616:         uint256[][] memory _unPackedWinningNumbers

1617:     )

1618:         internal

1619:         returns(uint256 winningNumbers, uint256 drawingUserWinnings)

1620:     {

1621:         // Note that the total amount of winning tickets for a given tier is the sum of result and dupResult

1622:         (

1623:             uint256 winningTicket,

1624:             uint256[] memory uniqueResult,

1625:             uint256[] memory dupResult

// @audit trace 2

1626:@>       ) = TicketComboTracker.countTierMatchesWithBonusball(drawingEntries[currentDrawingId],

1627:             _unPackedWinningNumbers[0].toUint8Array(),      // normal balls

1628:             _unPackedWinningNumbers[1][0].toUint8()         // bonusball

1629:         );
File: 2025-11-megapot/contracts/lib/TicketComboTracker.sol

250:     function countTierMatchesWithBonusball(

251:         Tracker storage _tracker,

252:         uint8[] memory _normalBalls,

253:         uint8 _bonusball

254:     )

255:         internal

256:         view

257:         returns (uint256 winningTicket, uint256[] memory uniqueResult, uint256[] memory dupResult)

258:     {

...// @audit trace 3

263:@>       (uint256[] memory matches, uint256[] memory dupMatches) = _countSubsetMatches(_tracker, set, _bonusball);

...

145:     function _countSubsetMatches(

146:         Tracker storage _tracker,

147:         uint256 _normalBallsBitVector,

148:         uint8 _bonusball

149:     )

150:         private

151:         view

152:         returns (uint256[] memory matches, uint256[] memory dupMatches)

153:     {

154:         matches = new uint256[]((_tracker.normalTiers+1)*2);

155:         dupMatches = new uint256[]((_tracker.normalTiers+1)*2);

156:// @audit trace 4: the final culprit         

157:@>       for (uint8 i = 1; i <= _tracker.bonusballMax; i++) {

158:@>           for (uint8 k = 1; k <= _tracker.normalTiers; k++) {

159:@>               uint256[] memory subsets = Combinations.generateSubsets(_normalBallsBitVector, k);
We’re generating subsets of _normalBallsBitVector for bonusballMax * 5 times.

For sufficiently high bonusballMax, the gas limit will exceed tx gas limit of 25M on base chain.

For example, as we’ll see in the POC, in the following configuration:

normallBallMax: 30
poolCap: 16Me6 USDC (worth of 16M USD)
bonusBallMax: 129
Gas consumption is estimated to be 25,834,562

Impact

Due to tx gas limit violation , Pyth network’s entropy provider will not be able to invoke the callback
As a result, drawing can never be settled
Recommended mitigation steps
subsets can be cached in the following way:
diff --git a/contracts/lib/TicketComboTracker.sol b/contracts/lib/TicketComboTracker.sol

index 3545a8a..36b1c02 100644

--- a/contracts/lib/TicketComboTracker.sol

+++ b/contracts/lib/TicketComboTracker.sol

@@ -153,10 +153,13 @@ library TicketComboTracker {

     {

         matches = new uint256[]((_tracker.normalTiers+1)*2);

         dupMatches = new uint256[]((_tracker.normalTiers+1)*2);


+        uint256[][] memory subsetsArr = new uint256[][](_tracker.normalTiers);

+        for (uint i; i<_tracker.normalTiers; i++) {

+            subsetsArr[i] = Combinations.generateSubsets(_normalBallsBitVector, i + 1);

+        }

         for (uint8 i = 1; i <= _tracker.bonusballMax; i++) {

             for (uint8 k = 1; k <= _tracker.normalTiers; k++) {

-                uint256[] memory subsets = Combinations.generateSubsets(_normalBallsBitVector, k);

+                uint256[] memory subsets = subsetsArr[k - 1];

                 for (uint256 l = 0; l < subsets.length; l++) {

                     if (i == _bonusball) {

                         matches[(k*2)+1] += _tracker.comboCounts[i][subsets[l]].count;
Define a hardcoded limit of bonusballMax
Expand for detailed Proof of Concept
[H-03] LP pool cap may be exceeded on drawing settlement
Submitted by montecristo, also found by h2134

https://github.com/code-423n4/2025-11-megapot/blob/f0a7297d59c376e38b287b2c56740617dbbfbdc7/contracts/JackpotLPManager.sol#L378

https://github.com/code-423n4/2025-11-megapot/blob/f0a7297d59c376e38b287b2c56740617dbbfbdc7/contracts/JackpotLPManager.sol#L391

Finding description and impact
Jackpot enforces pool cap as the following:

File: 2025-11-megapot/contracts/Jackpot.sol

1469:     function _calculateLpPoolCap(uint256 _normalBallMax) internal view returns (uint256) {

1470:         // We use MAX_BIT_VECTOR_SIZE because that's the max number that can be packed in a uint256 bit vector

1471:         uint256 maxAllowableTickets = Combinations.choose(_normalBallMax, NORMAL_BALL_COUNT) * (MAX_BIT_VECTOR_SIZE - _normalBallMax);

1472:         uint256 maxPrizePool = maxAllowableTickets * ticketPrice * (PRECISE_UNIT - lpEdgeTarget) / PRECISE_UNIT;

1473: 

1474:         // We need to make sure that the lpPoolCap is not greater than the governance pool cap

1475:         return Math.min(maxPrizePool * PRECISE_UNIT / (PRECISE_UNIT - reserveRatio), governancePoolCap);

1476:     }
This is to ensure the following:

bonusBallMax + normalBallMax <= MAX_BIT_VECTOR_SIZE
Pool cap does not exceed governance pool cap
Otherwise, TicketComboTracker cannot properly store purchased Ticket on max bonus ball, since the following will revert with overflow:

File: 2025-11-megapot/contracts/lib/TicketComboTracker.sol

142:         ticketNumbers = set |= 1 << (_bonusball + _tracker.normalMax);
However, LP pool cap can be exceeded on drawing settlement, because new LP value calculation does not enforce the same pool cap logic:

File: 2025-11-megapot/contracts/JackpotLPManager.sol

371:     function processDrawingSettlement(

372:         uint256 _drawingId,

373:         uint256 _lpEarnings,

374:         uint256 _userWinnings,

375:         uint256 _protocolFeeAmount

376:     ) external onlyJackpot() returns (uint256 newLPValue, uint256 newAccumulator) {

377:         LPDrawingState storage currentLP = lpDrawingState[_drawingId];

378:@>       uint256 postDrawLpValue = currentLP.lpPoolTotal + _lpEarnings - _userWinnings - _protocolFeeAmount;

...

391:@>       newLPValue = postDrawLpValue + currentLP.pendingDeposits - withdrawalsInUSDC;

392:     }
Since LP value can grow by up to lpEdgeTarget = 30% on every draw without any jackpot winner, governance cap or calculated limit can be exceeded, if previous total pool was just below the surface.

Impact
Important invariants can be broken on settlement drawing:

File: 2025-11-megapot/documentation/auditor-intro.md

1996: - **Pool Cap Compliance**: Total pool never exceeds governance limits
File: 2025-11-megapot/documentation/auditor-intro.md

2068: // Pool cap enforcement:

2069: lpPoolTotal + pendingDeposits <= governancePoolCap
File: /home/user/develop/code4rena/2025-11-megapot/documentation/auditor-intro.md

31: 11) Is all the bitpacking logic sound? Are there any potential boundary errors that could arise either between the lower bits where the normals are or the higher bits where bonusball must be less than 255 - normalBall Max?
Especially, when new pool cap exceeds calculated safe limit, bonusBallMax can be greater than 255 - normalBallMax.

This will lead to DOS on normalBallMax betting and ultimately lead to unfair betting.

Recommended mitigation steps
Enforce the same cap to newLPValue calculation.

Expand for detailed Proof of Concept
Medium Risk Findings (8)
[M-01] Global Variable Manipulation During Active Draw Alters End Result
Submitted by Alex_Cipher, also found by 0x1982us, 0xDelvine, 0xkrodhan, 0xnightswatch, 0xnija, 0xRakesh, 0xsagetony, 0xscater, 0xSecurious, 0xvd, adriansham99, Agontuk, AlexCzm, anchabadze, Aristos, Avalance, BengalCatBalu, boodieboodieboo, caglankaan, ChainSentry, d33p, Daniel_eth, dantehrani, deividrobinson, EVDoc, falde, felconsec, Fon, fromeo_016, galer_ah, h2134, HackTwist, iam_emptyset, Ishenxx, jaykosai, jerry0422, Kalogerone, khaye26, kind0dev, KKKKK, KuwaTakushi, mrudenko, mser, nathan47, niffylord, Nyxaris, oakcobalt, osok, overseer, piyushmali, prk0, PureVessel, queen, rfa, rokinot, saraswati, SavantChat, ScarletFir, shiazinho, Sneks, SOPROBRO, SpicyMeatball, sudais_b, Synthrax, touristS, vesko210, Vivekz, Waze, yeahChibyke, zcai, and ZeronautX

https://github.com/code-423n4/2025-11-megapot/blob/main/contracts/Jackpot.sol#L905-L910

https://github.com/code-423n4/2025-11-megapot/blob/main/contracts/Jackpot.sol#L1193-L1199

https://github.com/code-423n4/2025-11-megapot/blob/main/contracts/Jackpot.sol#L1171-L1177

https://github.com/code-423n4/2025-11-megapot/blob/main/contracts/Jackpot.sol#L1059-L1065

Finding description and impact
The core issue lies in the ability of the owner to modify global configuration variables during an active jackpot draw. These parameters directly influence jackpot settlement logic, fee distribution, payout calculation, and even randomness handling.
Because these values are read during settlement (after tickets have been purchased but before the draw is finalized), changing them mid-round allows the owner to unfairly alter the outcome of the draw or cause settlement failures.

Specifically, the following global variables can be updated during an active draw:

protocolFee
referralFee
payoutCalculator
entropy (entropy provider)
jackpotLPManager
Each of these variables can alter the draw’s behavior or payout path:

protocolFee / referralFee — allow manipulation of fee distribution to reduce/increse rewards to players.
payoutCalculator — can redirect or alter payout logic to arbitrary addresses.
entropy — can manipulate randomness or prevent valid settlement.
jackpotLPManager — can revert settlements or redirect LP-related funds.
Impact:
This undermines jackpot integrity, enabling admin-based manipulation of winnings, payout denial, or DoS of settlement — a severe trust and fairness violation affecting all players.

Recommended mitigation steps
Restrict all configuration-changing functions (those modifying global variables like the above) to be callable only when no active draw is in progress.
Introduce a locking mechanism that freezes sensitive parameters once a draw is initialized (initializeJackpot() called) until settlement completes.
Expand for detailed Proof of Concept
[M-02] Incorrect ticket price reference in JackpotBridgeManager causes user overpayment after price updates
Submitted by avoloder, also found by 0xDemon, 0xHarryBarz, 0xIconart, 0xnija, 0xvd, Agontuk, AlexCzm, AnantaDeva, Bbash, codertjay, dantehrani, Dulgiq, ephraimvvs, gkrastenov, glorbo, grigorovv, h2134, ht111111, InvarianteX, jaykosai, jerry0422, Nyxaris, prk0, rokinot, Samueltroydomi, saraswati, SarveshLimaye, SavantChat, ScarletFir, securehash1, stakog, threadmodeling, trailongoswami, Varun_05, vesko210, y4y, zcai, and Ziusz

https://github.com/code-423n4/2025-11-megapot/blob/f0a7297d59c376e38b287b2c56740617dbbfbdc7/contracts/JackpotBridgeManager.sol#L166-L198

Finding description and impact
In the Jackpot.sol contract, several parameters define each drawing (such as ticketPrice, bonusBall, etc.). These parameters are set at the beginning of a drawing and remain immutable for its duration. Any updates made by governance or an admin only take effect in subsequent drawings; the parameters of the current drawing are never affected.

Critical Timing Considerations:

Drawing Parameter Isolation: All drawing parameters (ticketPrice, normalBallMax, bonusballMax, referralWinShare) are frozen when the drawing is initialized
Mid-Drawing Safety: Global parameter changes during active drawings do NOT affect current ticket purchases
Next Drawing Impact: All parameter changes only take effect in the next drawing parameterization
This finding also addresses the following guiding question:

Can admin changes (e.g., ticketPrice, normalBallMax, fees) made mid-drawing create inconsistent states or violate expectations for players/LPs?

JackpotBridgeManager is a cross-chain bridge that enables ticket purchases and winnings claims across different blockchains. It acts as a custodian and defines the following flow for ticket purchases:

The user initiates a ticket purchase through the JackpotBridgeManager, providing all required information.
The JackpotBridgeManager fetches the current single-ticket price and calculates a total amount based on the number of tickets user wants. It then pulls the corresponding funds from the user.
Afterwards, It approves the Jackpot contract to spend the same amount, allowing the Jackpot contract to pull the funds when needed.
The JackpotBridgeManager calls the buyTickets function on the Jackpot contract to execute the purchase.
The Jackpot contract pulls the required funds from the JackpotBridgeManager to complete the transaction.
The problem is that the JackpotBridgeManager fetches the current ticket price defined in the Jackpot contract and not the ticket price of an actual drawing. This leads to two scenarios if the ticket price is updated:

Price Increase
If the ticket price is increased after a drawing has started, users who purchase tickets through the JackpotBridgeManager will overpay, as it fetches the latest global ticket price rather than the price fixed for the current drawing. The excess funds instead remain locked inside the JackpotBridgeManager contract.

Price decrease
If the ticket price is decreased after a drawing has started, it would result in a complete denial of service (DoS) of the manager’s buyTickets function. Because the price is lower, the manager would pull fewer funds than required for the actual purchase and, as a result, would not approve a sufficient amount for the Jackpot contract. This leads to an “insufficient approval” revert when the Jackpot contract attempts to pull the funds from the manager

Impact
Impact is High, as both likelihood and impact (Loss of funds, DoS) are High

Recommended mitigation steps
Make sure to fetch the ticket price of an actual drawing and not the latest one from the Jackpot when purchasing tickets through JackpotBridgeManager

uint256 ticketPrice = jackpot.getDrawingState(currentDrawingId).ticketPrice;

Expand for detailed Proof of Concept
[M-03] Deliberately increasing liquidity can DoS updates to the protocol’s governance parameters.
Submitted by BengalCatBalu, also found by 0xweb3boy, h2134, itsjust0xsp, KuwaTakushi, mightyraj2605, newspacexyz, odeili, sl1, and Wolf_Kalp

https://github.com/code-423n4/2025-11-megapot/blob/f0a7297d59c376e38b287b2c56740617dbbfbdc7/contracts/JackpotLPManager.sol#L433

Finding description and impact
The JackpotLPManager::setLPPoolCap function sets the lpPoolCap for LPs.
However, if the current lpPool + pendingDeposits exceeds the desired new cap, the transaction reverts.

It is trivial for LPs to increase lpPool + pendingDeposits simply by making deposits, effectively blocking the cap update.

    function processDeposit(uint256 _drawingId, address _lpAddress, uint256 _amount) external onlyJackpot() {

        // Note: this check also prevents users from depositing before initializeLPDeposits() is called since the pool cap will be 0

        // We will exclude pending withdrawals since the amount withdrawn is dependent on the post-drawing LP value. This makes this

        // check more conservative.

        uint256 totalPoolValue = lpDrawingState[_drawingId].lpPoolTotal + lpDrawingState[_drawingId].pendingDeposits;

        if (_amount + totalPoolValue > lpPoolCap) revert JackpotErrors.ExceedsPoolCap();


        LP storage lp = lpInfo[_lpAddress];


        _consolidateDeposits(lp, _drawingId);


        lp.lastDeposit.amount += _amount;

        lp.lastDeposit.drawingId = _drawingId;


        lpDrawingState[_drawingId].pendingDeposits += _amount;


        emit LpDeposited(_lpAddress, _drawingId, _amount, lpDrawingState[_drawingId].pendingDeposits);

    }


    function setLPPoolCap(uint256 _drawingId, uint256 _lpPoolCap) external onlyJackpot() {

        LPDrawingState storage currentLP = lpDrawingState[_drawingId];

        if (_lpPoolCap < currentLP.lpPoolTotal + currentLP.pendingDeposits) revert InvalidLPPoolCap();

        lpPoolCap = _lpPoolCap;

    }
The call to setLPPoolCap is triggered when updating governance parameters in the Jackpot contract.

function setNormalBallMax(uint8 _normalBallMax) external onlyOwner {

        // Note: we do not need to check if _normalBallMax is greater than 255 because it is enforced by uint8 type

        uint8 oldNormalBallMax = normalBallMax;

        jackpotLPManager.setLPPoolCap(currentDrawingId, _calculateLpPoolCap(_normalBallMax));

        normalBallMax = _normalBallMax;

        

        emit NormalBallMaxUpdated(currentDrawingId, oldNormalBallMax, _normalBallMax);

    }


function setGovernancePoolCap(uint256 _governancePoolCap) external onlyOwner {

        if (_governancePoolCap == 0) revert JackpotErrors.InvalidGovernancePoolCap();


        uint256 oldGovernancePoolCap = governancePoolCap;

        governancePoolCap = _governancePoolCap;

        jackpotLPManager.setLPPoolCap(currentDrawingId, _calculateLpPoolCap(normalBallMax));

        

        emit GovernancePoolCapUpdated(currentDrawingId, oldGovernancePoolCap, _governancePoolCap);

    }


function setLpEdgeTarget(uint256 _lpEdgeTarget) external onlyOwner {

        if (_lpEdgeTarget == 0 || _lpEdgeTarget >= PRECISE_UNIT) revert JackpotErrors.InvalidLpEdgeTarget();

        uint256 oldLpEdgeTarget = lpEdgeTarget;

        lpEdgeTarget = _lpEdgeTarget;


        jackpotLPManager.setLPPoolCap(currentDrawingId, _calculateLpPoolCap(normalBallMax));

        

        emit LpEdgeTargetUpdated(currentDrawingId, oldLpEdgeTarget, _lpEdgeTarget);

    }


function setReserveRatio(uint256 _reserveRatio) external onlyOwner {

        if (_reserveRatio >= PRECISE_UNIT) revert JackpotErrors.InvalidReserveRatio();

        uint256 oldReserveRatio = reserveRatio;

        reserveRatio = _reserveRatio;


        jackpotLPManager.setLPPoolCap(currentDrawingId, _calculateLpPoolCap(normalBallMax));

        

        emit ReserveRatioUpdated(currentDrawingId, oldReserveRatio, _reserveRatio);

    }


function setTicketPrice(uint256 _ticketPrice) external onlyOwner {

        if (_ticketPrice == 0) revert JackpotErrors.InvalidTicketPrice();

        uint256 oldTicketPrice = ticketPrice;

        ticketPrice = _ticketPrice;

        jackpotLPManager.setLPPoolCap(currentDrawingId, _calculateLpPoolCap(normalBallMax));

        

        emit TicketPriceUpdated(currentDrawingId, oldTicketPrice, _ticketPrice);

    }


function _calculateLpPoolCap(uint256 _normalBallMax) internal view returns (uint256) {

        // We use MAX_BIT_VECTOR_SIZE because that's the max number that can be packed in a uint256 bit vector

        uint256 maxAllowableTickets = Combinations.choose(_normalBallMax, NORMAL_BALL_COUNT) * (MAX_BIT_VECTOR_SIZE - _normalBallMax);

        uint256 maxPrizePool = maxAllowableTickets * ticketPrice * (PRECISE_UNIT - lpEdgeTarget) / PRECISE_UNIT;


        // We need to make sure that the lpPoolCap is not greater than the governance pool cap

        return Math.min(maxPrizePool * PRECISE_UNIT / (PRECISE_UNIT - reserveRatio), governancePoolCap);

    }
From the formula in _calculateLpPoolCap, it is clear which parameter changes reduce lpPoolCap:

Decreasing governancePoolCap
Decreasing reserveRatio
Decreasing ticketPrice
Increasing normalBallMax
Decreasing lpEdgeTarget
Each of these changes can be disadvantageous to LPs for various reasons.
The most obvious examples:

Lowering ticketPrice reduces LP earnings per ticket.
Lowering lpEdgeTarget reduces the guaranteed LP share from each drawing.
Therefore, LP providers have a clear incentive to DoS governance parameter updates that would reduce lpPoolCap.

To DoS such parameter changes, an LP only needs to frontrun the governance update with a deposit transaction.
The deposit must be large enough so that the new lpPoolTotal exceeds the value allowed by the updated parameters.
In that case, the update cannot take effect in the current drawing and will be postponed to the next one.

Practically, this means that after a successful DoS, the governance changes can only be applied after two drawings, not the current one.

It is also important to note that this attack introduces no additional risk to the LP provider.
They are simply depositing liquidity as usual, which means their risk exposure remains exactly the same as before.

Given that this is an easy DoS of the governance functionality for an undefined period of time, medium severity is appropriate.

Recommended mitigation steps
Make governance parameter updates less dependent on LP behavior.

Expand for detailed Proof of Concept
[M-04] lpEarnings generated in emergency mode become stuck on the contract
Submitted by BengalCatBalu, also found by 0xDemon, 0xnightswatch, dan__vinci, montecristo, and rokinot

https://github.com/code-423n4/2025-11-megapot/blob/f0a7297d59c376e38b287b2c56740617dbbfbdc7/contracts/Jackpot.sol#L1682

Finding description and impact
As stated in the contest README, emergency mode is an unrecoverable state. This means that the protocol does not intend to exit emergency mode once it is activated.

This means that once the jackpot enters emergency mode, the current drawing will not be completed, since runJackpot is protected by the noEmergencyMode modifier.

function runJackpot() external payable nonReentrant noEmergencyMode {
This means that the lpEarnings for the current drawing will not be included in the accumulator update (cause there will be no upgrade) and will therefore remain stuck in the protocol.

LP earnings originate from two sources:

Ticket sales
Referral win shares distributed when claiming rewards for tickets without referrers
Ticket sales are not counted during emergency mode, since users receive their funds back through emergencyRefundTickets.

However, referral win shares can still be generated in any drawing:

function _payReferrersWinnings(

        bytes32 _referralSchemeId,

        uint256 _winningAmount,

        uint256 _referralWinShare

    )         internal

        returns (uint256)

{

...

uint256 referrerShare = _winningAmount * _referralWinShare / PRECISE_UNIT;

        // If referrer scheme is empty then the referrer share goes to LPs so we just add the amount to lpEarnings

        // in order to make sure our system accounts for it

        if (_referralSchemeId == bytes32(0)) {

            drawingState[currentDrawingId].lpEarnings += referrerShare;

            emit LpEarningsUpdated(currentDrawingId, referrerShare);

            return referrerShare;

        }

...

}
Let’s look more closely at the claimWinnings call.

A user can invoke this function to claim rewards from any previous drawing (even on emergency mode).

If a ticket has no referrers, the referral win share (a percentage of the prize) is credited as lpEarnings for the current drawing, as shown in the code.

function claimWinnings(uint256[] memory _userTicketIds) external nonReentrant {

        if (_userTicketIds.length == 0) revert JackpotErrors.NoTicketsToClaim();

        uint256 totalClaimAmount = 0;

        for (uint256 i = 0; i < _userTicketIds.length; i++) {

            uint256 ticketId = _userTicketIds[i];

            IJackpotTicketNFT.TrackedTicket memory ticketInfo = jackpotNFT.getTicketInfo(ticketId);

            uint256 drawingId = ticketInfo.drawingId;

            if (IERC721(address(jackpotNFT)).ownerOf(ticketId) != msg.sender) revert JackpotErrors.NotTicketOwner();

            if (drawingId >= currentDrawingId) revert JackpotErrors.TicketFromFutureDrawing();


            DrawingState memory winningDrawingState = drawingState[drawingId];

            uint256 tierId = _calculateTicketTierId(ticketInfo.packedTicket, winningDrawingState.winningTicket, winningDrawingState.ballMax);

            jackpotNFT.burnTicket(ticketId);

            

            uint256 winningAmount = payoutCalculator.getTierPayout(drawingId, tierId);

            uint256 referrerShare = _payReferrersWinnings( // @audit lp earnings distributions here

                ticketInfo.referralScheme,

                winningAmount,

                winningDrawingState.referralWinShare

            );

            

            totalClaimAmount += winningAmount - referrerShare;

            emit TicketWinningsClaimed(

                msg.sender,

                drawingId,

                ticketId,

                tierId / 2,             // matches

                (tierId % 2) == 1,      // bonusball match

                winningAmount - referrerShare

            );

        }


        usdc.safeTransfer(msg.sender, totalClaimAmount);

    }
Thus, during emergency mode, the claimWinnings function continues generating lpEarnings, but these amounts will never be accounted for going forward. They simply remain stuck in the protocol.

Recommended mitigation steps
Add a dedicated function that allows withdrawing the stuck funds while the protocol is in emergency mode.

Expand for detailed Proof of Concept
[M-05] Randomness can be exploited in some cases
Submitted by touristS, also found by hgrano

https://github.com/code-423n4/2025-11-megapot/blob/main/contracts/ScaledEntropyProvider.sol#L251

Finding description and impact
The contract currently generates both normal balls and the bonus ball using the same seed derived from the entropy source.

https://github.com/code-423n4/2025-11-megapot/blob/main/contracts/ScaledEntropyProvider.sol#L251

function entropyCallback(uint64 sequence, address /*provider*/, bytes32 randomNumber) internal override {

    PendingRequest memory req = pending[sequence];

    if (req.callback == address(0)) revert UnknownSequence();

    

    delete pending[sequence];


@>  uint256[][] memory scaledRandomNumbers = _getScaledRandomness(randomNumber, req.setRequests);

    (bool success, ) = req.callback.call(abi.encodeWithSelector(req.selector, sequence, scaledRandomNumbers, req.context));

    if (!success) revert CallbackFailed(req.selector);


    emit EntropyFulfilled(sequence, randomNumber);

    emit ScaledRandomnessDelivered(sequence, req.callback, scaledRandomNumbers.length);

}
However, when normalballMax and bonusballMax are equal, this results in overlapping randomness - the bonus ball is always included within the normal balls.

This breaks the assumption of truly randomness. As a result, users can statistically exploit the predictable overlap to gain a higher probability of winning.

For example, when

prizePool= (2,992,626 ~ 3,092,380),
lpEdgeTarget = 30%,
normalballMax = 30, The computed bonusballMax becomes 30.
Expected odds: 1 in C(30, 5) * C(30, 1) ≈ 1 in 4,275,180
Exploited odds: 1 in C(30, 5) * C(5, 1) ≈ 1 in 712,530
This means users’ odds of winning increase roughly (bonusballMax / 5) times.

Therefore, users can deterministically exploit draws by purchasing all combinations(712,530) and guaranteeing a positive return including jackpot.

Recommended mitigation steps
Use a different seed for the bonus ball when generating random numbers.

Expand for detailed Proof of Concept
[M-06] Changes to Pyth entropy provider used by ScaledEntropyProvider allow attacker to fix jackpot result
Submitted by hgrano

https://github.com/code-423n4/2025-11-megapot/blob/f0a7297d59c376e38b287b2c56740617dbbfbdc7/contracts/ScaledEntropyProvider.sol#L300-L312

Finding description and impact
When the Jackpot requests entropy from the ScaledEntropyProvider during Jackpot::runJackpot, the ScaledEntropyProvider tracks each request by the sequence number returned from the Pyth Network Entropy contract:

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


    // [...]


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
The entropyProvider storage variable used above is the Pyth entropy provider. For each Pyth entropy provider, the sequence number is a unique value (incremented with each requestV2 call). The problem is that different Pyth entropy providers may share the same sequence number at some point. We can see the sequence numbers are tracked per provider address by the Pyth Entropy contract here.

Consider this scenario:

Attacker observes from the mempool that the owner is about to call ScaledEntropyProvider::setEntropyProvider to change Pyth entropy provider to a new address.
Attacker front-runs the admin by calling ScaledEntropyProvider::requestAndCallbackScaledRandomness which registers their callback at s, the current sequence number. They provide _requests of length 2 where the first element specifies 5 samples with minRange = 1 and maxRange = 5 - without replacement (this will always produce the same selection of all numbers 1 to 5). The second element - for the bonus ball - can have minRange = maxRange = 1 so the result is always pre-determined to be 1. The attacker can use any account/contract with callback that reverts, there by in case ScaledEntropyProvider::_entropyCallback is executed for their callback, the storage value pending[s] is never cleared due to the revert on ScaledEntropyProvider.sol:253.
Admin’s call to ScaledEntropyProvider::setEntropyProvider is executed. Let’s assume the current sequence number of the new Pyth entropy provider is less than s.
Attacker buys one or more lottery tickets with numbers to match the desired outcome from step 2.
Attacker directly calls Entropy::requestV2 for the new Pyth entropy provider until its sequence number reaches s - 1.
In the same transaction as the previous step, the attacker calls Jackpot::runJackpot which will cause pending[s] to be modified: callback, selector and context are over-written to the values required by the Jackpot. Requests will be appended onto the end of pending[s].setRequests, but the attacker’s original requests are left as-is.
New Pyth entropy provider will call Entropy::reveal which causes Jackpot::scaledEntropyCallback to be executed and only the attacker’s desired “random” numbers will be used (as they are at indices 0 and 1 in the _randomNumbers array).
Attacker will have the winning ticket and can claim their winnings.
Impact:

Attacker forces the outcome of the jackpot and claims the winning ticket at the expense of honest users and LPs.

Notes on attack feasibility:

If, in the case the new entropy provider has higher sequence number than the old one, it is possible for the attacker to front run the admin change and directly call Entropy::requestV2 several times for the old provider until its sequence number exceeds that of the new provider.

At the time of writing this submission, the sequence number for the default provider of the Entropy contract on Base mainnet is in the order of a few hundred thousand. If the difference between the old and new provider sequence numbers are at this order of magnitude, thereby requiring the attacker call Entropy::requestV2 about this many times, then this does incur a significant cost. However, if we consider the gas price of a layer 2 like Base and the potential earnings the attacker can make from the lottery win, the attack is still feasible. The attacker could split the calls up across different transactions/blocks as necessary. Additionally, if the new provider has lower sequence number than the old one, the attacker could just wait until the sequence number catches up due to normal use of the Pyth network.

Conclusion: any time the admin changes the Pyth entropy provider, they put the protocol at significant risk of being exploited.

Recommended mitigation steps
Consider changing the ScaledEntropyProvider to store requests based on sequence number and entropy provider. E.g. use a nested mapping:

--- a/contracts/ScaledEntropyProvider.sol

+++ b/contracts/ScaledEntropyProvider.sol

@@ -68,7 +68,7 @@ contract ScaledEntropyProvider is Ownable, IScaledEntropyProvider, IEntropyConsu

 

     IEntropyV2 private entropy;

     address private entropyProvider;

-    mapping(uint64 => PendingRequest) private pending;

+    mapping(address => mapping(uint64 => PendingRequest)) private pending;
Expand for detailed Proof of Concept
[M-07] Changing Entropy Provider During Active Drawing Causes Permanent Protocol Lock and Callback Failure
Submitted by Alex_Cipher, also found by 0xnightswatch, adriansham99, cosin3, edoscoba, overseer, undefined_joe, and valarislife

This submission is a duplicate of S-365 created at the judge’s request in order to appropriately allocate credit to wardens who reported partially similar issues.

Expand for detailed Proof of Concept
[M-08] Changing Payout Calculator During Active Drawing Causes Loss of Unclaimed Winnings
Submitted by Alex_Cipher, also found by 0xMilenov, AnantaDeva, BengalCatBalu, dan__vinci, edoscoba, ht111111, InvarianteX, IzuMan, l3gb, mightyraj2605, overseer, pepoc, PureVessel, rfa, rokinot, saraswati, SavantChat, stakog, TOSHI, touristS, valarislife, zcai, and Ziusz

This submission is a duplicate of S-365 created at the judge’s request in order to appropriately allocate credit to wardens who reported partially similar issues.

Expand for detailed Proof of Concept
Low Risk and Non-Critical Issues
For this audit, 65 reports were submitted by wardens detailing low risk and non-critical issues. The report highlighted below by Kris_RenZo received the top score from the judge.

The following wardens also submitted reports: 0xauditagent, 0xhacksmithh, 0xIconart, 0xki, 0xMilenov, 0xnightswatch, 0xnija, 0xsai, 0xscater, 0xterrah, 0xvictorsr, aestheticbhai, Agontuk, Ahmerdrarerh, Alan_Clan_67, AlexCzm, avoloder, BengalCatBalu, Brene, caglankaan, codexNature, cosin3, Dest1ny_rs, dmdg321, Dulgiq, Eniwealth, Eurovickk, galer_ah, gkrastenov, Glitchunter, home1344, jerry0422, johnyfwesh, K42, kind0dev, KineticsOfWeb3, kmkm, lioblaze, lscnnn, metaBug, montecristo, niffylord, pepoc, PolarizedLight, raigoza, redfox, rfa, rokinot, Sathish9098, shieldrey, slvDev, SOPROBRO, Sparrow, spectator, spidy730, sudais_b, TOSHI, v12, valarislife, winnerz, Wojack, Wsecure, X-Tray03, and yeahChibyke.

[L-01] LP Earnings Addition Can Cause LP Pool to Exceed Maximum Capacity
lpPoolCap can be broken by LP earnings. If LP deposits is at its max, and no winners were found in the current draw, the lpPoolCap will be broken when the Lp earnings from ticket sales are added to postDrawLpValue in processDrawingSettlement during settlement.

    uint256 postDrawLpValue = currentLP.lpPoolTotal + _lpEarnings - _userWinnings - _protocolFeeAmount;

    // ...
Impact
This vulnerability breaks the core invariant lpPoolTotal <= lpPoolCap, allowing the LP pool to exceed its defined capacity and bypass established risk controls. This puts the protocol in an inconsistent state—new deposits are blocked, but the pool remains over capacity until withdrawals bring it back within limits.

Note: This is a different issue from the one (“Inconsistent cap validation allows LP pool to exceed maximum capacity”) discussed in Zellic’s report. Zellic’s issue is about not factoring pending deposit in when setting lpPoolCap in JackpotLPManager::setLPPoolCap, while this is cap break cause by LP earnings.

Recommendation
Consider adding a buffer to the deposit cap validation that considers the maximum of average revenue generated from tiucket sales.

[L-02] Pool Cap Check Restricts Future Round Deposits Leading to Diminished Prize Pools
In processDeposit, the cap check uses lpPoolTotal + pendingDeposits:

        uint256 totalPoolValue = lpDrawingState[_drawingId].lpPoolTotal + lpDrawingState[_drawingId].pendingDeposits;

        if (_amount + totalPoolValue > lpPoolCap) revert JackpotErrors.ExceedsPoolCap();
However, only lpPoolTotal is used for the current drawing’s prize pool. pendingDeposits are added to the next drawing’s pool via processDrawingSettlement:

        newLPValue = postDrawLpValue + currentLP.pendingDeposits - withdrawalsInUSDC;
When lpPoolTotal is large (near lpPoolCap), little room remains for pendingDeposits to accumulate. This limits deposits intended for the next round, even though they don’t affect the current round’s prize pool.

Impact Details
If the current lpPoolTotal is large and the current prize pool is won, the next round’s prize pool can be small because pendingDeposits couldn’t accumulate. This creates a disincentive for players and limits protocol revenue. The cap check conflates current and future pool values, unnecessarily restricting deposits for the next round.

Recommendations
Consider implementing a minimum threshold that can always be reached in pendingDeposits irrespective of the current lpPoolTotal.

[L-03] Missing Validation for Normal and Bonus Ball Sum Exceeding Bit Vector Capacity Causes Incorrect LP Pool Cap Calculation
In _calculateLpPoolCap, the maximum allowable tickets calculation assumes the bit vector can represent all possible ticket combinations:

    function _calculateLpPoolCap(uint256 _normalBallMax) internal view returns (uint256) {

        // We use MAX_BIT_VECTOR_SIZE because that's the max number that can be packed in a uint256 bit vector

        uint256 maxAllowableTickets = Combinations.choose(_normalBallMax, NORMAL_BALL_COUNT) * (MAX_BIT_VECTOR_SIZE - _normalBallMax);
Tickets are packed using bit vectors where normal balls occupy positions 1 to normalBallMax, and the bonusball is stored at position normalBallMax + bonusball. Since MAX_BIT_VECTOR_SIZE = 255, the maximum usable bit position is 255.

However, there is no validation ensuring that normalBallMax + bonusballMax does not exceed 255. The bonusballMax is dynamically calculated during drawing initialization:

        uint256 combosPerBonusball = Combinations.choose(normalBallMax, NORMAL_BALL_COUNT);

        uint256 minNumberTickets = newPrizePool * PRECISE_UNIT / ((PRECISE_UNIT - lpEdgeTarget) * ticketPrice);

        uint8 newBonusball = uint8(Math.max(bonusballMin, Math.ceilDiv(minNumberTickets, combosPerBonusball)));

        newDrawingState.bonusballMax = newBonusball;
If normalBallMax + bonusballMax > 255, the bit vector representation becomes invalid, and the maxAllowableTickets calculation in _calculateLpPoolCap will be incorrect, leading to a lower lpPoolCap than intended.

Impact Details
When normalBallMax + bonusballMax exceeds 255, the system cannot correctly pack tickets into bit vectors, causing incorrect maxAllowableTickets calculations. This results in an artificially lower lpPoolCap than the target, potentially restricting LP deposits and reducing protocol capacity.

Recommendations
Add boundary validation to enforce that normalBallMax + bonusballMax never exceeds 255. Implement checks in two places:

In setNormalBallMax(): Validate that the new normalBallMax plus the maximum possible bonusballMax (or a reasonable estimate) does not exceed 255.
In _setNewDrawingState(): After calculating newBonusball, validate that normalBallMax + newBonusball <= 255. If it exceeds the limit, either revert or cap bonusballMax at 255 - normalBallMax and adjust the prize pool calculation accordingly.
[L-04] Missing Validation for Normal Ball Max Range Causes Critical Function Failures Due to Combination Library Limits and Underflow
The normalBallMax parameter can be set to values that break critical functions. The Combinations::choose function has an artificial limit:

        assert(n >= k);

        assert(n <= 128); // Artificial limit to avoid overflow
Setting normalBallMax above 128 causes Combinations.choose(normalBallMax, NORMAL_BALL_COUNT) to revert with a panic. This affects:

_calculateLpPoolCap() - called during setNormalBallMax():

    uint256 maxAllowableTickets = Combinations.choose(_normalBallMax, NORMAL_BALL_COUNT) * (MAX_BIT_VECTOR_SIZE - _normalBallMax);
_setNewDrawingState() - called by initializeJackpot():

    uint256 combosPerBonusball = Combinations.choose(normalBallMax, NORMAL_BALL_COUNT);
Additionally, setting normalBallMax below NORMAL_BALL_COUNT (5) causes an underflow in _calculateTierTotalWinningCombos():

            return Combinations.choose(NORMAL_BALL_COUNT, _matches) * Combinations.choose(_normalMax - NORMAL_BALL_COUNT, NORMAL_BALL_COUNT - _matches);
The calculation _normalMax - NORMAL_BALL_COUNT underflows when normalBallMax < 5, breaking drawing settlement.

Currently, normalBallMax is only constrained by the uint8 type (1-255) in the constructor and setNormalBallMax(), with no validation for the effective range of 5-128.

Impact Details
Setting normalBallMax outside the valid range (5-128) breaks:

initializeJackpot() - Cannot initialize new drawings if normalBallMax > 128 or < 5
calculateAndStoreDrawingUserWinnings() - Cannot calculate payouts during drawing settlement
scaledEntropyCallback() - Cannot finalize drawings due to combination calculation failures
This can permanently disable drawing initialization and settlement.

Recommendations
Add validation to enforce normalBallMax is between NORMAL_BALL_COUNT (5) and 128 in both the constructor and setNormalBallMax():

function setNormalBallMax(uint8 _normalBallMax) external onlyOwner {

    if (_normalBallMax < NORMAL_BALL_COUNT) revert JackpotErrors.InvalidNormalBallMax();

    if (_normalBallMax > 128) revert JackpotErrors.InvalidNormalBallMax();

    // ... rest of function

}
Similarly, add validation in the constructor to prevent invalid initialization.

[L-05] Unbounded Bonus Ball Max Calculation Causes Denial of Service in Drawing Settlement Due to Excessive Gas Consumption
The bonusballMax value is calculated dynamically during drawing initialization without upper bounds validation, which can cause out-of-gas errors in critical settlement functions.

Based on system constraints:

normalBallMax ranges from 5 to 128 (due to Combinations.choose limit)
bonusballMax is capped at 255 - normalBallMax (bit vector constraint)
This allows bonusballMax to range up to 250 (when normalBallMax = 5)
When bonusballMax is large (e.g., 200), the _countSubsetMatches() function performs excessive iterations:

        for (uint8 i = 1; i <= _tracker.bonusballMax; i++) {

            for (uint8 k = 1; k <= _tracker.normalTiers; k++) {

                uint256[] memory subsets = Combinations.generateSubsets(_normalBallsBitVector, k);

                for (uint256 l = 0; l < subsets.length; l++) {

                    if (i == _bonusball) {

                        matches[(k*2)+1] += _tracker.comboCounts[i][subsets[l]].count; // 3, 5, 7, 9, 11

                        dupMatches[k*2+1] += _tracker.comboCounts[i][subsets[l]].dupCount;

                    } else {

                        matches[(k*2)] += _tracker.comboCounts[i][subsets[l]].count; // 2, 4, 6, 8, 10

                        dupMatches[k*2] += _tracker.comboCounts[i][subsets[l]].dupCount;

                    }

                }

            }

        }
The iteration count is bonusballMax * normalTiers * totalSubsets, where totalSubsets = C(5,1) + C(5,2) + C(5,3) + C(5,4) + C(5,5) = 31. With bonusballMax = 200, this results in approximately 31,000 iterations (200 * 5 * 31), which can exceed the block gas limit and cause out-of-gas errors.

This affects functions called during drawing settlement:

scaledEntropyCallback() - Finalizes drawings
calculateAndStoreDrawingUserWinnings() - Calculates payouts
countTierMatchesWithBonusball() - Counts winning tickets
_countSubsetMatches(), _applyInclusionExclusionPrinciple(), and _calculateBonusballOnlyMatches() - Core calculation functions
Impact Details
When bonusballMax is large (e.g., 150-250), drawing settlement functions can run out of gas, preventing:

Finalizing ongoing drawings via scaledEntropyCallback()
Calculating and distributing winnings
Initializing new drawings
This creates a denial-of-service condition that can permanently block the protocol.

Recommendations
Add validation to cap bonusballMax at a reasonable maximum that ensures settlement functions remain within gas limits.

[L-06] Drawing Time Calculation Uses Scheduled End Time Instead of Actual Settlement Time Causing Reduced Duration for Subsequent Drawings
When _setNewDrawingState() is called during drawing settlement, it calculates the next drawing’s time using the previous drawing’s scheduled end time rather than the actual settlement time, causing subsequent drawings to run for less than the intended duration.

In scaledEntropyCallback(), the next drawing time is set as follows:

        _setNewDrawingState(newLpValue, currentDrawingState.drawingTime + drawingDurationInSeconds);
The calculation uses currentDrawingState.drawingTime + drawingDurationInSeconds, where currentDrawingState.drawingTime is the scheduled end time of the previous drawing. However, runJackpot() can only be called after this time has passed:

        if (currentDrawingState.drawingTime >= block.timestamp) revert JackpotErrors.DrawingNotDue();
The time spent executing runJackpot() and scaledEntropyCallback() (including entropy provider delays, gas costs, and network congestion) is not accounted for. As a result, the next drawing’s drawingTime is set based on the previous drawing’s scheduled end time, not when settlement actually completes.

Impact Details
Subsequent drawings receive less time than drawingDurationInSeconds due to settlement delays. This reduces the window for ticket purchases, potentially decreasing revenue and user participation.

Recommendations
Consider calculating the next drawing’s time using the actual settlement timestamp instead of the previous drawing’s scheduled end time. Modify the call to _setNewDrawingState() in scaledEntropyCallback():

_setNewDrawingState(newLpValue, block.timestamp + drawingDurationInSeconds);
[L-07] Missing User Tickets Mapping Update in JackpotBridgeManager::claimTickets Function Causes Gas Inefficiency and Incorrect Return Values
The claimTickets() function fails to update the userTickets mapping when tickets are transferred, causing getUserTickets() to consume excessive gas and return incorrect results.

When claimTickets() is called, it transfers tickets via _updateTicketOwnership():

    function _updateTicketOwnership(uint256[] memory _ticketIds, address _recipient) private {

        for (uint256 i = 0; i < _ticketIds.length; i++) {

            uint256 ticketId = _ticketIds[i];

            delete ticketOwner[ticketId];

            IERC721(address(jackpotTicketNFT)).safeTransferFrom(address(this), _recipient, ticketId);

        }

    }
This deletes the ticketOwner entry but does not update userTickets. Specifically, it does not:

Remove ticket IDs from userTickets[_recipient][drawingId].ticketIds
Decrement userTickets[_recipient][drawingId].totalTicketsOwned
As a result, getUserTickets() creates an array with the original totalTicketsOwned count and iterates over all entries. Since ticketOwner[ticketId] is deleted (becomes address(0)) for transferred tickets, the condition ticketOwner[ticketId] == _user fails, leaving those array slots as zero while still counting toward the array length.

Impact Details
This causes getUserTickets to consume more gas than supposed, and could lead to OOG error if totalTicketsOwned gets too large to iterate over. Also, it cause the function to return the wrong length of ticketIds array, although populated with real Ids and zero Ids.

Recommendations
Update the userTickets mapping in claimTickets() to remove transferred tickets.

[L-08] Pending Deposits Cannot Be Withdrawn Until Converted to Shares, Forcing Exposure to Game Risk
Users cannot withdraw pending deposits until they are converted to shares after drawing settlement, forcing exposure to game risk before withdrawal is possible.

When users deposit during a drawing, the funds are stored as pendingDeposits:

    function processDeposit(uint256 _drawingId, address _lpAddress, uint256 _amount) external onlyJackpot() {

        // ...


        lp.lastDeposit.amount += _amount;

        lp.lastDeposit.drawingId = _drawingId;


        lpDrawingState[_drawingId].pendingDeposits += _amount;


        emit LpDeposited(_lpAddress, _drawingId, _amount, lpDrawingState[_drawingId].pendingDeposits);

    }
These pendingDeposits are not part of the current drawing’s lpPoolTotal or prizePool. However, withdrawals can only be initiated on consolidatedShares:

    function processInitiateWithdraw(uint256 _drawingId, address _lpAddress, uint256 _amountToWithdrawInShares) external onlyJackpot() {

        LP storage lp = lpInfo[_lpAddress];


        _consolidateDeposits(lp, _drawingId);


        if (lp.consolidatedShares < _amountToWithdrawInShares) revert JackpotErrors.InsufficientShares();


        // ...

    }
Shares are only created from past drawings after _consolidateDeposits() processes deposits from previous drawings. When a drawing settles, pendingDeposits are added to the next drawing’s pool:

    function processDrawingSettlement(...) external onlyJackpot() returns (uint256 newLPValue, uint256 newAccumulator) {

        LPDrawingState storage currentLP = lpDrawingState[_drawingId];

        uint256 postDrawLpValue = currentLP.lpPoolTotal + _lpEarnings - _userWinnings - _protocolFeeAmount;


        // Note: we don't need to update the accumulator for the first drawing (0) since it's already set to PRECISE_UNIT

        if (_drawingId > 0) {

            // When setting for drawingId we need to use the accumulator from the previous drawing. If LP was 0 in previous

            // drawing then we need to set the accumulator to PRECISE_UNIT to avoid division by zero.

            newAccumulator = currentLP.lpPoolTotal == 0 ? PRECISE_UNIT :

                (drawingAccumulator[_drawingId - 1] * postDrawLpValue) / currentLP.lpPoolTotal;

            drawingAccumulator[_drawingId] = newAccumulator;

        }

        

        // Convert pending withdrawals to usdc to calculate the new lp value

        uint256 withdrawalsInUSDC = currentLP.pendingWithdrawals * newAccumulator / PRECISE_UNIT;

        newLPValue = postDrawLpValue + currentLP.pendingDeposits - withdrawalsInUSDC;

    }
This means users cannot withdraw their pending deposits until after settlement involving their funds, at which point the funds have been added to the next drawing’s prize pool and are exposed to game risk.

Impact Details
Users who deposit during a drawing cannot withdraw those funds until after settlement involving their funds, even though pendingDeposits are not at risk in the current drawing. By the time withdrawal becomes possible (after conversion to shares), the funds are already part of the next drawing’s prize pool and exposed to risk. This creates a lock-in period where users cannot exit their position despite their deposits not contributing to the current drawing’s risk. This reduces flexibility and may discourage participation, especially for users who want to withdraw before exposure.

Recommendations
Allow users to withdraw pending deposits directly without requiring conversion to shares first.

Disclosures
C4 audits incentivize the discovery of exploits, vulnerabilities, and bugs in smart contracts. Security researchers are rewarded at an increasing rate for finding higher-risk issues. Audit submissions are judged by a knowledgeable security researcher and disclosed to sponsoring developers. C4 does not conduct formal verification regarding the provided code but instead provides final verification.

C4 does not provide any guarantee or warranty regarding the security of this project. All smart contract software should be used at the sole risk and responsibility of users.