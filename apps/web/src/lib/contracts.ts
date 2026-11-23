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
 * bond would make the $1 refund impossible. The refund is $1 only.
 *
 * Gas is paid in CELO by the customer: about 0.35 CELO at 200 gwei for
 * deploy + approve + fund. The $1 itself is USDT (mainnet) or test USDC
 * (Sepolia), 1_000_000 atomic units, 6 decimals.
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
import { appendAttribution, isAttributionTag } from "@ikenga/payments";

export type { Address, Chain, Hex } from "viem";

/** Exactly $1 in the token's smallest units (6 decimals). */
export const PRICE_ATOMIC = 1_000_000n;
/** Per-job escrows always use a bond of 0 — see the note above. */
export const BOND_ATOMIC = 0n;

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
  "constructor(address customer, address vault, address token, uint256 bondAmount, bytes32 specHash)",
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

/** ERC20: only what the $1 payment needs. */
export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
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
export const JOB_ESCROW_BYTECODE: Hex = "0x61010060405234801562000011575f80fd5b5060405162001fa038038062001fa083398181016040528101906200003791906200034d565b5f73ffffffffffffffffffffffffffffffffffffffff168573ffffffffffffffffffffffffffffffffffffffff1603620000a8576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016200009f906200042f565b60405180910390fd5b5f73ffffffffffffffffffffffffffffffffffffffff168473ffffffffffffffffffffffffffffffffffffffff160362000119576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040162000110906200049d565b60405180910390fd5b5f73ffffffffffffffffffffffffffffffffffffffff168373ffffffffffffffffffffffffffffffffffffffff16036200018a576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040162000181906200050b565b60405180910390fd5b845f806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055508373ffffffffffffffffffffffffffffffffffffffff1660808173ffffffffffffffffffffffffffffffffffffffff16815250508273ffffffffffffffffffffffffffffffffffffffff1660a08173ffffffffffffffffffffffffffffffffffffffff16815250508160c081815250508060e081815250505f60035f6101000a81548160ff021916908360048111156200026857620002676200052b565b5b0217905550505050505062000558565b5f80fd5b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f620002a7826200027c565b9050919050565b620002b9816200029b565b8114620002c4575f80fd5b50565b5f81519050620002d781620002ae565b92915050565b5f819050919050565b620002f181620002dd565b8114620002fc575f80fd5b50565b5f815190506200030f81620002e6565b92915050565b5f819050919050565b620003298162000315565b811462000334575f80fd5b50565b5f8151905062000347816200031e565b92915050565b5f805f805f60a0868803121562000369576200036862000278565b5b5f6200037888828901620002c7565b95505060206200038b88828901620002c7565b94505060406200039e88828901620002c7565b9350506060620003b188828901620002ff565b9250506080620003c48882890162000337565b9150509295509295909350565b5f82825260208201905092915050565b7f4a6f62457363726f773a20637573746f6d6572206973207a65726f00000000005f82015250565b5f62000417601b83620003d1565b91506200042482620003e1565b602082019050919050565b5f6020820190508181035f830152620004488162000409565b9050919050565b7f4a6f62457363726f773a207661756c74206973207a65726f00000000000000005f82015250565b5f62000485601883620003d1565b915062000492826200044f565b602082019050919050565b5f6020820190508181035f830152620004b68162000477565b9050919050565b7f4a6f62457363726f773a20746f6b656e206973207a65726f00000000000000005f82015250565b5f620004f3601883620003d1565b91506200050082620004bd565b602082019050919050565b5f6020820190508181035f8301526200052481620004e5565b9050919050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52602160045260245ffd5b60805160a05160c05160e0516119b2620005ee5f395f6109ed01525f81816108850152818161099001526109c901525f81816103fe0152818161078801528181610b5701528181610f5b01526111a501525f818161043a015281816104fb01528181610584015281816108ac01528181610c8d01528181610f9701528181611058015281816110e101526111c901526119b25ff3fe608060405234801561000f575f80fd5b50600436106100f3575f3560e01c8063a9a748ff11610095578063c19d93fb11610064578063c19d93fb14610203578063fa8d32ce14610221578063fc0c546a1461022b578063ff5bb02214610249576100f3565b8063a9a748ff146101a1578063b60d4288146101bf578063b6ae44a5146101c9578063c14dc7b2146101e5576100f3565b806380f323a7116100d157806380f323a714610129578063839ea776146101475780638d859f3e14610165578063a082c86e14610183576100f3565b80632804b2c0146100f75780632852b71c146101155780634dc415de1461011f575b5f80fd5b6100ff610267565b60405161010c919061122a565b60405180910390f35b61011d61028a565b005b61012761065b565b005b6101316109c7565b60405161013e919061125b565b60405180910390f35b61014f6109eb565b60405161015c919061128c565b60405180910390f35b61016d610a0f565b60405161017a919061125b565b60405180910390f35b61018b610a16565b604051610198919061125b565b60405180910390f35b6101a9610a1d565b6040516101b6919061125b565b60405180910390f35b6101c7610a23565b005b6101e360048036038101906101de91906112d3565b610c8b565b005b6101ed610e4f565b6040516101fa919061128c565b60405180910390f35b61020b610e55565b6040516102189190611371565b60405180910390f35b610229610e67565b005b6102336111a3565b604051610240919061122a565b60405180910390f35b6102516111c7565b60405161025e919061122a565b60405180910390f35b5f8054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b5f8054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614610317576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161030e906113e4565b60405180910390fd5b6001600481111561032b5761032a6112fe565b5b60035f9054906101000a900460ff16600481111561034c5761034b6112fe565b5b1461038c576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016103839061144c565b60405180910390fd5b5f801b600154036103d2576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016103c9906114b4565b60405180910390fd5b600260035f6101000a81548160ff021916908360048111156103f7576103f66112fe565b5b02179055507f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663a9059cbb7f0000000000000000000000000000000000000000000000000000000000000000620f42406040518363ffffffff1660e01b815260040161047a9291906114d2565b6020604051808303815f875af1158015610496573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906104ba919061152e565b6104f9576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016104f0906115a3565b60405180910390fd5b7f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663b02c5276620f42406040518263ffffffff1660e01b8152600401610555919061125b565b5f604051808303815f87803b15801561056c575f80fd5b505af115801561057e573d5f803e3d5ffd5b505050507f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663688f11b5306040518263ffffffff1660e01b81526004016105db919061122a565b5f604051808303815f87803b1580156105f2575f80fd5b505af1158015610604573d5f803e3d5ffd5b505050503373ffffffffffffffffffffffffffffffffffffffff167fba19e87fb846feb0297591bc7d3f55ec0e3b289f88871a2bcfbe84d66fb47d4a620f4240604051610651919061125b565b60405180910390a2565b5f8054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff16146106e8576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016106df906113e4565b60405180910390fd5b600160048111156106fc576106fb6112fe565b5b60035f9054906101000a900460ff16600481111561071d5761071c6112fe565b5b1461075d576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016107549061144c565b60405180910390fd5b6003805f6101000a81548160ff02191690836004811115610781576107806112fe565b5b02179055507f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663a9059cbb5f8054906101000a900473ffffffffffffffffffffffffffffffffffffffff16620f42406040518363ffffffff1660e01b81526004016108039291906114d2565b6020604051808303815f875af115801561081f573d5f803e3d5ffd5b505050506040513d601f19601f82011682018060405250810190610843919061152e565b610882576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016108799061160b565b60405180910390fd5b5f7f00000000000000000000000000000000000000000000000000000000000000001115610952577f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff16634bdee064305f8054906101000a900473ffffffffffffffffffffffffffffffffffffffff166040518363ffffffff1660e01b8152600401610924929190611629565b5f604051808303815f87803b15801561093b575f80fd5b505af115801561094d573d5f803e3d5ffd5b505050505b3373ffffffffffffffffffffffffffffffffffffffff167fc7f4b721ced870d083a147ec74c6b48eb37782a273c7de61eba275a516b0b9fc620f42407f00000000000000000000000000000000000000000000000000000000000000006040516109bd929190611650565b60405180910390a2565b7f000000000000000000000000000000000000000000000000000000000000000081565b7f000000000000000000000000000000000000000000000000000000000000000081565b620f424081565b6202a30081565b60025481565b5f8054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614610ab0576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610aa7906113e4565b60405180910390fd5b5f6004811115610ac357610ac26112fe565b5b60035f9054906101000a900460ff166004811115610ae457610ae36112fe565b5b14610b24576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610b1b906116c1565b60405180910390fd5b42600281905550600160035f6101000a81548160ff02191690836004811115610b5057610b4f6112fe565b5b02179055507f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff166323b872dd3330620f42406040518463ffffffff1660e01b8152600401610bb5939291906116df565b6020604051808303815f875af1158015610bd1573d5f803e3d5ffd5b505050506040513d601f19601f82011682018060405250810190610bf5919061152e565b610c34576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610c2b9061175e565b60405180910390fd5b3373ffffffffffffffffffffffffffffffffffffffff167fcd909ec339185c4598a4096e174308fbdf136d117f230960f873a2f2e81f63af620f4240600254604051610c81929190611650565b60405180910390a2565b7f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614610d19576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610d10906117c6565b60405180910390fd5b60016004811115610d2d57610d2c6112fe565b5b60035f9054906101000a900460ff166004811115610d4e57610d4d6112fe565b5b14610d8e576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610d859061144c565b60405180910390fd5b5f801b60015414610dd4576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610dcb9061182e565b60405180910390fd5b5f801b8103610e18576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610e0f90611896565b60405180910390fd5b80600181905550807f3c0253a98733b2d419d8b7ca578081f570b975aee6249ff767ea1bc4beed8ed360405160405180910390a250565b60015481565b60035f9054906101000a900460ff1681565b60016004811115610e7b57610e7a6112fe565b5b60035f9054906101000a900460ff166004811115610e9c57610e9b6112fe565b5b14610edc576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610ed39061144c565b60405180910390fd5b6202a300600254610eed91906118e1565b421015610f2f576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610f269061195e565b60405180910390fd5b600460035f6101000a81548160ff02191690836004811115610f5457610f536112fe565b5b02179055507f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663a9059cbb7f0000000000000000000000000000000000000000000000000000000000000000620f42406040518363ffffffff1660e01b8152600401610fd79291906114d2565b6020604051808303815f875af1158015610ff3573d5f803e3d5ffd5b505050506040513d601f19601f82011682018060405250810190611017919061152e565b611056576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161104d906115a3565b60405180910390fd5b7f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663b02c5276620f42406040518263ffffffff1660e01b81526004016110b2919061125b565b5f604051808303815f87803b1580156110c9575f80fd5b505af11580156110db573d5f803e3d5ffd5b505050507f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663688f11b5306040518263ffffffff1660e01b8152600401611138919061122a565b5f604051808303815f87803b15801561114f575f80fd5b505af1158015611161573d5f803e3d5ffd5b505050507f247b1a1d89e4e447b53b5bfde6f98cf22bf202b72a6c4016804e6ddc2c684a10620f424042604051611199929190611650565b60405180910390a1565b7f000000000000000000000000000000000000000000000000000000000000000081565b7f000000000000000000000000000000000000000000000000000000000000000081565b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f611214826111eb565b9050919050565b6112248161120a565b82525050565b5f60208201905061123d5f83018461121b565b92915050565b5f819050919050565b61125581611243565b82525050565b5f60208201905061126e5f83018461124c565b92915050565b5f819050919050565b61128681611274565b82525050565b5f60208201905061129f5f83018461127d565b92915050565b5f80fd5b6112b281611274565b81146112bc575f80fd5b50565b5f813590506112cd816112a9565b92915050565b5f602082840312156112e8576112e76112a5565b5b5f6112f5848285016112bf565b91505092915050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52602160045260245ffd5b6005811061133c5761133b6112fe565b5b50565b5f81905061134c8261132b565b919050565b5f61135b8261133f565b9050919050565b61136b81611351565b82525050565b5f6020820190506113845f830184611362565b92915050565b5f82825260208201905092915050565b7f4a6f62457363726f773a206f6e6c7920637573746f6d657200000000000000005f82015250565b5f6113ce60188361138a565b91506113d98261139a565b602082019050919050565b5f6020820190508181035f8301526113fb816113c2565b9050919050565b7f4a6f62457363726f773a206e6f742066756e64656400000000000000000000005f82015250565b5f61143660158361138a565b915061144182611402565b602082019050919050565b5f6020820190508181035f8301526114638161142a565b9050919050565b7f4a6f62457363726f773a206e6f2064656c6976657261626c65000000000000005f82015250565b5f61149e60198361138a565b91506114a98261146a565b602082019050919050565b5f6020820190508181035f8301526114cb81611492565b9050919050565b5f6040820190506114e55f83018561121b565b6114f2602083018461124c565b9392505050565b5f8115159050919050565b61150d816114f9565b8114611517575f80fd5b50565b5f8151905061152881611504565b92915050565b5f60208284031215611543576115426112a5565b5b5f6115508482850161151a565b91505092915050565b7f4a6f62457363726f773a2072656c65617365206661696c6564000000000000005f82015250565b5f61158d60198361138a565b915061159882611559565b602082019050919050565b5f6020820190508181035f8301526115ba81611581565b9050919050565b7f4a6f62457363726f773a20726566756e64206661696c656400000000000000005f82015250565b5f6115f560188361138a565b9150611600826115c1565b602082019050919050565b5f6020820190508181035f830152611622816115e9565b9050919050565b5f60408201905061163c5f83018561121b565b611649602083018461121b565b9392505050565b5f6040820190506116635f83018561124c565b611670602083018461124c565b9392505050565b7f4a6f62457363726f773a206e6f7420756e66756e6465640000000000000000005f82015250565b5f6116ab60178361138a565b91506116b682611677565b602082019050919050565b5f6020820190508181035f8301526116d88161169f565b9050919050565b5f6060820190506116f25f83018661121b565b6116ff602083018561121b565b61170c604083018461124c565b949350505050565b7f4a6f62457363726f773a2066756e64206661696c6564000000000000000000005f82015250565b5f61174860168361138a565b915061175382611714565b602082019050919050565b5f6020820190508181035f8301526117758161173c565b9050919050565b7f4a6f62457363726f773a206f6e6c79207661756c7400000000000000000000005f82015250565b5f6117b060158361138a565b91506117bb8261177c565b602082019050919050565b5f6020820190508181035f8301526117dd816117a4565b9050919050565b7f4a6f62457363726f773a2064656c6976657261626c65207365616c65640000005f82015250565b5f611818601d8361138a565b9150611823826117e4565b602082019050919050565b5f6020820190508181035f8301526118458161180c565b9050919050565b7f4a6f62457363726f773a20656d707479206861736800000000000000000000005f82015250565b5f61188060158361138a565b915061188b8261184c565b602082019050919050565b5f6020820190508181035f8301526118ad81611874565b9050919050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b5f6118eb82611243565b91506118f683611243565b925082820190508082111561190e5761190d6118b4565b5b92915050565b7f4a6f62457363726f773a20646561646c696e65206e6f742072656163686564005f82015250565b5f611948601f8361138a565b915061195382611914565b602082019050919050565b5f6020820190508181035f8301526119758161193c565b905091905056fea26469706673582212207b80cc88d3296085a89868193f50c3f05322c4aeae2c8c7b28bb6661d3b37e7964736f6c63430008180033";

/** The wallet injected into the page (a browser extension). */
export interface InjectedProvider {
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
 * is the escrow's customer, the vault and token come from /api/chain, the
 * bond is 0, and the job description is sealed in as specHash. Waits for
 * the deploy to be confirmed, then returns the escrow address and the
 * deploy transaction hash.
 */
export async function deployEscrow(args: {
  account: Address;
  chain: ChainConfig;
  description: string;
}): Promise<{ escrowAddress: Address; txHash: Hex }> {
  const { account, chain, description } = args;
  const wallet = walletClientFor(chain.chainId, account);
  const pub = publicClientFor(chain.chainId);
  const specHash = keccak256(toHex(description));
  const data = encodeDeployData({
    abi: jobEscrowAbi,
    bytecode: JOB_ESCROW_BYTECODE,
    args: [account, chain.vaultAddress, chain.tokenAddress, BOND_ATOMIC, specHash],
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
 * Let the escrow take exactly $1, then pay the $1 in. Skips the approval
 * when the escrow can already take $1. Waits for each step to be
 * confirmed. Returns the approval hash (null when no approval was needed)
 * and the funding hash.
 */
export async function approveAndFund(args: {
  account: Address;
  chain: ChainConfig;
  escrowAddress: Address;
  onProgress?: (step: "approving" | "funding") => void;
}): Promise<{ approveTxHash: Hex | null; fundTxHash: Hex }> {
  const { account, chain, escrowAddress, onProgress } = args;
  const wallet = walletClientFor(chain.chainId, account);
  const pub = publicClientFor(chain.chainId);
  const tokenAllowance = await pub.readContract({
    address: chain.tokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account, escrowAddress],
  });
  let approveTxHash: Hex | null = null;
  if (tokenAllowance < PRICE_ATOMIC) {
    onProgress?.("approving");
    approveTxHash = await sendTaggedCall({
      wallet,
      pub,
      chain,
      to: chain.tokenAddress,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [escrowAddress, PRICE_ATOMIC],
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
