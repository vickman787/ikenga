// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title JobEscrow - fixed-price escrow for one $1 job.
/// @notice Step 2 real logic. NOT audited, NOT deployed.
/// Customer pays exactly 1 USDT (PRICE = 1_000_000, 6 decimals) into escrow.
/// accept() releases PRICE to the IkengaVault; reject() refunds PRICE plus
/// the CFO bond locked in the vault; 48h of silence lets anyone trigger
/// deadlineRelease(), which releases PRICE to the vault.
/// The token address is passed in the constructor - never hardcoded - so
/// Sepolia can use a test token instead of the Celo mainnet USDT address.
/// The naira leg converts USDT<->cNGN on Textile FX off-contract.
interface IERC20MinimalEscrow {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IVaultMinimal {
    function creditEscrowRelease(uint256 amount) external;
    function releaseBond(address escrow) external;
    function payBond(address escrow, address to) external;
}

contract JobEscrow {
    enum State { UNFUNDED, FUNDED, ACCEPTED, REJECTED, RELEASED }

    address public customer;
    address public immutable ikengaVault;
    address public immutable token;
    uint256 public constant PRICE = 1_000_000; // 1 USDT, 6 decimals
    uint256 public constant DEADLINE = 48 hours;
    uint256 public immutable bondAmount;
    bytes32 public immutable specHash;
    bytes32 public deliverableHash;
    uint256 public fundedAt;
    State public state;

    event Funded(address indexed customer, uint256 amount, uint256 fundedAt);
    event DeliverableSubmitted(bytes32 indexed deliverableHash);
    event Accepted(address indexed customer, uint256 amount);
    event Rejected(address indexed customer, uint256 price, uint256 bond);
    event DeadlineReleased(uint256 amount, uint256 releasedAt);

    modifier onlyCustomer() {
        require(msg.sender == customer, "JobEscrow: only customer");
        _;
    }

    modifier onlyVault() {
        require(msg.sender == ikengaVault, "JobEscrow: only vault");
        _;
    }

    constructor(
        address _customer,
        address _vault,
        address _token,
        uint256 _bondAmount,
        bytes32 _specHash
    ) {
        require(_customer != address(0), "JobEscrow: customer is zero");
        require(_vault != address(0), "JobEscrow: vault is zero");
        require(_token != address(0), "JobEscrow: token is zero");
        customer = _customer;
        ikengaVault = _vault;
        token = _token;
        bondAmount = _bondAmount;
        specHash = _specHash;
        state = State.UNFUNDED;
    }

    /// @notice Customer funds the escrow with exactly PRICE USDT.
    /// The token is pulled via transferFrom, so the customer must approve
    /// the escrow first. Any other amount fails (allowance or balance).
    function fund() external onlyCustomer {
        require(state == State.UNFUNDED, "JobEscrow: not unfunded");
        // Effects before the external call: a re-entrant fund() hits the
        // state check above and reverts.
        fundedAt = block.timestamp;
        state = State.FUNDED;
        require(
            IERC20MinimalEscrow(token).transferFrom(msg.sender, address(this), PRICE),
            "JobEscrow: fund failed"
        );
        emit Funded(msg.sender, PRICE, fundedAt);
    }

    /// @notice Seal the deliverable hash. Callable once, only via the vault
    /// (the CFO path). After this it can never be changed.
    function submitDeliverable(bytes32 _deliverableHash) external onlyVault {
        require(state == State.FUNDED, "JobEscrow: not funded");
        require(deliverableHash == bytes32(0), "JobEscrow: deliverable sealed");
        require(_deliverableHash != bytes32(0), "JobEscrow: empty hash");
        deliverableHash = _deliverableHash;
        emit DeliverableSubmitted(_deliverableHash);
    }

    /// @notice Customer accepts the delivered work: PRICE goes to the vault
    /// and the locked bond is released back to the vault's BOND bucket.
    function accept() external onlyCustomer {
        require(state == State.FUNDED, "JobEscrow: not funded");
        require(deliverableHash != bytes32(0), "JobEscrow: no deliverable");
        state = State.ACCEPTED;
        require(
            IERC20MinimalEscrow(token).transfer(ikengaVault, PRICE),
            "JobEscrow: release failed"
        );
        IVaultMinimal(ikengaVault).creditEscrowRelease(PRICE);
        IVaultMinimal(ikengaVault).releaseBond(address(this));
        emit Accepted(msg.sender, PRICE);
    }

    /// @notice Customer rejects the work: PRICE is refunded and the vault
    /// pays the locked bond to the customer as well.
    function reject() external onlyCustomer {
        require(state == State.FUNDED, "JobEscrow: not funded");
        state = State.REJECTED;
        require(
            IERC20MinimalEscrow(token).transfer(customer, PRICE),
            "JobEscrow: refund failed"
        );
        if (bondAmount > 0) {
            IVaultMinimal(ikengaVault).payBond(address(this), customer);
        }
        emit Rejected(msg.sender, PRICE, bondAmount);
    }

    /// @notice After 48h of silence anyone may release PRICE to the vault.
    /// The bond lock is released with it.
    function deadlineRelease() external {
        require(state == State.FUNDED, "JobEscrow: not funded");
        require(block.timestamp >= fundedAt + DEADLINE, "JobEscrow: deadline not reached");
        state = State.RELEASED;
        require(
            IERC20MinimalEscrow(token).transfer(ikengaVault, PRICE),
            "JobEscrow: release failed"
        );
        IVaultMinimal(ikengaVault).creditEscrowRelease(PRICE);
        IVaultMinimal(ikengaVault).releaseBond(address(this));
        emit DeadlineReleased(PRICE, block.timestamp);
    }
}
