import { assertWalletEnabled } from "./previewMode";

/**
 * Browser-side money for Ikenga — plain viem + the wallet already in the
 * browser. No wagmi, no WalletConnect, no QR codes, no Reown, and no wallet
 * kept in localStorage: the customer connects the extension they already
 * use, and every transaction is signed by them, in their browser.
 *
 * Nothing here invents an address. The vault, the token, the chain and the
 * price all come from GET /api/chain, which the server answers for the
 * chain it is running on (Celo mainnet by default, Sepolia when the server
 * runs with IKENGA_CHAIN=sepolia).
 *
 * Each job gets its OWN JobEscrow, deployed from the customer's browser.
 * The escrow's bond is always 0: the vault's BOND bucket holds no USDT, and
 * JobEscrow.reject() with a bond above 0 and no locked bond reverts — so a
 * bond would make the refund impossible. The refund is the job's price only.
 *
 * A job is $1, paid in USDT or in cNGN — the customer's choice, fixed on
 * the job record at hire time. USDT is 1_000_000 atomic units; cNGN is
 * the amount the live rate fixed when the job was hired (about 1,445
 * cNGN), stored on the job so the customer pays exactly that, no
 * surprises. Each currency has its own vault (USDT vault and cNGN vault);
 * the escrow pays into the vault for its own currency. The per-job
 * payment (token, vault, price) travels with the job — deployEscrow and
 * approveAndFund take it as an argument, never from a global.
 *
 * Gas is paid in CELO by the customer: about 0.35 CELO at 200 gwei for
 * deploy + approve + fund. The $1 itself is USDT (mainnet) or test USDC
 * (Sepolia), 1_000_000 atomic units, 6 decimals — or the fixed cNGN
 * amount for a cNGN job, also 6 decimals.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { celo, celoSepolia } from "viem/chains";
import { appendAttribution, isAttributionTag, parseAttribution } from "@ikenga/payments";

export type { Address, Chain, Hex } from "viem";

/** Exactly $1 in the token's smallest units (6 decimals). */
export const PRICE_ATOMIC = 1_000_000n;
/** Per-job escrows always use a bond of 0 — see the note above. */
export const BOND_ATOMIC = 0n;

/** The currencies a $1 job can be paid in. USDT on mainnet, test USDC on Sepolia, cNGN on mainnet. */
export type PayCurrency = "USDT" | "USDC" | "cNGN";

/**
 * One job's payment: which token it pays with, which vault the escrow
 * pays into, and the exact price fixed at hire time. The price is the
 * whole point — for a cNGN job it is the live-rate amount (about
 * 1,445 cNGN), not $1 in USDT units, and the customer pays exactly it.
 */
export interface JobPayment {
  currency: PayCurrency;
  token: Address;
  vault: Address;
  priceAtomic: bigint;
}

/**
 * Build a job's payment from its stored record. The token, vault and
 * price travel with the job — never from a global — so a cNGN job pays
 * cNGN into the cNGN vault at the price fixed when it was hired. Jobs
 * hired before currencies existed have no payment fields; they fall
 * back to the chain's default currency (USDT on mainnet, test USDC on
 * Sepolia) so they can still be paid.
 */
export function jobPaymentFromRecord(
  job: {
    payCurrency?: PayCurrency;
    priceAtomic?: string;
    tokenAddress?: string;
    vaultAddress?: string;
  },
  chain: ChainConfig,
): JobPayment {
  const currency = job.payCurrency ?? chain.tokenSymbol;
  const token = (job.tokenAddress || chain.tokens[currency] || chain.tokenAddress) as Address;
  const vault = (job.vaultAddress || chain.vaults[currency] || chain.vaultAddress) as Address;
  const priceAtomic = job.priceAtomic ? BigInt(job.priceAtomic) : BigInt(chain.priceAtomic);
  return { currency, token, vault, priceAtomic };
}

/** What GET /api/chain answers. Never hardcode these values client-side. */
export interface ChainConfig {
  chainId: number;
  chainName: string;
  vaultAddress: Address;
  tokenAddress: Address;
  tokenSymbol: "USDT" | "USDC";
  priceAtomic: string;
  bondAtomic: string;
  explorerUrl: string;
  /**
   * The ERC-8021 attribution tag for this job's own transactions. Public
   * code, not a secret. Null when the server has none configured — the
   * payment still goes through untagged rather than blocking the job.
   */
  attributionTag: string | null;
  /** The agent wallet — the public address that holds the USDT for naira bills. */
  agentWallet: string;
  /**
   * Which currencies a job can be paid in on this chain, and where each
   * one lives. Mainnet: USDT + cNGN (each with its own vault); Sepolia:
   * test USDC only — there is no cNGN on Sepolia. The single
   * vaultAddress / tokenAddress / priceAtomic above are the default
   * (USDT mainnet, USDC Sepolia) for older callers; a job's own payment
   * comes from its job record, not from these defaults.
   */
  payTokens: PayCurrency[];
  tokens: Partial<Record<PayCurrency, string>>;
  vaults: Partial<Record<PayCurrency, string>>;
}

export type EscrowState =
  | "unfunded"
  | "funded"
  | "accepted"
  | "rejected"
  | "released";

const ESCROW_STATE_NAMES: EscrowState[] = [
  "unfunded",
  "funded",
  "accepted",
  "rejected",
  "released",
];

/** JobEscrow: fund / accept / reject / reads + the Funded event. The
 * constructor entry is what deployContract() needs to encode the
 * deploy args — without it viem throws AbiConstructorNotFoundError
 * before anything is broadcast. */
export const jobEscrowAbi = parseAbi([
  "constructor(address customer, address vault, address token, uint256 bondAmount, uint256 price, bytes32 specHash)",
  "function fund()",
  "function accept()",
  "function reject()",
  "function deadlineRelease()",
  "function submitDeliverable(bytes32 deliverableHash)",
  "function state() view returns (uint8)",
  "function customer() view returns (address)",
  "function token() view returns (address)",
  "function ikengaVault() view returns (address)",
  "function bondAmount() view returns (uint256)",
  "function deliverableHash() view returns (bytes32)",
  "function specHash() view returns (bytes32)",
  "event Funded(address indexed customer, uint256 amount, uint256 fundedAt)",
]);

/** ERC20: only what the $1 payment and the bill funding need. */
export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

/** Vault read: is this escrow one the vault knows about? */
export const vaultAbi = parseAbi([
  "function registeredEscrow(address escrow) view returns (bool)",
]);

/**
 * JobEscrow creation bytecode, copied from the compiled artifact
 * (contracts/out/JobEscrow.sol/JobEscrow.json) by the generator script —
 * never typed out by hand, so it always matches the contract the server
 * verifies against.
 */
export const JOB_ESCROW_BYTECODE: Hex = "0x61012060405234801562000011575f80fd5b50604051620022003803806200220083398181016040528101906200003791906200039c565b5f73ffffffffffffffffffffffffffffffffffffffff168673ffffffffffffffffffffffffffffffffffffffff1603620000a8576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016200009f9062000492565b60405180910390fd5b5f73ffffffffffffffffffffffffffffffffffffffff168573ffffffffffffffffffffffffffffffffffffffff160362000119576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401620001109062000500565b60405180910390fd5b5f73ffffffffffffffffffffffffffffffffffffffff168473ffffffffffffffffffffffffffffffffffffffff16036200018a576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040162000181906200056e565b60405180910390fd5b5f8211620001cf576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401620001c690620005dc565b60405180910390fd5b855f806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055508473ffffffffffffffffffffffffffffffffffffffff1660808173ffffffffffffffffffffffffffffffffffffffff16815250508373ffffffffffffffffffffffffffffffffffffffff1660a08173ffffffffffffffffffffffffffffffffffffffff16815250508260e081815250508160c081815250508061010081815250505f60035f6101000a81548160ff02191690836004811115620002b657620002b5620005fc565b5b021790555050505050505062000629565b5f80fd5b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f620002f682620002cb565b9050919050565b6200030881620002ea565b811462000313575f80fd5b50565b5f815190506200032681620002fd565b92915050565b5f819050919050565b62000340816200032c565b81146200034b575f80fd5b50565b5f815190506200035e8162000335565b92915050565b5f819050919050565b620003788162000364565b811462000383575f80fd5b50565b5f8151905062000396816200036d565b92915050565b5f805f805f8060c08789031215620003b957620003b8620002c7565b5b5f620003c889828a0162000316565b9650506020620003db89828a0162000316565b9550506040620003ee89828a0162000316565b94505060606200040189828a016200034e565b93505060806200041489828a016200034e565b92505060a06200042789828a0162000386565b9150509295509295509295565b5f82825260208201905092915050565b7f4a6f62457363726f773a20637573746f6d6572206973207a65726f00000000005f82015250565b5f6200047a601b8362000434565b9150620004878262000444565b602082019050919050565b5f6020820190508181035f830152620004ab816200046c565b9050919050565b7f4a6f62457363726f773a207661756c74206973207a65726f00000000000000005f82015250565b5f620004e860188362000434565b9150620004f582620004b2565b602082019050919050565b5f6020820190508181035f8301526200051981620004da565b9050919050565b7f4a6f62457363726f773a20746f6b656e206973207a65726f00000000000000005f82015250565b5f6200055660188362000434565b9150620005638262000520565b602082019050919050565b5f6020820190508181035f830152620005878162000548565b9050919050565b7f4a6f62457363726f773a207072696365206973207a65726f00000000000000005f82015250565b5f620005c460188362000434565b9150620005d1826200058e565b602082019050919050565b5f6020820190508181035f830152620005f581620005b6565b9050919050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52602160045260245ffd5b60805160a05160c05160e05161010051611af16200070f5f395f610a7e01525f81816108f901528181610a210152610a5a01525f818161045b015281816105540152818161067c0152818161083b01528181610a0001528181610aa201528181610c4301528181610d39015281816110a00152818161119901526112aa01525f81816103fe015281816107df01528181610c050152818161104301526112e401525f818161043a01528181610518015281816105be0152818161092001528181610d750152818161107f0152818161115d0152818161120301526113080152611af15ff3fe608060405234801561000f575f80fd5b50600436106100f3575f3560e01c8063a9a748ff11610095578063c19d93fb11610064578063c19d93fb14610203578063fa8d32ce14610221578063fc0c546a1461022b578063ff5bb02214610249576100f3565b8063a9a748ff146101a1578063b60d4288146101bf578063b6ae44a5146101c9578063c14dc7b2146101e5576100f3565b806380f323a7116100d157806380f323a714610129578063839ea77614610147578063a035b1fe14610165578063a082c86e14610183576100f3565b80632804b2c0146100f75780632852b71c146101155780634dc415de1461011f575b5f80fd5b6100ff610267565b60405161010c9190611369565b60405180910390f35b61011d61028a565b005b6101276106b2565b005b610131610a58565b60405161013e919061139a565b60405180910390f35b61014f610a7c565b60405161015c91906113cb565b60405180910390f35b61016d610aa0565b60405161017a919061139a565b60405180910390f35b61018b610ac4565b604051610198919061139a565b60405180910390f35b6101a9610acb565b6040516101b6919061139a565b60405180910390f35b6101c7610ad1565b005b6101e360048036038101906101de9190611412565b610d73565b005b6101ed610f37565b6040516101fa91906113cb565b60405180910390f35b61020b610f3d565b60405161021891906114b0565b60405180910390f35b610229610f4f565b005b6102336112e2565b6040516102409190611369565b60405180910390f35b610251611306565b60405161025e9190611369565b60405180910390f35b5f8054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b5f8054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614610317576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161030e90611523565b60405180910390fd5b6001600481111561032b5761032a61143d565b5b60035f9054906101000a900460ff16600481111561034c5761034b61143d565b5b1461038c576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016103839061158b565b60405180910390fd5b5f801b600154036103d2576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016103c9906115f3565b60405180910390fd5b600260035f6101000a81548160ff021916908360048111156103f7576103f661143d565b5b02179055507f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663a9059cbb7f00000000000000000000000000000000000000000000000000000000000000007f00000000000000000000000000000000000000000000000000000000000000006040518363ffffffff1660e01b8152600401610497929190611611565b6020604051808303815f875af11580156104b3573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906104d7919061166d565b610516576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161050d906116e2565b60405180910390fd5b7f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663b02c52767f00000000000000000000000000000000000000000000000000000000000000006040518263ffffffff1660e01b815260040161058f919061139a565b5f604051808303815f87803b1580156105a6575f80fd5b505af11580156105b8573d5f803e3d5ffd5b505050507f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663688f11b5306040518263ffffffff1660e01b81526004016106159190611369565b5f604051808303815f87803b15801561062c575f80fd5b505af115801561063e573d5f803e3d5ffd5b505050503373ffffffffffffffffffffffffffffffffffffffff167fba19e87fb846feb0297591bc7d3f55ec0e3b289f88871a2bcfbe84d66fb47d4a7f00000000000000000000000000000000000000000000000000000000000000006040516106a8919061139a565b60405180910390a2565b5f8054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff161461073f576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161073690611523565b60405180910390fd5b600160048111156107535761075261143d565b5b60035f9054906101000a900460ff1660048111156107745761077361143d565b5b146107b4576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016107ab9061158b565b60405180910390fd5b6003805f6101000a81548160ff021916908360048111156107d8576107d761143d565b5b02179055507f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663a9059cbb5f8054906101000a900473ffffffffffffffffffffffffffffffffffffffff167f00000000000000000000000000000000000000000000000000000000000000006040518363ffffffff1660e01b8152600401610877929190611611565b6020604051808303815f875af1158015610893573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906108b7919061166d565b6108f6576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016108ed9061174a565b60405180910390fd5b5f7f000000000000000000000000000000000000000000000000000000000000000011156109c6577f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff16634bdee064305f8054906101000a900473ffffffffffffffffffffffffffffffffffffffff166040518363ffffffff1660e01b8152600401610998929190611768565b5f604051808303815f87803b1580156109af575f80fd5b505af11580156109c1573d5f803e3d5ffd5b505050505b3373ffffffffffffffffffffffffffffffffffffffff167fc7f4b721ced870d083a147ec74c6b48eb37782a273c7de61eba275a516b0b9fc7f00000000000000000000000000000000000000000000000000000000000000007f0000000000000000000000000000000000000000000000000000000000000000604051610a4e92919061178f565b60405180910390a2565b7f000000000000000000000000000000000000000000000000000000000000000081565b7f000000000000000000000000000000000000000000000000000000000000000081565b7f000000000000000000000000000000000000000000000000000000000000000081565b6202a30081565b60025481565b5f8054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614610b5e576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610b5590611523565b60405180910390fd5b5f6004811115610b7157610b7061143d565b5b60035f9054906101000a900460ff166004811115610b9257610b9161143d565b5b14610bd2576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610bc990611800565b60405180910390fd5b42600281905550600160035f6101000a81548160ff02191690836004811115610bfe57610bfd61143d565b5b02179055507f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff166323b872dd33307f00000000000000000000000000000000000000000000000000000000000000006040518463ffffffff1660e01b8152600401610c809392919061181e565b6020604051808303815f875af1158015610c9c573d5f803e3d5ffd5b505050506040513d601f19601f82011682018060405250810190610cc0919061166d565b610cff576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610cf69061189d565b60405180910390fd5b3373ffffffffffffffffffffffffffffffffffffffff167fcd909ec339185c4598a4096e174308fbdf136d117f230960f873a2f2e81f63af7f0000000000000000000000000000000000000000000000000000000000000000600254604051610d6992919061178f565b60405180910390a2565b7f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614610e01576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610df890611905565b60405180910390fd5b60016004811115610e1557610e1461143d565b5b60035f9054906101000a900460ff166004811115610e3657610e3561143d565b5b14610e76576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610e6d9061158b565b60405180910390fd5b5f801b60015414610ebc576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610eb39061196d565b60405180910390fd5b5f801b8103610f00576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610ef7906119d5565b60405180910390fd5b80600181905550807f3c0253a98733b2d419d8b7ca578081f570b975aee6249ff767ea1bc4beed8ed360405160405180910390a250565b60015481565b60035f9054906101000a900460ff1681565b60016004811115610f6357610f6261143d565b5b60035f9054906101000a900460ff166004811115610f8457610f8361143d565b5b14610fc4576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610fbb9061158b565b60405180910390fd5b6202a300600254610fd59190611a20565b421015611017576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161100e90611a9d565b60405180910390fd5b600460035f6101000a81548160ff0219169083600481111561103c5761103b61143d565b5b02179055507f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663a9059cbb7f00000000000000000000000000000000000000000000000000000000000000007f00000000000000000000000000000000000000000000000000000000000000006040518363ffffffff1660e01b81526004016110dc929190611611565b6020604051808303815f875af11580156110f8573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061111c919061166d565b61115b576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611152906116e2565b60405180910390fd5b7f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663b02c52767f00000000000000000000000000000000000000000000000000000000000000006040518263ffffffff1660e01b81526004016111d4919061139a565b5f604051808303815f87803b1580156111eb575f80fd5b505af11580156111fd573d5f803e3d5ffd5b505050507f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663688f11b5306040518263ffffffff1660e01b815260040161125a9190611369565b5f604051808303815f87803b158015611271575f80fd5b505af1158015611283573d5f803e3d5ffd5b505050507f247b1a1d89e4e447b53b5bfde6f98cf22bf202b72a6c4016804e6ddc2c684a107f0000000000000000000000000000000000000000000000000000000000000000426040516112d892919061178f565b60405180910390a1565b7f000000000000000000000000000000000000000000000000000000000000000081565b7f000000000000000000000000000000000000000000000000000000000000000081565b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f6113538261132a565b9050919050565b61136381611349565b82525050565b5f60208201905061137c5f83018461135a565b92915050565b5f819050919050565b61139481611382565b82525050565b5f6020820190506113ad5f83018461138b565b92915050565b5f819050919050565b6113c5816113b3565b82525050565b5f6020820190506113de5f8301846113bc565b92915050565b5f80fd5b6113f1816113b3565b81146113fb575f80fd5b50565b5f8135905061140c816113e8565b92915050565b5f60208284031215611427576114266113e4565b5b5f611434848285016113fe565b91505092915050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52602160045260245ffd5b6005811061147b5761147a61143d565b5b50565b5f81905061148b8261146a565b919050565b5f61149a8261147e565b9050919050565b6114aa81611490565b82525050565b5f6020820190506114c35f8301846114a1565b92915050565b5f82825260208201905092915050565b7f4a6f62457363726f773a206f6e6c7920637573746f6d657200000000000000005f82015250565b5f61150d6018836114c9565b9150611518826114d9565b602082019050919050565b5f6020820190508181035f83015261153a81611501565b9050919050565b7f4a6f62457363726f773a206e6f742066756e64656400000000000000000000005f82015250565b5f6115756015836114c9565b915061158082611541565b602082019050919050565b5f6020820190508181035f8301526115a281611569565b9050919050565b7f4a6f62457363726f773a206e6f2064656c6976657261626c65000000000000005f82015250565b5f6115dd6019836114c9565b91506115e8826115a9565b602082019050919050565b5f6020820190508181035f83015261160a816115d1565b9050919050565b5f6040820190506116245f83018561135a565b611631602083018461138b565b9392505050565b5f8115159050919050565b61164c81611638565b8114611656575f80fd5b50565b5f8151905061166781611643565b92915050565b5f60208284031215611682576116816113e4565b5b5f61168f84828501611659565b91505092915050565b7f4a6f62457363726f773a2072656c65617365206661696c6564000000000000005f82015250565b5f6116cc6019836114c9565b91506116d782611698565b602082019050919050565b5f6020820190508181035f8301526116f9816116c0565b9050919050565b7f4a6f62457363726f773a20726566756e64206661696c656400000000000000005f82015250565b5f6117346018836114c9565b915061173f82611700565b602082019050919050565b5f6020820190508181035f83015261176181611728565b9050919050565b5f60408201905061177b5f83018561135a565b611788602083018461135a565b9392505050565b5f6040820190506117a25f83018561138b565b6117af602083018461138b565b9392505050565b7f4a6f62457363726f773a206e6f7420756e66756e6465640000000000000000005f82015250565b5f6117ea6017836114c9565b91506117f5826117b6565b602082019050919050565b5f6020820190508181035f830152611817816117de565b9050919050565b5f6060820190506118315f83018661135a565b61183e602083018561135a565b61184b604083018461138b565b949350505050565b7f4a6f62457363726f773a2066756e64206661696c6564000000000000000000005f82015250565b5f6118876016836114c9565b915061189282611853565b602082019050919050565b5f6020820190508181035f8301526118b48161187b565b9050919050565b7f4a6f62457363726f773a206f6e6c79207661756c7400000000000000000000005f82015250565b5f6118ef6015836114c9565b91506118fa826118bb565b602082019050919050565b5f6020820190508181035f83015261191c816118e3565b9050919050565b7f4a6f62457363726f773a2064656c6976657261626c65207365616c65640000005f82015250565b5f611957601d836114c9565b915061196282611923565b602082019050919050565b5f6020820190508181035f8301526119848161194b565b9050919050565b7f4a6f62457363726f773a20656d707479206861736800000000000000000000005f82015250565b5f6119bf6015836114c9565b91506119ca8261198b565b602082019050919050565b5f6020820190508181035f8301526119ec816119b3565b9050919050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b5f611a2a82611382565b9150611a3583611382565b9250828201905080821115611a4d57611a4c6119f3565b5b92915050565b7f4a6f62457363726f773a20646561646c696e65206e6f742072656163686564005f82015250565b5f611a87601f836114c9565b9150611a9282611a53565b602082019050919050565b5f6020820190508181035f830152611ab481611a7b565b905091905056fea2646970667358221220c6e27bead4445fa239cf1318cd1aaf4bbebeb2e2850d196bae80184f911ab9fd64736f6c63430008180033";

/** The wallet injected into the page (a browser extension). */
export interface InjectedProvider {
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: InjectedProvider;
  }
}

function injectedProvider(): InjectedProvider {
  const eth =
    typeof window !== "undefined" ? window.ethereum : undefined;
  if (!eth) {
    throw new Error(
      "No wallet found in this browser. Install a Celo wallet extension, then try again.",
    );
  }
  return eth;
}

/** The viem chain for a chain id Ikenga runs on. */
export function chainForId(chainId: number): Chain {
  if (chainId === celo.id) return celo;
  if (chainId === celoSepolia.id) return celoSepolia;
  throw new Error(
    "Ikenga does not run on that network yet. Switch your wallet to Celo and try again.",
  );
}

/** Load the vault, token, chain and price from the server. */
export async function fetchChainConfig(): Promise<ChainConfig> {
  const res = await fetch("/api/chain");
  const data = (await res.json().catch(() => ({}))) as Partial<ChainConfig> & {
    error?: string;
  };
  if (!res.ok || !data.vaultAddress || !data.tokenAddress || !data.chainId) {
    throw new Error(
      data.error ??
        "Could not load the payment details. Check your connection and try again.",
    );
  }
  return data as ChainConfig;
}

function walletClientFor(chainId: number, account: Address): WalletClient {
  return createWalletClient({
    account,
    chain: chainForId(chainId),
    transport: custom(injectedProvider()),
  });
}

function publicClientFor(chainId: number): PublicClient {
  return createPublicClient({
    chain: chainForId(chainId),
    transport: http(),
  });
}

/**
 * Stick the attribution tag on the end of a transaction's calldata, so
 * the tracker counts the customer's own payment — not just the boss's
 * seal. The EVM ignores the trailing bytes, so the call itself does not
 * change. When the server gave us no tag (or a bad one), the payment
 * still goes through untagged: a missing tag must never block a job.
 */
export function tagCalldata(data: Hex, chain: ChainConfig): Hex {
  const tag = chain.attributionTag;
  if (!tag || !isAttributionTag(tag)) {
    if (typeof console !== "undefined") {
      console.warn(
        "Ikenga: no attribution tag on this transaction — the payment will not be counted as Ikenga work.",
      );
    }
    return data;
  }
  return appendAttribution(data, tag);
}

/**
 * Send one tagged contract call from the customer's wallet and wait for
 * it to be confirmed. `to` is omitted for a contract deployment.
 */
async function sendTaggedCall(args: {
  wallet: WalletClient;
  pub: PublicClient;
  chain: ChainConfig;
  to?: Address;
  data: Hex;
}): Promise<Hex> {
  assertWalletEnabled();
  const { wallet, pub, chain, to, data } = args;
  const txHash = await wallet.sendTransaction({
    account: wallet.account!,
    chain: chainForId(chain.chainId),
    ...(to ? { to } : {}),
    data: tagCalldata(data, chain),
  });
  await pub.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

/**
 * Ask the browser wallet to connect and return the account the customer
 * picked. Throws a plain-words error when there is no wallet, or when the
 * customer says no.
 */
export async function connectInjected(): Promise<Address> {
  assertWalletEnabled();
  const eth = injectedProvider();
  let accounts: unknown;
  try {
    accounts = await eth.request({ method: "eth_requestAccounts" });
  } catch {
    throw new Error(
      "Your wallet did not connect. Open your wallet, connect, and try again.",
    );
  }
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error(
      "No wallet account was shared. Connect your wallet and try again.",
    );
  }
  return getAddress(accounts[0] as string);
}

/**
 * Make sure the wallet is on the chain Ikenga is running on. Throws a
 * plain-words error if the customer refuses the switch, or the wallet
 * stays on the wrong network.
 */
export async function ensureChain(chainId: number): Promise<void> {
  const eth = injectedProvider();
  const current = (await eth.request({ method: "eth_chainId" })) as string;
  if (parseInt(current, 16) === chainId) return;
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${chainId.toString(16)}` }],
    });
  } catch (err) {
    const code = (err as { code?: number } | null)?.code;
    if (code === 4001) {
      throw new Error(
        "You said no to switching networks. Switch your wallet to Celo and try again.",
      );
    }
    throw new Error(
      "Your wallet is on the wrong network. Switch it to Celo and try again.",
    );
  }
}

/**
 * Deploy this job's own escrow from the customer's browser. The customer
 * is the escrow's customer; the vault, token and price come from the
 * job's own payment (not from the chain defaults) — a cNGN job deploys
 * an escrow holding cNGN at its fixed price, into the cNGN vault. The
 * bond is 0, and the job description is sealed in as specHash. Waits for
 * the deploy to be confirmed, then returns the escrow address and the
 * deploy transaction hash.
 */
export async function deployEscrow(args: {
  account: Address;
  chain: ChainConfig;
  payment: JobPayment;
  description: string;
}): Promise<{ escrowAddress: Address; txHash: Hex }> {
  const { account, chain, payment, description } = args;
  const wallet = walletClientFor(chain.chainId, account);
  const pub = publicClientFor(chain.chainId);
  const specHash = keccak256(toHex(description));
  const data = encodeDeployData({
    abi: jobEscrowAbi,
    bytecode: JOB_ESCROW_BYTECODE,
    args: [account, payment.vault, payment.token, BOND_ATOMIC, payment.priceAtomic, specHash],
  });
  const txHash = await sendTaggedCall({ wallet, pub, chain, data });
  const receipt = await pub.getTransactionReceipt({ hash: txHash });
  if (!receipt.contractAddress) {
    throw new Error(
      "The escrow did not deploy. The network fee was spent — please try again.",
    );
  }
  return { escrowAddress: receipt.contractAddress, txHash };
}

/**
 * Let the escrow take the job's price, then pay it in. Skips the approval
 * when the escrow can already take the full price. Waits for each step
 * to be confirmed. Returns the approval hash (null when no approval was
 * needed) and the funding hash.
 */
export async function approveAndFund(args: {
  account: Address;
  chain: ChainConfig;
  payment: JobPayment;
  escrowAddress: Address;
  onProgress?: (step: "approving" | "funding") => void;
}): Promise<{ approveTxHash: Hex | null; fundTxHash: Hex }> {
  const { account, chain, payment, escrowAddress, onProgress } = args;
  const wallet = walletClientFor(chain.chainId, account);
  const pub = publicClientFor(chain.chainId);
  const tokenAllowance = await pub.readContract({
    address: payment.token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account, escrowAddress],
  });
  let approveTxHash: Hex | null = null;
  if (tokenAllowance < payment.priceAtomic) {
    onProgress?.("approving");
    approveTxHash = await sendTaggedCall({
      wallet,
      pub,
      chain,
      to: payment.token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [escrowAddress, payment.priceAtomic],
      }),
    });
  }
  onProgress?.("funding");
  const fundTxHash = await sendTaggedCall({
    wallet,
    pub,
    chain,
    to: escrowAddress,
    data: encodeFunctionData({
      abi: jobEscrowAbi,
      functionName: "fund",
      args: [],
    }),
  });
  return { approveTxHash, fundTxHash };
}

/**
 * Accept the delivered work: the $1 in escrow goes to Ikenga. Only the
 * wallet that paid can do this — the contract itself refuses anyone else.
 */
export async function acceptJob(args: {
  account: Address;
  chain: ChainConfig;
  escrowAddress: Address;
}): Promise<{ txHash: Hex }> {
  const { account, chain, escrowAddress } = args;
  const wallet = walletClientFor(chain.chainId, account);
  const pub = publicClientFor(chain.chainId);
  const txHash = await sendTaggedCall({
    wallet,
    pub,
    chain,
    to: escrowAddress,
    data: encodeFunctionData({
      abi: jobEscrowAbi,
      functionName: "accept",
      args: [],
    }),
  });
  return { txHash };
}

/**
 * Turn the work down: the $1 in escrow comes back to the wallet that
 * paid. Only that wallet can do this — the contract itself refuses
 * anyone else.
 */
export async function rejectJob(args: {
  account: Address;
  chain: ChainConfig;
  escrowAddress: Address;
}): Promise<{ txHash: Hex }> {
  const { account, chain, escrowAddress } = args;
  const wallet = walletClientFor(chain.chainId, account);
  const pub = publicClientFor(chain.chainId);
  const txHash = await sendTaggedCall({
    wallet,
    pub,
    chain,
    to: escrowAddress,
    data: encodeFunctionData({
      abi: jobEscrowAbi,
      functionName: "reject",
      args: [],
    }),
  });
  return { txHash };
}

/**
 * The bill-funding call: a plain USDT transfer from the payer's own
 * wallet to the agent wallet, for exactly the amount the bill needs.
 * Pure — it sends nothing. The tag is added by tagCalldata when the
 * transaction is sent (see fundBillTransfer); stripping it leaves this
 * exact transfer call.
 */
export function fundingTransferCalldata(chain: ChainConfig, amountAtomic: bigint): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [chain.agentWallet as Address, amountAtomic],
  });
}

/**
 * The funding call with Ikenga's tag on it — the byte-level check the
 * funding payment must pass. Returns the tagged calldata and the codes
 * the tag parser reads back, so a test (or a log) can prove the tag is
 * there without sending anything.
 */
export function taggedFundingTransferCalldata(
  chain: ChainConfig,
  amountAtomic: bigint,
): { tagged: Hex; codes: string[] } {
  const data = fundingTransferCalldata(chain, amountAtomic);
  const tagged = tagCalldata(data, chain);
  const parsed = parseAttribution(tagged);
  return { tagged, codes: parsed?.codes ?? [] };
}

/**
 * Pay for a naira bill from the payer's own wallet: one USDT transfer
 * to the agent wallet, tagged so the tracker counts it as Ikenga work,
 * and waited on until it is confirmed. The payer needs USDT in their
 * own Celo wallet plus a little CELO for gas — nothing is taken from
 * anywhere else, and there is no fallback: without their wallet, there
 * is no payment. The transaction hash is what the bill page reports to
 * the server, which checks it onchain before recording the funding.
 */
export async function fundBillTransfer(args: {
  account: Address;
  chain: ChainConfig;
  amountAtomic: bigint;
}): Promise<{ txHash: Hex }> {
  const { account, chain, amountAtomic } = args;
  const wallet = walletClientFor(chain.chainId, account);
  const pub = publicClientFor(chain.chainId);
  const txHash = await sendTaggedCall({
    wallet,
    pub,
    chain,
    to: chain.tokenAddress,
    data: fundingTransferCalldata(chain, amountAtomic),
  });
  return { txHash };
}

/** Read a wallet's balance of one token straight from the chain, so the
 * pay panel can say plainly when the payer is short before they sign.
 * Defaults to the chain's default token; pass the job's token for a
 * cNGN job. */
export async function readTokenBalance(chain: ChainConfig, account: Address, token?: Address): Promise<bigint> {
  const pub = publicClientFor(chain.chainId);
  return pub.readContract({
    address: token ?? chain.tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
}

/** Read an escrow's state straight from the chain. */
export async function readEscrowState(
  chain: ChainConfig,
  escrowAddress: Address,
): Promise<{
  state: EscrowState;
  customer: Address;
  deliverableHash: Hex;
}> {
  const pub = publicClientFor(chain.chainId);
  const [stateNum, customer, deliverableHash] = await Promise.all([
    pub.readContract({
      address: escrowAddress,
      abi: jobEscrowAbi,
      functionName: "state",
    }),
    pub.readContract({
      address: escrowAddress,
      abi: jobEscrowAbi,
      functionName: "customer",
    }),
    pub.readContract({
      address: escrowAddress,
      abi: jobEscrowAbi,
      functionName: "deliverableHash",
    }),
  ]);
  return {
    state: ESCROW_STATE_NAMES[stateNum] ?? "unfunded",
    customer,
    deliverableHash,
  };
}

/** A short, readable form of a wallet or transaction hash. */
export function shortAddress(value: string): string {
  if (value.length <= 13) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** The explorer link for a transaction hash. */
export function explorerTxUrl(chain: ChainConfig, txHash: string): string {
  return `${chain.explorerUrl.replace(/\/$/, "")}/tx/${txHash}`;
}

/** The explorer link for an address. */
export function explorerAddressUrl(chain: ChainConfig, address: string): string {
  return `${chain.explorerUrl.replace(/\/$/, "")}/address/${address}`;
}
