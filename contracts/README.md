# contracts/ — Ikenga on-chain pieces (Step 2: real logic)

- `src/JobEscrow.sol` — fixed-price ($1) escrow for one job, in USDT.
- `src/IkengaVault.sol` — CFO treasury with operating/tools/bond/reserve buckets.
- `src/` has no external dependencies (minimal ERC-20 interface inlined).
- `test/` — Foundry tests + a 6-decimal mock USDT (`MockUSDT.sol`).

Both contracts are **real logic in Step 2, but NOT audited and NOT deployed**.
Do not send funds to any contract built from these files until the Sepolia
end-to-end job passes and the user approves a mainnet deploy.

## What the contracts do

**JobEscrow** (`PRICE = 1_000_000`, exactly 1 USDT, 6 decimals; token
address passed in the constructor, never hardcoded):

- `fund()` — customer only; pulls exactly `PRICE` via `transferFrom`
  (customer approves first). Any other amount fails.
- `submitDeliverable(hash)` — only via the vault (CFO path); set once,
  never changeable. `specHash` is set in the constructor and immutable.
- `accept()` — customer only, requires a sealed deliverable; releases
  `PRICE` to the vault and unlocks the bond.
- `reject()` — customer only; refunds `PRICE` and the vault pays the locked
  bond (default 0.20 USDT in the deploy script) to the customer.
- `deadlineRelease()` — anyone, after 48h of silence; releases `PRICE` to
  the vault and unlocks the bond.

**IkengaVault** (Boss = human CFO wallet; token address in constructor):

- Buckets `OPERATING / TOOLS / BOND / RESERVE`; `move()` capped at
  `MAX_MOVE = 5 USDT` per call, Boss only.
- Agents keyed by ERC-8004 `agentId`: `hire` / `fire`, `setAllowance`,
  `topUp(agentId, amount)` pays a hired agent from TOOLS within its
  allowance and within the weekly epoch budget (`WEEKLY_TOOL_BUDGET =
  30 USDT`, `openEpoch` / `closeEpoch`, 7-day epochs).
- Bonds: `lockBond` / `releaseBond` / `payBond` (only the registered escrow
  can trigger a bond payment, to that escrow's customer).
- Above-maxMove moves: `propose` + `coSign` (Boss only). Propose alone
  moves nothing.
- **Safety rule: the vault never sends funds to an arbitrary address.**
  Funds leave only to a registered escrow, a hired agent within allowance,
  or the Boss. There is no generic withdraw function.
- Invariant: vault token balance == sum of buckets (fuzz + invariant
  tested); bond outstanding never exceeds the BOND bucket.

## Setup

Foundry 1.10.0 is expected at `~/.foundry/bin`
(`export PATH="$HOME/.foundry/bin:$PATH"`). `forge-std` lives in `lib/`
(cloned, gitignored — see `.gitignore`).

```sh
forge build
forge test   # 48 tests pass (27 vault + 20 escrow + 1 invariant suite)
```

## Deploy (Sepolia first)

No private key is stored anywhere in this repo. Keys come from env only,
passed on the command line, never written to a file.

```sh
export PATH="$HOME/.foundry/bin:$PATH"
# Sepolia: USDT_TOKEN must be a Sepolia test token - mainnet USDT does NOT
# exist on Sepolia. IKENGA_BOSS / IKENGA_CUSTOMER default to the deployer.
forge script script/Deploy.s.sol \
  --rpc-url celo_sepolia --broadcast --private-key $PRIVATE_KEY \
  --verify --etherscan-api-key $CELOSCAN_API_KEY
# Mainnet (only after Sepolia passes + user approval):
#   USDT_TOKEN=0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e forge script script/Deploy.s.sol \
#     --rpc-url celo --broadcast --private-key $PRIVATE_KEY \
#     --verify --etherscan-api-key $CELOSCAN_API_KEY
```

Deploying pays gas in CELO. Record the deployed addresses + tx hashes in
`deployments/celo.json` (mainnet) or a new `deployments/celo-sepolia.json`.

Verify an already-deployed contract:

```sh
forge verify-contract --chain-id 42220 <address> src/IkengaVault.sol:IkengaVault \
  --etherscan-api-key $CELOSCAN_API_KEY --watch
```

## ERC-8004 registration

`script/RegisterAgent.s.sol` calls `register(agentURI, [])` on the
IdentityRegistry (mainnet `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`,
Sepolia `0x8004A818BFB912233c491871b3d84c89A494BD9e`) and prints the new
`agentId`. Mint first with an empty-registrations file, patch the returned
`agentId` into the file, then re-run with `IKENGA_AGENT_ID=<id>` to
`setAgentURI` if the URI changes. Never re-register — `register()` always
mints a new id.

```sh
IKENGA_AGENT_URI=https://<host>/.well-known/agent-registration.json \
forge script script/RegisterAgent.s.sol \
  --rpc-url celo_sepolia --broadcast --private-key $PRIVATE_KEY
# Mainnet needs IKENGA_NETWORK=mainnet IKENGA_ALLOW_MAINNET=true, and the
# user's explicit approval. It has NOT been run.
```

## Deployed addresses

None yet. See `deployments/celo.json` (`NOT_DEPLOYED`).

## Known limits

- Unaudited; small amounts only, on-chain limits + human Boss co-sign
  above `maxMove` are the safety case (see `docs/step2-plan.md` §6).
- `WEEKLY_TOOL_BUDGET` (30 USDT) is the plan's example number, not yet
  confirmed with the user.
- Sepolia has no official USDT and no Textile FX corridor; the Sepolia
  deploy uses a test token for the escrow/vault flow only.
