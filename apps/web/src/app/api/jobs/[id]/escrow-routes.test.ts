/**
 * Escrow route flow, with the on-chain reads mocked — no live RPC in
 * unit tests. Covers: create → escrow → fund → run gate, and the
 * decision route refusing a missing or invalid txHash.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryLedger } from "@ikenga/ledger";
import { createHire, getHire, getLedger, setLedgerForTests } from "@/lib/jobs";
import { POST as postEscrow } from "./escrow/route.js";
import { POST as postFund } from "./fund/route.js";
import { POST as postDecision } from "./decision/route.js";
import { POST as postDeliverable } from "./deliverable/route.js";
import { POST as postRun } from "./run/route.js";

const { mockReadEscrow, mockReadDeliverableHash, mockVerifyReceipt, mockVerifySelf } = vi.hoisted(() => ({
  mockReadEscrow: vi.fn(),
  mockReadDeliverableHash: vi.fn(),
  mockVerifyReceipt: vi.fn(),
  mockVerifySelf: vi.fn(),
}));

vi.mock("@ikenga/payments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ikenga/payments")>();
  return {
    ...actual,
    readEscrowOnchain: mockReadEscrow,
    readEscrowDeliverableHash: mockReadDeliverableHash,
    verifyTxReceipt: mockVerifyReceipt,
    verifySelfAgentId: mockVerifySelf,
  };
});

const CUSTOMER = "0x0000000000000000000000000000000000000002";
const ESCROW = "0x00000000000000000000000000000000000000aa";
const VAULT = "0x1C2b2E64527B0bA7795ed3CDF7d76da51D24018B";
const TOKEN = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const DEPLOY_TX = `0x${"a".repeat(64)}`;
const FUND_TX = `0x${"b".repeat(64)}`;
const ACCEPT_TX = `0x${"c".repeat(64)}`;
const REJECT_TX = `0x${"d".repeat(64)}`;

async function post(
  handler: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>,
  id: string,
  body: unknown,
) {
  const res = await handler(
    new Request(`http://localhost/api/jobs/${id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("escrow → fund → run flow", () => {
  beforeEach(() => {
    setLedgerForTests(new MemoryLedger());
    vi.clearAllMocks();
    process.env.FORTYTWO_API_KEY = "test-key";
    mockReadEscrow.mockResolvedValue({
      exists: true, customer: CUSTOMER, vault: VAULT, token: TOKEN, state: 0, tokenBalance: 0n,
    });
    mockVerifyReceipt.mockResolvedValue({ ok: true, from: CUSTOMER, to: ESCROW });
    mockVerifySelf.mockResolvedValue({
      agentId: "213",
      agentAddress: "0x0000000000000000000000000000000000000000",
      verified: true,
      reason: "VERIFIED",
      checkedAt: new Date().toISOString(),
    });
  });

  it("create → escrow → fund → run: the team only starts once the $1 is in", async () => {
    const hire = await createHire({ jobType: "flyers", description: "Flyers for a market stall", customerWallet: CUSTOMER });
    expect(hire.status).toBe("draft");

    // The team won't start on a draft: no money in yet.
    const tooEarly = await post(postRun, hire.id, {});
    expect(tooEarly.status).toBe(400);
    expect(tooEarly.body.error).toMatch(/Pay the \$1 into escrow first/);

    // Register the escrow (still unfunded onchain).
    const escrowed = await post(postEscrow, hire.id, { escrowAddress: ESCROW, txHash: DEPLOY_TX });
    expect(escrowed.status).toBe(200);
    const afterEscrow = (await getHire(hire.id))!;
    expect(afterEscrow.escrowAddress).toBe(ESCROW);
    expect(afterEscrow.escrowState).toBe("unfunded");
    expect(afterEscrow.status).toBe("draft");

    // Funding while the escrow is still UNFUNDED onchain is refused.
    const notFunded = await post(postFund, hire.id, { txHash: FUND_TX });
    expect(notFunded.status).toBe(400);
    expect(notFunded.body.error).toMatch(/hasn't landed in the escrow yet/);

    // Now the $1 is in: FUNDED, holding exactly 1_000_000 atomic.
    mockReadEscrow.mockResolvedValue({
      exists: true, customer: CUSTOMER, vault: VAULT, token: TOKEN, state: 1, tokenBalance: 1_000_000n,
    });
    const funded = await post(postFund, hire.id, { txHash: FUND_TX });
    expect(funded.status).toBe(200);
    const afterFund = (await getHire(hire.id))!;
    expect(afterFund.status).toBe("escrowed");
    expect(afterFund.fundTxHash).toBe(FUND_TX);
    expect(afterFund.escrowState).toBe("funded");
    const decisions = await (await getLedger()).listDecisions(hire.id);
    expect(decisions.filter((d) => d.kind === "escrow").map((d) => d.txHash)).toContain(FUND_TX);

    // The gate is open now: the run starts.
    const started = await post(postRun, hire.id, {});
    expect(started.status).toBe(202);
    expect((await getHire(hire.id))?.status).toBe("in-progress");
  });

  it("refuses an escrow that belongs to someone else, or isn't a contract", async () => {
    const hire = await createHire({ jobType: "flyers", description: "Flyers", customerWallet: CUSTOMER });
    mockReadEscrow.mockResolvedValue({
      exists: true, customer: "0x0000000000000000000000000000000000000009", vault: VAULT, token: TOKEN, state: 0, tokenBalance: 0n,
    });
    const wrongCustomer = await post(postEscrow, hire.id, { escrowAddress: ESCROW, txHash: DEPLOY_TX });
    expect(wrongCustomer.status).toBe(400);
    expect(wrongCustomer.body.error).toMatch(/different wallet/);
    mockReadEscrow.mockResolvedValue({
      exists: false, customer: null, vault: null, token: null, state: null, tokenBalance: null,
    });
    const noContract = await post(postEscrow, hire.id, { escrowAddress: ESCROW, txHash: DEPLOY_TX });
    expect(noContract.status).toBe(400);
    expect(noContract.body.error).toMatch(/no contract at that address/);
    expect((await getHire(hire.id))?.escrowAddress).toBeNull();
  });

  it("refuses funding when there is no escrow, or the receipt failed", async () => {
    const hire = await createHire({ jobType: "flyers", description: "Flyers", customerWallet: CUSTOMER });
    const noEscrow = await post(postFund, hire.id, { txHash: FUND_TX });
    expect(noEscrow.status).toBe(400);
    expect(noEscrow.body.error).toMatch(/no escrow for this job yet/);
    const ledger = await getLedger();
    await ledger.updateOrderEscrow(hire.id, { escrowAddress: ESCROW });
    mockVerifyReceipt.mockResolvedValue({ ok: false, from: null, to: null });
    const failed = await post(postFund, hire.id, { txHash: FUND_TX });
    expect(failed.status).toBe(400);
    expect(failed.body.error).toMatch(/didn't go through onchain/);
  });
});

describe("decision route", () => {
  beforeEach(() => {
    setLedgerForTests(new MemoryLedger());
    vi.clearAllMocks();
    mockReadEscrow.mockResolvedValue({
      exists: true, customer: CUSTOMER, vault: VAULT, token: TOKEN, state: 2, tokenBalance: 0n,
    });
    mockVerifyReceipt.mockResolvedValue({ ok: true, from: CUSTOMER, to: ESCROW });
  });

  async function seededHire() {
    const hire = await createHire({ jobType: "market-report", description: "Compare payment options", customerWallet: CUSTOMER });
    const ledger = await getLedger();
    await ledger.updateOrderEscrow(hire.id, { escrowAddress: ESCROW, fundTxHash: FUND_TX });
    return hire;
  }

  it("rejects a missing txHash — there is no decision without the money moving", async () => {
    const hire = await seededHire();
    const res = await post(postDecision, hire.id, { action: "accept" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/transaction hash/);
    expect(mockVerifyReceipt).not.toHaveBeenCalled();
    expect((await getHire(hire.id))?.status).toBe("draft");
  });

  it("rejects a txHash whose receipt failed, came from the wrong wallet, or called the wrong contract", async () => {
    const hire = await seededHire();
    mockVerifyReceipt.mockResolvedValue({ ok: false, from: null, to: null });
    expect((await post(postDecision, hire.id, { action: "accept", txHash: ACCEPT_TX })).status).toBe(400);
    mockVerifyReceipt.mockResolvedValue({ ok: true, from: "0x0000000000000000000000000000000000000009", to: ESCROW });
    const wrongSender = await post(postDecision, hire.id, { action: "accept", txHash: ACCEPT_TX });
    expect(wrongSender.status).toBe(400);
    expect(wrongSender.body.error).toMatch(/didn't come from the wallet/);
    mockVerifyReceipt.mockResolvedValue({ ok: true, from: CUSTOMER, to: "0x00000000000000000000000000000000000000bb" });
    const wrongContract = await post(postDecision, hire.id, { action: "accept", txHash: ACCEPT_TX });
    expect(wrongContract.status).toBe(400);
    expect(wrongContract.body.error).toMatch(/didn't call this job's escrow/);
  });

  it("rejects accept when the escrow is not ACCEPTED onchain yet", async () => {
    const hire = await seededHire();
    mockReadEscrow.mockResolvedValue({
      exists: true, customer: CUSTOMER, vault: VAULT, token: TOKEN, state: 1, tokenBalance: 1_000_000n,
    });
    const res = await post(postDecision, hire.id, { action: "accept", txHash: ACCEPT_TX });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hasn't been accepted onchain yet/);
  });

  it("accepts with a verified tx: status accepted, settle hash recorded", async () => {
    const hire = await seededHire();
    const res = await post(postDecision, hire.id, { action: "accept", txHash: ACCEPT_TX });
    expect(res.status).toBe(200);
    const after = (await getHire(hire.id))!;
    expect(after.status).toBe("accepted");
    expect(after.settleTxHash).toBe(ACCEPT_TX);
    expect(after.escrowState).toBe("accepted");
    const decisions = await (await getLedger()).listDecisions(hire.id);
    const accept = decisions.find((d) => d.kind === "accept");
    expect(accept?.txHash).toBe(ACCEPT_TX);
  });

  it("rejects with a verified tx: status refunded, settle hash recorded", async () => {
    const hire = await seededHire();
    mockReadEscrow.mockResolvedValue({
      exists: true, customer: CUSTOMER, vault: VAULT, token: TOKEN, state: 3, tokenBalance: 0n,
    });
    const res = await post(postDecision, hire.id, { action: "reject", txHash: REJECT_TX });
    expect(res.status).toBe(200);
    const after = (await getHire(hire.id))!;
    expect(after.status).toBe("refunded");
    expect(after.settleTxHash).toBe(REJECT_TX);
    expect(after.escrowState).toBe("rejected");
    const decisions = await (await getLedger()).listDecisions(hire.id);
    expect(decisions.find((d) => d.kind === "reject")?.txHash).toBe(REJECT_TX);
  });
});

const SEAL_TX = `0x${"e".repeat(64)}`;
const SEALED_HASH = `0x${"1".repeat(64)}`;

describe("deliverable route", () => {
  beforeEach(() => {
    setLedgerForTests(new MemoryLedger());
    vi.clearAllMocks();
    mockVerifyReceipt.mockResolvedValue({ ok: true, from: CUSTOMER, to: VAULT });
    mockReadDeliverableHash.mockResolvedValue(SEALED_HASH);
  });

  async function seededDeliveredHire() {
    const hire = await createHire({ jobType: "market-report", description: "Compare payment options", customerWallet: CUSTOMER });
    const ledger = await getLedger();
    await ledger.updateOrderEscrow(hire.id, { escrowAddress: ESCROW, fundTxHash: FUND_TX });
    await ledger.updateOrderStatus(hire.id, "delivered");
    return hire;
  }

  it("records a verified seal: deliverable hash recorded, decision logged", async () => {
    const hire = await seededDeliveredHire();
    const res = await post(postDeliverable, hire.id, { txHash: SEAL_TX });
    expect(res.status).toBe(200);
    const after = (await getHire(hire.id))!;
    expect(after.deliverableTxHash).toBe(SEAL_TX);
    expect(after.status).toBe("delivered");
    const decisions = await (await getLedger()).listDecisions(hire.id);
    const sealed = decisions.find((d) => d.reason === "Deliverable sealed onchain.");
    expect(sealed?.kind).toBe("escrow");
    expect(sealed?.txHash).toBe(SEAL_TX);
  });

  it("re-posting the same seal tx is a no-op — no duplicate decision", async () => {
    const hire = await seededDeliveredHire();
    expect((await post(postDeliverable, hire.id, { txHash: SEAL_TX })).status).toBe(200);
    expect((await post(postDeliverable, hire.id, { txHash: SEAL_TX })).status).toBe(200);
    const decisions = await (await getLedger()).listDecisions(hire.id);
    expect(decisions.filter((d) => d.reason === "Deliverable sealed onchain.")).toHaveLength(1);
  });

  it("refuses a missing txHash, a failed receipt, a tx that didn't call the vault, or an unsealed escrow", async () => {
    const hire = await seededDeliveredHire();
    const missing = await post(postDeliverable, hire.id, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/transaction hash/);
    expect(mockVerifyReceipt).not.toHaveBeenCalled();
    mockVerifyReceipt.mockResolvedValue({ ok: false, from: null, to: null });
    const failed = await post(postDeliverable, hire.id, { txHash: SEAL_TX });
    expect(failed.status).toBe(400);
    expect(failed.body.error).toMatch(/didn't go through onchain/);
    mockVerifyReceipt.mockResolvedValue({ ok: true, from: CUSTOMER, to: ESCROW });
    const wrongContract = await post(postDeliverable, hire.id, { txHash: SEAL_TX });
    expect(wrongContract.status).toBe(400);
    expect(wrongContract.body.error).toMatch(/didn't call Ikenga's vault/);
    mockVerifyReceipt.mockResolvedValue({ ok: true, from: CUSTOMER, to: VAULT });
    mockReadDeliverableHash.mockResolvedValue(null);
    const unsealed = await post(postDeliverable, hire.id, { txHash: SEAL_TX });
    expect(unsealed.status).toBe(400);
    expect(unsealed.body.error).toMatch(/hasn't been sealed/);
    expect((await getHire(hire.id))?.deliverableTxHash).toBeNull();
  });

  it("refuses when there is no escrow for the job", async () => {
    const hire = await createHire({ jobType: "market-report", description: "Compare payment options", customerWallet: CUSTOMER });
    const res = await post(postDeliverable, hire.id, { txHash: SEAL_TX });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no escrow for this job yet/);
  });
});
