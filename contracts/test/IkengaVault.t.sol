// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/IkengaVault.sol";
import "../src/JobEscrow.sol";
import "./MockUSDT.sol";

/// @notice IkengaVault tests (Step 2, plan section 2.4).
/// Safety rule under test: the vault NEVER sends funds to an arbitrary
/// address -- only to the escrow, to a hired agent within its allowance,
/// or to the Boss.
contract IkengaVaultTest is Test {
    MockUSDT token;
    IkengaVault vault;

    address boss = address(0xB055);
    address stranger = address(0xBEEF);
    address agentWallet = address(0xA6E7);
    uint256 constant AGENT_ID = 1; // ERC-8004 agentId

    function setUp() public {
        token = new MockUSDT();
        vm.prank(boss);
        vault = new IkengaVault(boss, address(token));
        token.mint(boss, 100_000_000); // 100 USDT
        vm.startPrank(boss);
        token.approve(address(vault), 100_000_000);
        vault.deposit(100_000_000);
        vm.stopPrank();
    }

    // ---- deposit / move ----

    function testDepositCreditsOperating() public {
        assertEq(vault.bucketBalance(IkengaVault.Bucket.OPERATING), 100_000_000);
        assertEq(token.balanceOf(address(vault)), 100_000_000);
    }

    function testMoveWithinMaxMoveSucceeds() public {
        vm.prank(boss);
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.TOOLS, 5_000_000);
        assertEq(vault.bucketBalance(IkengaVault.Bucket.TOOLS), 5_000_000);
        assertEq(vault.bucketBalance(IkengaVault.Bucket.OPERATING), 95_000_000);
    }

    function testMoveAboveMaxMoveReverts() public {
        vm.prank(boss);
        vm.expectRevert("IkengaVault: above maxMove");
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.TOOLS, 5_000_001);
    }

    function testMoveOnlyBoss() public {
        vm.prank(stranger);
        vm.expectRevert("IkengaVault: only boss");
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.TOOLS, 1);
    }

    function testMoveInsufficientBucketReverts() public {
        vm.prank(boss);
        vm.expectRevert("IkengaVault: insufficient bucket");
        vault.move(IkengaVault.Bucket.TOOLS, IkengaVault.Bucket.OPERATING, 1);
    }

    function testMoveSameBucketReverts() public {
        vm.prank(boss);
        vm.expectRevert("IkengaVault: same bucket");
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.OPERATING, 1);
    }

    // ---- hire / allowance / topUp ----

    function _fundTools(uint256 amount) internal {
        vm.startPrank(boss);
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.TOOLS, amount);
        vault.hire(AGENT_ID, agentWallet);
        vault.setAllowance(AGENT_ID, amount);
        vm.stopPrank();
    }

    function testTopUpPaysAgentWithinAllowance() public {
        _fundTools(2_000_000);
        vm.prank(boss);
        vault.topUp(AGENT_ID, 1_000_000);
        assertEq(token.balanceOf(agentWallet), 1_000_000);
        assertEq(vault.agentAllowance(AGENT_ID), 1_000_000);
        assertEq(vault.bucketBalance(IkengaVault.Bucket.TOOLS), 1_000_000);
    }

    function testTopUpAboveAllowanceReverts() public {
        _fundTools(2_000_000);
        vm.prank(boss);
        vm.expectRevert("IkengaVault: above allowance");
        vault.topUp(AGENT_ID, 2_000_001);
    }

    function testTopUpUnregisteredAgentReverts() public {
        vm.prank(boss);
        vm.expectRevert("IkengaVault: unknown agent");
        vault.topUp(999, 1);
    }

    function testTopUpOnlyBoss() public {
        _fundTools(2_000_000);
        vm.prank(stranger);
        vm.expectRevert("IkengaVault: only boss");
        vault.topUp(AGENT_ID, 1);
    }

    function testTopUpAboveWeeklyBudgetReverts() public {
        // Weekly tool budget is 30 USDT; fund 31 USDT of tools.
        vm.startPrank(boss);
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.TOOLS, 5_000_000);
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.TOOLS, 5_000_000);
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.TOOLS, 5_000_000);
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.TOOLS, 5_000_000);
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.TOOLS, 5_000_000);
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.TOOLS, 5_000_000);
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.TOOLS, 1_000_000);
        vault.hire(AGENT_ID, agentWallet);
        vault.setAllowance(AGENT_ID, 31_000_000);
        vault.topUp(AGENT_ID, 30_000_000);
        vm.expectRevert("IkengaVault: weekly budget exceeded");
        vault.topUp(AGENT_ID, 1_000_000);
        vm.stopPrank();
    }

    function testHireFire() public {
        vm.startPrank(boss);
        vault.hire(AGENT_ID, agentWallet);
        assertEq(vault.agentWallet(AGENT_ID), agentWallet);
        vault.fire(AGENT_ID);
        assertEq(vault.agentWallet(AGENT_ID), address(0));
        assertEq(vault.agentAllowance(AGENT_ID), 0);
        vm.stopPrank();
        vm.prank(boss);
        vm.expectRevert("IkengaVault: unknown agent");
        vault.topUp(AGENT_ID, 1);
    }

    function testSetAllowanceOnlyBoss() public {
        vm.prank(stranger);
        vm.expectRevert("IkengaVault: only boss");
        vault.setAllowance(AGENT_ID, 1);
    }

    // ---- bond ----

    function testLockReleaseBond() public {
        vm.startPrank(boss);
        vault.registerEscrow(address(0xE5C0));
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.BOND, 1_000_000);
        vault.lockBond(address(0xE5C0), 200_000);
        assertEq(vault.lockedBond(address(0xE5C0)), 200_000);
        assertEq(vault.totalLockedBond(), 200_000);
        vault.releaseBond(address(0xE5C0));
        assertEq(vault.lockedBond(address(0xE5C0)), 0);
        assertEq(vault.totalLockedBond(), 0);
        // Bond stays in the BOND bucket after release.
        assertEq(vault.bucketBalance(IkengaVault.Bucket.BOND), 1_000_000);
        vm.stopPrank();
    }

    function testLockBondAboveBondBucketReverts() public {
        vm.prank(boss);
        vault.registerEscrow(address(0xE5C0));
        vm.prank(boss);
        vm.expectRevert("IkengaVault: bond cover exceeded");
        vault.lockBond(address(0xE5C0), 1);
    }

    function testPayBondOnlyByEscrow() public {
        vm.prank(stranger);
        vm.expectRevert("IkengaVault: only escrow");
        vault.payBond(address(0xE5C0), stranger);
    }

    // ---- propose / coSign ----

    function testProposeAloneMovesNothing() public {
        vm.prank(boss);
        uint256 id = vault.propose(boss, 10_000_000, IkengaVault.Bucket.OPERATING);
        assertEq(token.balanceOf(boss), 0);
        assertEq(vault.bucketBalance(IkengaVault.Bucket.OPERATING), 100_000_000);
        assertFalse(vault.proposalExecuted(id));
    }

    function testCoSignByBossExecutes() public {
        vm.prank(boss);
        uint256 id = vault.propose(boss, 10_000_000, IkengaVault.Bucket.OPERATING);
        vm.prank(boss);
        vault.coSign(id);
        assertEq(token.balanceOf(boss), 10_000_000);
        assertEq(vault.bucketBalance(IkengaVault.Bucket.OPERATING), 90_000_000);
        assertTrue(vault.proposalExecuted(id));
    }

    function testCoSignOnlyBoss() public {
        vm.prank(boss);
        uint256 id = vault.propose(boss, 1, IkengaVault.Bucket.OPERATING);
        vm.prank(stranger);
        vm.expectRevert("IkengaVault: only boss");
        vault.coSign(id);
    }

    function testCoSignTwiceReverts() public {
        vm.prank(boss);
        uint256 id = vault.propose(boss, 1, IkengaVault.Bucket.OPERATING);
        vm.prank(boss);
        vault.coSign(id);
        vm.prank(boss);
        vm.expectRevert("IkengaVault: already executed");
        vault.coSign(id);
    }

    function testProposeToArbitraryAddressReverts() public {
        vm.prank(boss);
        vm.expectRevert("IkengaVault: recipient not allowed");
        vault.propose(stranger, 1, IkengaVault.Bucket.OPERATING);
    }

    function testProposeToAgentWalletSucceeds() public {
        vm.prank(boss);
        vault.hire(AGENT_ID, agentWallet);
        vm.prank(boss);
        uint256 id = vault.propose(agentWallet, 1_000_000, IkengaVault.Bucket.OPERATING);
        vm.prank(boss);
        vault.coSign(id);
        assertEq(token.balanceOf(agentWallet), 1_000_000);
    }

    // ---- epochs ----

    function testOpenCloseEpoch() public {
        vm.prank(boss);
        vault.openEpoch();
        assertEq(vault.currentEpoch(), 1);
        assertEq(vault.epochToolsSpent(), 0);
        _fundTools(1_000_000);
        vm.prank(boss);
        vault.topUp(AGENT_ID, 500_000);
        assertEq(vault.epochToolsSpent(), 500_000);
        vm.prank(boss);
        vault.closeEpoch();
        vm.prank(boss);
        vault.openEpoch();
        assertEq(vault.currentEpoch(), 2);
        assertEq(vault.epochToolsSpent(), 0);
    }

    function testOpenEpochOnlyBoss() public {
        vm.prank(stranger);
        vm.expectRevert("IkengaVault: only boss");
        vault.openEpoch();
    }

    // ---- fuzz: bucket total is preserved by moves ----

    function testFuzz_MovePreservesBucketTotal(uint256 amount) public {
        amount = bound(amount, 1, 5_000_000); // at most maxMove
        uint256 before = vault.totalBuckets();
        vm.prank(boss);
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.TOOLS, amount);
        assertEq(vault.totalBuckets(), before);
        assertEq(token.balanceOf(address(vault)), vault.totalBuckets());
    }

    function testFuzz_TopUpNeverExceedsAllowance(uint256 allowance_, uint256 amount) public {
        allowance_ = bound(allowance_, 0, 2_000_000);
        amount = bound(amount, 0, 5_000_000);
        vm.startPrank(boss);
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.TOOLS, 2_000_000);
        vault.hire(AGENT_ID, agentWallet);
        vault.setAllowance(AGENT_ID, allowance_);
        vm.stopPrank();
        if (amount > allowance_) {
            vm.prank(boss);
            vm.expectRevert("IkengaVault: above allowance");
            vault.topUp(AGENT_ID, amount);
        } else {
            vm.prank(boss);
            vault.topUp(AGENT_ID, amount);
            assertEq(token.balanceOf(agentWallet), amount);
        }
    }

    function testFuzz_BondNeverExceedsBondBucket(uint256 locked) public {
        locked = bound(locked, 0, 2_000_000);
        vm.startPrank(boss);
        vault.registerEscrow(address(0xE5C0));
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.BOND, 1_000_000);
        vm.stopPrank();
        if (locked > 1_000_000) {
            vm.prank(boss);
            vm.expectRevert("IkengaVault: bond cover exceeded");
            vault.lockBond(address(0xE5C0), locked);
        } else {
            vm.prank(boss);
            vault.lockBond(address(0xE5C0), locked);
            assertLe(vault.totalLockedBond(), vault.bucketBalance(IkengaVault.Bucket.BOND));
        }
    }
}

/// @notice Stateful invariant handler: the handler drives deposits, moves
/// and top-ups with fuzzer-chosen inputs, acting as the boss via prank.
/// The vault's boss is a fixed address; the handler impersonates it.
contract VaultHandler is Test {
    MockUSDT token;
    IkengaVault vault;
    address boss;
    address agentWallet = address(0xA6E7);

    constructor(MockUSDT _token, IkengaVault _vault, address _boss) {
        token = _token;
        vault = _vault;
        boss = _boss;
        token.mint(address(this), 1_000_000_000);
        token.approve(address(vault), type(uint256).max);
        vm.startPrank(boss);
        vault.hire(1, agentWallet);
        vault.setAllowance(1, 50_000_000);
        vault.openEpoch();
        vm.stopPrank();
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 1, 1_000_000);
        vault.deposit(amount);
    }

    function moveFunds(uint256 seed, uint256 amount) external {
        IkengaVault.Bucket from = IkengaVault.Bucket(bound(seed % 4, 0, 3));
        IkengaVault.Bucket to = IkengaVault.Bucket(bound((seed / 4) % 4, 0, 3));
        amount = bound(amount, 0, 5_000_000);
        if (from == to) return;
        if (amount > vault.bucketBalance(from)) return;
        vm.prank(boss);
        vault.move(from, to, amount);
    }

    function topUpAgent(uint256 amount) external {
        amount = bound(amount, 0, 1_000_000);
        if (amount > vault.agentAllowance(1)) return;
        if (amount > vault.bucketBalance(IkengaVault.Bucket.TOOLS)) return;
        if (vault.epochToolsSpent() + amount > vault.WEEKLY_TOOL_BUDGET()) return;
        vm.prank(boss);
        vault.topUp(1, amount);
    }
}

contract IkengaVaultInvariantTest is Test {
    MockUSDT token;
    IkengaVault vault;
    VaultHandler handler;
    address boss = address(0xB055);

    function setUp() public {
        token = new MockUSDT();
        vault = new IkengaVault(boss, address(token));
        handler = new VaultHandler(token, vault, boss);
        targetContract(address(handler));
    }

    /// @notice Vault token balance always equals the sum of the buckets.
    function invariant_balanceEqualsBuckets() public view {
        assertEq(token.balanceOf(address(vault)), vault.totalBuckets());
    }

    /// @notice Bond outstanding never exceeds the BOND bucket (zero here,
    /// but the bound must hold under every handler sequence).
    function invariant_bondCovered() public view {
        assertLe(vault.totalLockedBond(), vault.bucketBalance(IkengaVault.Bucket.BOND));
    }

    /// @notice Weekly tool spend never exceeds the budget.
    function invariant_weeklyBudgetHeld() public view {
        assertLe(vault.epochToolsSpent(), vault.WEEKLY_TOOL_BUDGET());
    }
}
