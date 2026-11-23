// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/IkengaVault.sol";
import "../src/JobEscrow.sol";
import "./MockUSDT.sol";

/// @notice JobEscrow tests (Step 2, plan section 2.4).
/// Escrow settles in USDT (6 decimals, token address passed in, never hardcoded).
/// The escrow price is set at deploy: 1 USDT = 1_000_000 atomic units
/// for the USDT jobs below; a cNGN job fixes its own price at hire time
/// (about 1,445 cNGN) — see testCngnPriceFundsAndAccepts.
contract JobEscrowTest is Test {
    MockUSDT token;
    IkengaVault vault;
    JobEscrow escrow;

    address boss = address(0xB055);
    address customer = address(0xC057);
    address agentWallet = address(0xA6E7);

    uint256 constant BOND = 200_000; // 0.20 USDT, 20% bond (priceJob mid-range)
    uint256 constant PRICE = 1_000_000; // $1 in atomic units (6 decimals)
    uint256 constant CNGN_PRICE = 1_445_000_000; // $1 in cNGN at ~1,444.067 per $1, rounded up to whole cNGN
    bytes32 constant SPEC_HASH = keccak256("ikenga job spec: flyer v1");

    function setUp() public {
        token = new MockUSDT();
        vm.prank(boss);
        vault = new IkengaVault(boss, address(token));
        escrow = new JobEscrow(customer, address(vault), address(token), BOND, PRICE, SPEC_HASH);

        // Boss registers the escrow, funds the vault and locks the bond.
        vm.startPrank(boss);
        vault.registerEscrow(address(escrow));
        token.mint(boss, 10_000_000); // 10 USDT
        token.approve(address(vault), 10_000_000);
        vault.deposit(10_000_000);
        vault.move(IkengaVault.Bucket.OPERATING, IkengaVault.Bucket.BOND, 1_000_000);
        vault.lockBond(address(escrow), BOND);
        vm.stopPrank();

        // Customer funds their side and approves the escrow.
        token.mint(customer, 10_000_000);
        vm.prank(customer);
        token.approve(address(escrow), 10_000_000);
    }

    function _fund() internal {
        vm.prank(customer);
        escrow.fund();
    }

    function _submitDeliverable() internal {
        vm.prank(boss);
        vault.submitDeliverable(address(escrow), keccak256("deliverable: flyer png"));
    }

    // ---- fund ----

    function testFundExactSucceeds() public {
        _fund();
        assertEq(uint256(escrow.state()), uint256(JobEscrow.State.FUNDED));
        assertEq(token.balanceOf(address(escrow)), escrow.price());
        assertEq(token.balanceOf(customer), 10_000_000 - 1_000_000);
    }

    function testFundWrongAmountReverts() public {
        // Allowance below the price: transferFrom cannot pull exactly 1 USDT.
        vm.prank(customer);
        token.approve(address(escrow), 500_000);
        vm.prank(customer);
        vm.expectRevert();
        escrow.fund();
    }

    function testFundOnlyCustomer() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert("JobEscrow: only customer");
        escrow.fund();
    }

    function testFundTwiceReverts() public {
        _fund();
        vm.prank(customer);
        vm.expectRevert("JobEscrow: not unfunded");
        escrow.fund();
    }

    // ---- accept ----

    function testAcceptReleasesExactlyPriceToVault() public {
        _fund();
        _submitDeliverable();
        uint256 vaultBefore = token.balanceOf(address(vault));
        uint256 operatingBefore = vault.bucketBalance(IkengaVault.Bucket.OPERATING);
        vm.prank(customer);
        escrow.accept();
        assertEq(uint256(escrow.state()), uint256(JobEscrow.State.ACCEPTED));
        assertEq(token.balanceOf(address(vault)), vaultBefore + 1_000_000);
        assertEq(vault.bucketBalance(IkengaVault.Bucket.OPERATING), operatingBefore + 1_000_000);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testAcceptReleasesBondLock() public {
        _fund();
        _submitDeliverable();
        vm.prank(customer);
        escrow.accept();
        assertEq(vault.totalLockedBond(), 0);
        assertEq(vault.lockedBond(address(escrow)), 0);
        // Bond stays in the BOND bucket for the next job.
        assertEq(vault.bucketBalance(IkengaVault.Bucket.BOND), 1_000_000);
    }

    function testAcceptOnlyCustomer() public {
        _fund();
        _submitDeliverable();
        vm.prank(address(0xBEEF));
        vm.expectRevert("JobEscrow: only customer");
        escrow.accept();
    }

    function testAcceptWithoutDeliverableReverts() public {
        _fund();
        vm.prank(customer);
        vm.expectRevert("JobEscrow: no deliverable");
        escrow.accept();
    }

    function testDoubleAcceptReverts() public {
        _fund();
        _submitDeliverable();
        vm.prank(customer);
        escrow.accept();
        vm.prank(customer);
        vm.expectRevert("JobEscrow: not funded");
        escrow.accept();
    }

    // ---- reject ----

    function testRejectRefundsPricePlusBond() public {
        _fund();
        uint256 customerBefore = token.balanceOf(customer);
        vm.prank(customer);
        escrow.reject();
        assertEq(uint256(escrow.state()), uint256(JobEscrow.State.REJECTED));
        assertEq(token.balanceOf(customer), customerBefore + 1_000_000 + BOND);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(vault.bucketBalance(IkengaVault.Bucket.BOND), 1_000_000 - BOND);
        assertEq(vault.totalLockedBond(), 0);
    }

    function testRejectOnlyCustomer() public {
        _fund();
        vm.prank(address(0xBEEF));
        vm.expectRevert("JobEscrow: only customer");
        escrow.reject();
    }

    function testDoubleRejectReverts() public {
        _fund();
        vm.prank(customer);
        escrow.reject();
        vm.prank(customer);
        vm.expectRevert("JobEscrow: not funded");
        escrow.reject();
    }

    function testRejectAfterAcceptReverts() public {
        _fund();
        _submitDeliverable();
        vm.prank(customer);
        escrow.accept();
        vm.prank(customer);
        vm.expectRevert("JobEscrow: not funded");
        escrow.reject();
    }

    // ---- deadline ----

    function testDeadlineReleaseAfter48h() public {
        _fund();
        vm.warp(block.timestamp + 48 hours + 1);
        uint256 vaultBefore = token.balanceOf(address(vault));
        // Anyone may call it, not just the customer.
        vm.prank(address(0xBEEF));
        escrow.deadlineRelease();
        assertEq(uint256(escrow.state()), uint256(JobEscrow.State.RELEASED));
        assertEq(token.balanceOf(address(vault)), vaultBefore + 1_000_000);
        assertEq(vault.totalLockedBond(), 0);
    }

    function testDeadlineReleaseBefore48hReverts() public {
        _fund();
        vm.warp(block.timestamp + 48 hours - 1);
        vm.prank(address(0xBEEF));
        vm.expectRevert("JobEscrow: deadline not reached");
        escrow.deadlineRelease();
    }

    function testDeadlineReleaseAfterAcceptReverts() public {
        _fund();
        _submitDeliverable();
        vm.prank(customer);
        escrow.accept();
        vm.warp(block.timestamp + 48 hours + 1);
        vm.expectRevert("JobEscrow: not funded");
        escrow.deadlineRelease();
    }

    // ---- sealing ----

    function testSpecHashIsSealed() public {
        assertEq(escrow.specHash(), SPEC_HASH);
    }

    function testDeliverableHashSetOnce() public {
        _fund();
        _submitDeliverable();
        assertEq(escrow.deliverableHash(), keccak256("deliverable: flyer png"));
        vm.prank(boss);
        vm.expectRevert("JobEscrow: deliverable sealed");
        vault.submitDeliverable(address(escrow), keccak256("different deliverable"));
    }

    function testDeliverableOnlyViaVault() public {
        _fund();
        vm.prank(boss);
        vm.expectRevert("JobEscrow: only vault");
        escrow.submitDeliverable(keccak256("direct"));
    }

    // ---- cNGN price (a $1 job paid in cNGN) ----

    function testCngnPriceFundsAndAccepts() public {
        // The same MockUSDT stands in for cNGN here (both 6 decimals):
        // the escrow only cares about the token address and the price it
        // was deployed with, never the token's name.
        JobEscrow cngnEscrow = new JobEscrow(customer, address(vault), address(token), 0, CNGN_PRICE, SPEC_HASH);
        vm.prank(boss);
        vault.registerEscrow(address(cngnEscrow));
        assertEq(cngnEscrow.price(), CNGN_PRICE);
        // The customer needs the full cNGN price, not the $1 USDT amount.
        token.mint(customer, CNGN_PRICE);
        vm.prank(customer);
        token.approve(address(cngnEscrow), CNGN_PRICE);
        vm.prank(customer);
        cngnEscrow.fund();
        assertEq(uint256(cngnEscrow.state()), uint256(JobEscrow.State.FUNDED));
        assertEq(token.balanceOf(address(cngnEscrow)), CNGN_PRICE);
        vm.prank(boss);
        vault.submitDeliverable(address(cngnEscrow), keccak256("deliverable: flyer png"));
        uint256 vaultBefore = token.balanceOf(address(vault));
        uint256 operatingBefore = vault.bucketBalance(IkengaVault.Bucket.OPERATING);
        vm.prank(customer);
        cngnEscrow.accept();
        assertEq(uint256(cngnEscrow.state()), uint256(JobEscrow.State.ACCEPTED));
        assertEq(token.balanceOf(address(vault)), vaultBefore + CNGN_PRICE);
        assertEq(vault.bucketBalance(IkengaVault.Bucket.OPERATING), operatingBefore + CNGN_PRICE);
        assertEq(token.balanceOf(address(cngnEscrow)), 0);
    }

    function testCngnPriceRejectRefundsFullPrice() public {
        JobEscrow cngnEscrow = new JobEscrow(customer, address(vault), address(token), 0, CNGN_PRICE, SPEC_HASH);
        vm.prank(boss);
        vault.registerEscrow(address(cngnEscrow));
        token.mint(customer, CNGN_PRICE);
        vm.prank(customer);
        token.approve(address(cngnEscrow), CNGN_PRICE);
        vm.prank(customer);
        cngnEscrow.fund();
        uint256 customerBefore = token.balanceOf(customer);
        vm.prank(customer);
        cngnEscrow.reject();
        assertEq(uint256(cngnEscrow.state()), uint256(JobEscrow.State.REJECTED));
        assertEq(token.balanceOf(customer), customerBefore + CNGN_PRICE);
    }

    function testTwoPricesCoexist() public {
        // A $1 USDT escrow and a cNGN escrow side by side: each holds
        // exactly its own price, and funding one never touches the other.
        JobEscrow cngnEscrow = new JobEscrow(customer, address(vault), address(token), 0, CNGN_PRICE, SPEC_HASH);
        vm.prank(boss);
        vault.registerEscrow(address(cngnEscrow));
        token.mint(customer, CNGN_PRICE);
        vm.prank(customer);
        token.approve(address(cngnEscrow), CNGN_PRICE);
        _fund();
        vm.prank(customer);
        cngnEscrow.fund();
        assertEq(token.balanceOf(address(escrow)), PRICE);
        assertEq(token.balanceOf(address(cngnEscrow)), CNGN_PRICE);
    }

    function testZeroPriceReverts() public {
        vm.expectRevert("JobEscrow: price is zero");
        new JobEscrow(customer, address(vault), address(token), 0, 0, SPEC_HASH);
    }

    // ---- accounting invariant ----

    function testFuzz_BondAmountAccounting(uint256 bondAmount) public {
        bondAmount = bound(bondAmount, 0, 300_000); // 0-30% bond, priceJob range
        JobEscrow e = new JobEscrow(customer, address(vault), address(token), bondAmount, PRICE, SPEC_HASH);
        vm.startPrank(boss);
        vault.registerEscrow(address(e));
        vault.lockBond(address(e), bondAmount);
        vm.stopPrank();
        vm.prank(customer);
        token.approve(address(e), 10_000_000);
        vm.prank(customer);
        e.fund();
        uint256 customerBefore = token.balanceOf(customer);
        vm.prank(customer);
        e.reject();
        // Customer gets the price back plus exactly the bond for this escrow.
        assertEq(token.balanceOf(customer), customerBefore + 1_000_000 + bondAmount);
        assertEq(token.balanceOf(address(e)), 0);
    }
}
