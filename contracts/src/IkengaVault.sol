// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IkengaVault - treasury for the Ikenga CFO.
/// @notice Step 2 real logic. NOT audited, NOT deployed.
/// Buckets: OPERATING / TOOLS / BOND / RESERVE. All money movement is
/// bounded on-chain: moves are capped by maxMove, agent top-ups are capped
/// by per-agent allowance (keyed by ERC-8004 agentId) and by a weekly tool
/// budget, and anything above maxMove needs a human Boss co-sign.
/// SAFETY RULE: the vault NEVER sends funds to an arbitrary address.
/// Funds leave only to (a) a registered JobEscrow (release / bond),
/// (b) a hired agent wallet, within its allowance, or (c) the Boss.
/// There is no generic withdraw / transfer-to-address function.
/// Celo: working stable is USDT (6 decimals), token address passed in the
/// constructor - never hardcoded, so Sepolia can use a test token.
interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IJobEscrowMinimal {
    function submitDeliverable(bytes32 deliverableHash) external;
}

contract IkengaVault {
    enum Bucket { OPERATING, TOOLS, BOND, RESERVE }

    address public boss;
    address public immutable token;

    /// @notice Max moved by one `move` call: 5 USDT (5_000_000, 6 dp).
    uint256 public constant MAX_MOVE = 5_000_000;
    /// @notice Weekly tool budget per epoch: 30 USDT. Plan section 2.4
    /// names 30 USDC-equivalent as an example to confirm with the user;
    /// this constant is that number, in USDT atomic units.
    uint256 public constant WEEKLY_TOOL_BUDGET = 30_000_000;
    uint256 public constant EPOCH_LENGTH = 7 days;

    mapping(Bucket => uint256) public bucketBalance;
    mapping(uint256 => uint256) public agentAllowance; // ERC-8004 agentId => micro-USDT
    mapping(uint256 => address) public agentWallet; // ERC-8004 agentId => agent wallet
    mapping(address => bool) public isAgentWallet;
    mapping(address => bool) public registeredEscrow;
    mapping(address => uint256) public lockedBond; // escrow => locked bond
    uint256 public totalLockedBond;

    uint256 public currentEpoch;
    uint256 public epochStart;
    uint256 public epochToolsSpent;

    struct Proposal {
        address to;
        uint256 amount;
        Bucket from;
        address proposer;
        bool executed;
    }
    Proposal[] public proposals;

    event Deposit(address indexed from, uint256 amount);
    event Move(Bucket indexed from, Bucket indexed to, uint256 amount);
    event AllowanceSet(uint256 indexed agentId, uint256 amount);
    event AgentHired(uint256 indexed agentId, address indexed wallet);
    event AgentFired(uint256 indexed agentId);
    event TopUp(uint256 indexed agentId, address indexed wallet, uint256 amount);
    event EscrowRegistered(address indexed escrow);
    event EscrowReleaseCredited(address indexed escrow, uint256 amount);
    event BondLocked(address indexed escrow, uint256 amount);
    event BondReleased(address indexed escrow, uint256 amount);
    event BondPaid(address indexed escrow, address indexed to, uint256 amount);
    event EpochOpened(uint256 indexed epochId, uint256 start);
    event EpochClosed(uint256 indexed epochId, uint256 toolsSpent);
    event Proposed(uint256 indexed proposalId, address indexed to, uint256 amount, Bucket from);
    event CoSigned(uint256 indexed proposalId, address indexed to, uint256 amount);
    event DeliverableSubmitted(address indexed escrow, bytes32 deliverableHash);

    modifier onlyBoss() {
        require(msg.sender == boss, "IkengaVault: only boss");
        _;
    }

    modifier onlyEscrow() {
        require(registeredEscrow[msg.sender], "IkengaVault: only escrow");
        _;
    }

    constructor(address _boss, address _token) {
        require(_boss != address(0), "IkengaVault: boss is zero");
        require(_token != address(0), "IkengaVault: token is zero");
        boss = _boss;
        token = _token;
    }

    /// @notice Sum of all buckets. Invariant: token balance == totalBuckets().
    function totalBuckets() public view returns (uint256 total) {
        total = bucketBalance[Bucket.OPERATING]
            + bucketBalance[Bucket.TOOLS]
            + bucketBalance[Bucket.BOND]
            + bucketBalance[Bucket.RESERVE];
    }

    /// @notice Fund the vault. Pulls `amount` USDT from the caller into OPERATING.
    function deposit(uint256 amount) external {
        require(amount > 0, "IkengaVault: zero amount");
        // Effects before the external call; a failed transfer reverts all.
        bucketBalance[Bucket.OPERATING] += amount;
        require(IERC20Minimal(token).transferFrom(msg.sender, address(this), amount), "IkengaVault: deposit failed");
        emit Deposit(msg.sender, amount);
    }

    /// @notice Move funds between buckets, capped at MAX_MOVE per call.
    function move(Bucket from, Bucket to, uint256 amount) external onlyBoss {
        require(from != to, "IkengaVault: same bucket");
        require(amount <= MAX_MOVE, "IkengaVault: above maxMove");
        require(bucketBalance[from] >= amount, "IkengaVault: insufficient bucket");
        bucketBalance[from] -= amount;
        bucketBalance[to] += amount;
        emit Move(from, to, amount);
    }

    // ---- agents (ERC-8004 agentId keyed) ----

    function hire(uint256 agentId, address wallet) external onlyBoss {
        require(wallet != address(0), "IkengaVault: wallet is zero");
        agentWallet[agentId] = wallet;
        isAgentWallet[wallet] = true;
        emit AgentHired(agentId, wallet);
    }

    function fire(uint256 agentId) external onlyBoss {
        address wallet = agentWallet[agentId];
        if (wallet != address(0)) isAgentWallet[wallet] = false;
        agentWallet[agentId] = address(0);
        agentAllowance[agentId] = 0;
        emit AgentFired(agentId);
    }

    function setAllowance(uint256 agentId, uint256 amount) external onlyBoss {
        agentAllowance[agentId] = amount;
        emit AllowanceSet(agentId, amount);
    }

    /// @notice Pay a hired agent from the TOOLS bucket, within its allowance
    /// and within the weekly epoch tool budget. Only the Boss triggers it.
    function topUp(uint256 agentId, uint256 amount) external onlyBoss {
        address wallet = agentWallet[agentId];
        require(wallet != address(0), "IkengaVault: unknown agent");
        require(amount <= agentAllowance[agentId], "IkengaVault: above allowance");
        require(bucketBalance[Bucket.TOOLS] >= amount, "IkengaVault: insufficient bucket");
        require(epochToolsSpent + amount <= WEEKLY_TOOL_BUDGET, "IkengaVault: weekly budget exceeded");
        agentAllowance[agentId] -= amount;
        bucketBalance[Bucket.TOOLS] -= amount;
        epochToolsSpent += amount;
        require(IERC20Minimal(token).transfer(wallet, amount), "IkengaVault: topUp failed");
        emit TopUp(agentId, wallet, amount);
    }

    // ---- escrows ----

    function registerEscrow(address escrow) external onlyBoss {
        require(escrow != address(0), "IkengaVault: escrow is zero");
        registeredEscrow[escrow] = true;
        emit EscrowRegistered(escrow);
    }

    /// @notice Called by a registered escrow after it transferred PRICE to
    /// this vault (accept / deadline release). Credits OPERATING.
    function creditEscrowRelease(uint256 amount) external onlyEscrow {
        bucketBalance[Bucket.OPERATING] += amount;
        require(
            IERC20Minimal(token).balanceOf(address(this)) >= totalBuckets(),
            "IkengaVault: balance below buckets"
        );
        emit EscrowReleaseCredited(msg.sender, amount);
    }

    /// @notice Forward a deliverable hash to a registered escrow (CFO path:
    /// the agent's work is submitted through the vault, never directly).
    function submitDeliverable(address escrow, bytes32 deliverableHash) external onlyBoss {
        require(registeredEscrow[escrow], "IkengaVault: unknown escrow");
        IJobEscrowMinimal(escrow).submitDeliverable(deliverableHash);
        emit DeliverableSubmitted(escrow, deliverableHash);
    }

    // ---- bonds ----

    /// @notice Lock `amount` of the BOND bucket against one escrow.
    function lockBond(address escrow, uint256 amount) external onlyBoss {
        require(registeredEscrow[escrow], "IkengaVault: unknown escrow");
        require(
            totalLockedBond + amount <= bucketBalance[Bucket.BOND],
            "IkengaVault: bond cover exceeded"
        );
        lockedBond[escrow] += amount;
        totalLockedBond += amount;
        emit BondLocked(escrow, amount);
    }

    /// @notice Unlock an escrow's bond (accept / deadline release).
    /// Callable by the Boss or by the escrow itself.
    function releaseBond(address escrow) external {
        require(
            msg.sender == boss || msg.sender == escrow,
            "IkengaVault: only boss or escrow"
        );
        uint256 amount = lockedBond[escrow];
        lockedBond[escrow] = 0;
        totalLockedBond -= amount;
        emit BondReleased(escrow, amount);
    }

    /// @notice Pay an escrow's locked bond to its customer (reject path).
    /// Only the escrow itself may call this; `to` is that escrow's customer.
    function payBond(address escrow, address to) external onlyEscrow {
        require(msg.sender == escrow, "IkengaVault: only escrow");
        require(to != address(0), "IkengaVault: recipient is zero");
        uint256 amount = lockedBond[escrow];
        require(amount > 0, "IkengaVault: no bond locked");
        require(bucketBalance[Bucket.BOND] >= amount, "IkengaVault: insufficient bucket");
        lockedBond[escrow] = 0;
        totalLockedBond -= amount;
        bucketBalance[Bucket.BOND] -= amount;
        require(IERC20Minimal(token).transfer(to, amount), "IkengaVault: payBond failed");
        emit BondPaid(escrow, to, amount);
    }

    // ---- epochs ----

    function openEpoch() external onlyBoss {
        currentEpoch += 1;
        epochStart = block.timestamp;
        epochToolsSpent = 0;
        emit EpochOpened(currentEpoch, epochStart);
    }

    function closeEpoch() external onlyBoss {
        require(epochStart != 0, "IkengaVault: no open epoch");
        emit EpochClosed(currentEpoch, epochToolsSpent);
        epochStart = 0;
    }

    // ---- propose / coSign (above-maxMove moves) ----

    /// @notice Propose a transfer above maxMove. Moves nothing by itself.
    /// The recipient must be the Boss, a hired agent wallet, or a
    /// registered escrow - never an arbitrary address.
    function propose(address to, uint256 amount, Bucket from) external onlyBoss returns (uint256) {
        require(
            to == boss || isAgentWallet[to] || registeredEscrow[to],
            "IkengaVault: recipient not allowed"
        );
        require(bucketBalance[from] >= amount, "IkengaVault: insufficient bucket");
        proposals.push(Proposal({to: to, amount: amount, from: from, proposer: msg.sender, executed: false}));
        uint256 id = proposals.length - 1;
        emit Proposed(id, to, amount, from);
        return id;
    }

    function proposalExecuted(uint256 id) external view returns (bool) {
        return proposals[id].executed;
    }

    function proposalCount() external view returns (uint256) {
        return proposals.length;
    }

    /// @notice The human Boss co-signs and executes a proposal.
    function coSign(uint256 proposalId) external onlyBoss {
        Proposal storage p = proposals[proposalId];
        require(!p.executed, "IkengaVault: already executed");
        require(bucketBalance[p.from] >= p.amount, "IkengaVault: insufficient bucket");
        p.executed = true;
        bucketBalance[p.from] -= p.amount;
        require(IERC20Minimal(token).transfer(p.to, p.amount), "IkengaVault: coSign failed");
        emit CoSigned(proposalId, p.to, p.amount);
    }
}
