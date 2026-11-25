import { GET as auditSummary } from "../cfo/route";
/**
 * GET /api/traction counts real jobs only, while the decision log stays
 * complete. Seeded with the four live orders as they actually stand:
 * three test runs and Amaka's real job — plus a future Sepolia job that
 * was funded on testnet and a future mainnet job that was funded for real.
 */
import { describe, expect, it } from "vitest";
import { MemoryLedger } from "@ikenga/ledger";
import { setLedgerForTests } from "@/lib/jobs";
import { GET } from "./route.js";

const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const VAULT = "0x1C2b2E64527B0bA7795ed3CDF7d76da51D24018B";
const SEPOLIA_USDC = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";
const SEPOLIA_VAULT = "0x1A6d11A97e83f563bdA7811413097212362e0EcD";
const DUMMY_WALLET = "0x0000000000000000000000000000000000000001";
const SEPOLIA_WALLET = "0x94CcF19e6e12B64272D3b4946Dc34a9Ae9B74C50";
const AMAKA = "0xcc4BCDD595Ee20cFB8A214Dc570eCB3Fb1C1d3A1";

async function seed() {
  const ledger = new MemoryLedger();
  setLedgerForTests(ledger);
  const orders = [
    // OpenAI key test — delivered, never funded, dummy wallet.
    { id: "ord_mwsc5dbd_7d9s76", jobType: "market-report", customerWallet: DUMMY_WALLET, description: "test", status: "delivered", tokenAddress: null, vaultAddress: null },
    // Sepolia end-to-end — accepted on testnet, test wallet, no funding recorded on the live row.
    { id: "ord_mwssqak9_tsinmi", jobType: "market-report", customerWallet: SEPOLIA_WALLET, description: "test", status: "accepted", tokenAddress: null, vaultAddress: null },
    // Speed-fix test — delivered, never funded, dummy wallet.
    { id: "ord_mwsufnqe_urs8v7", jobType: "market-report", customerWallet: DUMMY_WALLET, description: "test", status: "delivered", tokenAddress: null, vaultAddress: null },
    // Amaka — the real job: mainnet, funded escrow, accepted.
    {
      id: "ord_mwt6lzin_6ou3oj", jobType: "market-report", customerWallet: AMAKA, description: "real",
      status: "accepted", tokenAddress: null, vaultAddress: null,
      escrowAddress: "0x9c2ca8e46e44017226393b2d20ce69ef0234448e",
      fundTxHash: "0x48c02989f12d6bd82f76e5f5a1caa3a7e3fec16a9d67f3c6ad53dc297f7c0d6f",
      settleTxHash: "0x3f4551a248970d882a3a569ca98bfc379dc44d030debbfec85fdc28273d08a22",
    },
    // A future Sepolia job that DID fund its escrow on testnet.
    {
      id: "ord_sepolia_next", jobType: "flyers", customerWallet: "0x2222222222222222222222222222222222222222", description: "test",
      status: "accepted", tokenAddress: SEPOLIA_USDC, vaultAddress: SEPOLIA_VAULT,
      escrowAddress: "0x00000000000000000000000000000000000000aa",
      fundTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      settleTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab",
    },
    // A future mainnet job funded for real.
    {
      id: "ord_real_next", jobType: "flyers", customerWallet: "0x3333333333333333333333333333333333333333", description: "real",
      status: "accepted", tokenAddress: USDT, vaultAddress: VAULT,
      escrowAddress: "0x00000000000000000000000000000000000000bb",
      fundTxHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      settleTxHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccd",
    },
  ];
  for (const o of orders) {
    await ledger.createOrder(o);
    await ledger.appendDecision({
      id: `dec_${o.id}`,
      orderId: o.id,
      kind: "quote",
      reason: "test decision",
      amountMicroUsdc: 1_000_000,
      signature: "0xikenga-step2",
      entry: `quote|USDT|test|1000000`,
    });
  }
  return ledger;
}

describe("GET /api/traction — public customer totals", () => {
  it("counts real jobs and customers without publishing operational diagnostics", async () => {
    await seed();
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.jobsStarted).toBe(2);
    expect(body.customers).toBe(2);
    expect(Object.keys(body).sort()).toEqual(["customers", "jobsStarted"]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const audit = await (await auditSummary()).json();
    expect(audit.verify).toEqual({ok:true});
    expect(audit.summary.jobs).toBe(2);
    expect(JSON.stringify(audit)).not.toMatch(/backend|mode|ordersChecked|excludedTestJobs|firstDoneJobId|reason|orderId|entries/);
  });
});
