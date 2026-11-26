/**
 * Bills update route: a funding report whose onchain amount differs
 * from the amount the page computed is recorded at its actual onchain
 * amount — the quote moves between sending and reporting, and a payer
 * may round up, so refusing it would strand money already in the
 * agent wallet. On-chain reads are mocked; no live RPC in unit tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryLedger } from "@ikenga/ledger";
import { createBill, recordBillFunding } from "@/lib/bills";
import { getChainConfig, setLedgerForTests } from "@/lib/jobs";
import { POST } from "./route.js";

const { mockVerifyFunding } = vi.hoisted(() => ({
  mockVerifyFunding: vi.fn(),
}));

vi.mock("@ikenga/payments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ikenga/payments")>();
  return {
    ...actual,
    verifyFundingTransfer: mockVerifyFunding,
  };
});

const PAYER = "0x4d28411ed409D3F474F8F62725d8a8D71655261c";
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const HASH_FIRST = `0x${"a".repeat(64)}`;
const HASH_TOPUP = `0x${"b".repeat(64)}`;

const VALID = {
  payerName: "Emeka",
  purpose: "NEPA bill",
  amountNgn: 1500,
  supplierWallet: "0x9a30f8579fcFC81bD93b00E40f39e54d55dFcC46",
  deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  minRate: 1444,
};

async function post(id: string, body: unknown) {
  const res = await POST(
    new Request(`http://localhost/api/bills/${id}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("POST /api/bills/[id]/update — funding", () => {
  beforeEach(() => {
    setLedgerForTests(new MemoryLedger());
    vi.clearAllMocks();
  });

  it("records a top-up at its actual onchain amount when it differs from the reported amount", async () => {
    const agentWallet = getChainConfig().agentWallet;
    const bill = await createBill(VALID);
    await recordBillFunding(bill.id, { txHash: HASH_FIRST, payerWallet: PAYER, amountAtomic: "1041833" });
    // The page computed 507 atomic still needed, but the payer actually sent 15,790.
    mockVerifyFunding.mockResolvedValue({
      ok: false,
      reason: "wrong amount",
      from: PAYER,
      to: USDT,
      recipient: agentWallet,
      amountAtomic: 15790n,
    });
    const { status, body } = await post(bill.id, {
      funding: { txHash: HASH_TOPUP, payerWallet: PAYER, amountAtomic: "507" },
    });
    expect(status).toBe(200);
    const updated = body.bill as { fundingPaidUsdtAtomic: string; fundingTxHashes: string[] };
    expect(updated.fundingPaidUsdtAtomic).toBe("1057623");
    expect(updated.fundingTxHashes).toContain(HASH_TOPUP);
  });

  it("still refuses a transfer that went to the wrong recipient", async () => {
    const bill = await createBill(VALID);
    mockVerifyFunding.mockResolvedValue({
      ok: false,
      reason: "wrong recipient",
      from: PAYER,
      to: USDT,
      recipient: "0x00000000000000000000000000000000000000bb",
      amountAtomic: 15790n,
    });
    const { status, body } = await post(bill.id, {
      funding: { txHash: HASH_TOPUP, payerWallet: PAYER, amountAtomic: "507" },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/didn't go to the agent wallet/);
  });
});
