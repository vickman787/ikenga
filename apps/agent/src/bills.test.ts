import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { appendAttribution, parseAttribution } from "@ikenga/payments";
import {
  billBuyAmountAtomic,
  CNGN_ADDRESS,
  formatUsdtAtomic,
  makeBillSendFn,
  payoutCalldata,
  processBills,
  quoteRate,
  taggedPayoutCalldata,
  TEXTILE_REACTOR,
  USDT_ADDRESS,
  type BillRuntime,
  type BillUpdate,
  type SiteBill,
} from "./bills.js";

const transferAbi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const TAG = "celo_5144280c393f";
const TAKER = "0x61aD7AEAC0B94C91B4681d1D8624d82d5DaF4Fc0";
const SUPPLIER = "0x00000000000000000000000000000000000000aa";
const SWAP_DATA = "0xabcdef0123456789";
const APPROVAL_DATA = "0x095ea7b3000000000000000000000000a9aa0a64769cbed4d3b1ceb4df01cde915c235b3000000000000000000000000000000000000000000000000000000000000351d4";

function fakeQuote(overrides: { buyAmount?: string; takerPays?: string; rateRay?: string } = {}) {
  return {
    rfqId: "rfq_test_1",
    claimToken: "claim_test_1",
    status: "quoted",
    sellAmount: overrides.takerPays ?? "3462600",
    buyAmount: overrides.buyAmount ?? "5000000000",
    feeAmount: "10000",
    takerPays: overrides.takerPays ?? "3462600",
    rateRay: overrides.rateRay ?? "1444000000000000000000000000000",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    orderDeadline: new Date(Date.now() + 60_000).toISOString(),
    latestOrderDeadline: new Date(Date.now() + 60_000).toISOString(),
    reactor: TEXTILE_REACTOR,
    taker: TAKER,
    encodedOrder: "0x00",
    signature: "0x00",
    orders: [],
    transactions: { swap: { to: TEXTILE_REACTOR, data: SWAP_DATA, value: "0" } },
    attributionSuffix: null,
  };
}

function fakeBill(overrides: Partial<SiteBill> = {}): SiteBill {
  return {
    id: "bill_test_1",
    payerName: "Ada",
    purpose: "Rice for the shop",
    amountNgn: 5000,
    supplierWallet: SUPPLIER,
    deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    minRate: 1400,
    status: "created",
    note: null,
    lastDecision: null,
    fundingNeededUsdt: null,
    fundingReady: null,
    rfqId: null,
    approvalTxHashes: [],
    swapTxHash: null,
    forced: false,
    payoutTxHash: null,
    ...overrides,
  };
}

interface FakeState {
  updates: { id: string; update: BillUpdate }[];
  tagged: { to: string; data: Hex }[];
  raw: { to: string; data: Hex }[];
  firmQuotes: number;
  cancels: string[];
  swapReceipt: { status: "success" | "reverted" } | null;
}

function fakeRuntime(overrides: {
  previewRate?: { buyAmount: string; takerPays: string };
  previewNoQuote?: boolean;
  firmNoQuote?: boolean;
  firmRate?: { buyAmount: string; takerPays: string };
  usdt?: bigint;
  cngn?: bigint;
  celo?: bigint;
  swapThrows?: string;
} = {}): { rt: BillRuntime; state: FakeState } {
  const state: FakeState = { updates: [], tagged: [], raw: [], firmQuotes: 0, cancels: [], swapReceipt: { status: "success" } };
  const preview = overrides.previewRate ?? { buyAmount: "5000000000", takerPays: "3462600" };
  const firm = overrides.firmRate ?? preview;
  const rt: BillRuntime = {
    takerAddress: TAKER,
    preview: async () =>
      overrides.previewNoQuote
        ? { kind: "no_quote", reason: "no_makers_online" }
        : { kind: "preview", sellAmount: preview.takerPays, buyAmount: preview.buyAmount, feeAmount: "10000", takerPays: preview.takerPays, rateRay: "0" },
    firmQuote: async () => {
      state.firmQuotes += 1;
      return overrides.firmNoQuote
        ? { kind: "no_quote", reason: "no_makers_online" }
        : { kind: "quoted", quote: fakeQuote(firm) as never };
    },
    cancelQuote: async (rfqId: string) => {
      state.cancels.push(rfqId);
    },
    usdtBalanceOf: async () => overrides.usdt ?? 10_000_000n,
    cngnBalanceOf: async () => overrides.cngn ?? 10_000_000_000n,
    celoBalanceOf: async () => overrides.celo ?? 1_000_000_000_000_000_000n,
    getAllowance: async () => 0n,
    waitForReceipt: async () => ({ status: "success" as const }),
    getReceipt: async () => state.swapReceipt,
    executeSwap: async (quote, sendFn) => {
      if (overrides.swapThrows) throw new Error(overrides.swapThrows);
      // The real executeSwap sends the approval then the swap through the one sendFn.
      const approvalHash = await sendFn({ to: USDT_ADDRESS, data: APPROVAL_DATA as Hex, value: "0" });
      const swapHash = await sendFn({ to: quote.reactor, data: quote.transactions.swap.data as Hex, value: "0" });
      void approvalHash;
      return { txHash: swapHash, approvalTxHashes: [`0x${"a".repeat(64)}`], attributionTagged: true, submitted: true };
    },
    // Mirrors the real sendTagged: the tag is appended, then the tx is recorded.
    sendTagged: async (tx) => {
      const tagged = appendAttribution(tx.data as Hex, TAG);
      state.tagged.push({ to: tx.to, data: tagged });
      return `0x${"a".repeat(63)}${state.tagged.length}` as Hex;
    },
    sendRaw: async (tx) => {
      state.raw.push({ to: tx.to, data: tx.data as Hex });
      return `0x${"b".repeat(63)}${state.raw.length}` as Hex;
    },
    updateBill: async (id, update) => {
      state.updates.push({ id, update });
    },
    nowIso: () => new Date().toISOString(),
    log: () => {},
  };
  return { rt, state };
}

describe("quoteRate / formatUsdtAtomic / billBuyAmountAtomic", () => {
  it("rates the quote on what the bill actually costs, fee included", () => {
    expect(quoteRate("5000000000", "3462600")).toBeCloseTo(1444, 0);
    expect(quoteRate("1444000000", "1000000")).toBe(1444);
    expect(() => quoteRate("100", "0")).toThrow(/takerPays/);
  });

  it("formats atomic USDT as a plain decimal", () => {
    expect(formatUsdtAtomic("1052341")).toBe("1.052341");
    expect(formatUsdtAtomic("1000000")).toBe("1");
    expect(formatUsdtAtomic("3462600")).toBe("3.4626");
  });

  it("sizes the buy amount in whole cNGN atomic units", () => {
    expect(billBuyAmountAtomic(1500)).toBe("1500000000");
    expect(billBuyAmountAtomic(5000)).toBe("5000000000");
    expect(() => billBuyAmountAtomic(0)).toThrow();
    expect(() => billBuyAmountAtomic(1.5)).toThrow();
  });
});

describe("payout calldata + tag", () => {
  it("encodes the exact transfer and the tag parses back off it", () => {
    const { tagged, codes } = taggedPayoutCalldata(SUPPLIER, "5000000000", TAG);
    expect(codes).toContain(TAG);
    const parsed = parseAttribution(tagged);
    expect(parsed?.codes).toContain(TAG);
    // Stripping the tag leaves the exact transfer call — the tag changes nothing about the payment.
    const untagged = payoutCalldata(SUPPLIER, "5000000000");
    expect(tagged.startsWith(untagged)).toBe(true);
    const decoded = decodeFunctionData({ abi: transferAbi, data: untagged, functionName: "transfer" });
    expect(decoded.args[0]?.toLowerCase()).toBe(SUPPLIER.toLowerCase());
    expect(decoded.args[1]).toBe(5000000000n);
  });
});

describe("makeBillSendFn — the tagging split", () => {
  it("tags approvals, broadcasts the swap exactly as returned", async () => {
    const { rt, state } = fakeRuntime();
    const sendFn = makeBillSendFn({ sendTagged: rt.sendTagged, sendRaw: rt.sendRaw, swapData: SWAP_DATA });
    await sendFn({ to: USDT_ADDRESS, data: APPROVAL_DATA as Hex, value: "0" });
    await sendFn({ to: TEXTILE_REACTOR, data: SWAP_DATA.toUpperCase() as Hex, value: "0" });
    expect(state.tagged).toHaveLength(1);
    expect(parseAttribution(state.tagged[0].data)?.codes).toContain(TAG);
    expect(state.raw).toHaveLength(1);
    // The swap data is byte-identical to what Textile returned — no tag appended.
    expect(state.raw[0].data.toLowerCase()).toBe(SWAP_DATA.toLowerCase());
    expect(parseAttribution(state.raw[0].data)).toBeNull();
  });
});

describe("processBills", () => {
  it("waits for funding when the agent wallet is short, and never asks for a firm quote", async () => {
    const { rt, state } = fakeRuntime({ usdt: 1_000_000n });
    const res = await processBills([fakeBill()], rt, 10);
    expect(res.waiting).toBe(1);
    expect(res.converted).toBe(0);
    expect(state.firmQuotes).toBe(0);
    expect(state.tagged).toHaveLength(0);
    expect(state.raw).toHaveLength(0);
    const patch = state.updates[0].update.patch as Record<string, unknown>;
    expect(patch.fundingReady).toBe(false);
    expect(patch.fundingNeededUsdt).toBe("3.4626");
    expect(String(patch.note)).toContain("$3.46");
  });

  it("waits for gas when the wallet holds USDT but no CELO", async () => {
    const { rt, state } = fakeRuntime({ celo: 0n });
    const res = await processBills([fakeBill()], rt, 10);
    expect(res.waiting).toBe(1);
    expect(state.firmQuotes).toBe(0);
    expect(String((state.updates[0].update.patch as Record<string, unknown>).note)).toContain("no CELO for gas");
  });

  it("refuses below the minimum and records the refusal only once", async () => {
    const { rt, state } = fakeRuntime({
      previewRate: { buyAmount: "5000000000", takerPays: "4000000" }, // rate 1250 < 1400
    });
    const bill = fakeBill();
    const first = await processBills([bill], rt, 10);
    expect(first.refused).toBe(1);
    expect(state.firmQuotes).toBe(0);
    expect(state.updates[0].update.event?.kind).toBe("refuse");
    // Second run, same rate: the patch updates, but no second refusal receipt.
    const second = await processBills([fakeBill({ lastDecision: "refuse" })], rt, 10);
    expect(second.refused).toBe(1);
    expect(state.updates.filter((u) => u.update.event?.kind === "refuse")).toHaveLength(1);
  });

  it("converts at a good rate: approval tagged, swap raw, payout tagged with the tag on it", async () => {
    const { rt, state } = fakeRuntime();
    const res = await processBills([fakeBill()], rt, 10);
    expect(res.paid).toBe(1);
    expect(res.converted).toBe(0);
    // Approval went tagged, swap went raw, payout went tagged.
    expect(state.tagged).toHaveLength(2);
    expect(state.raw).toHaveLength(1);
    expect(state.raw[0].data.toLowerCase()).toBe(SWAP_DATA.toLowerCase());
    const payout = state.tagged.find((t) => t.to.toLowerCase() === CNGN_ADDRESS.toLowerCase());
    expect(payout).toBeDefined();
    expect(parseAttribution(payout!.data)?.codes).toContain(TAG);
    // The tagged payout starts with the exact transfer call.
    const untagged = payoutCalldata(SUPPLIER, "5000000000");
    expect(payout!.data.startsWith(untagged)).toBe(true);
    const decoded = decodeFunctionData({ abi: transferAbi, data: untagged, functionName: "transfer" });
    expect(decoded.args[0]?.toLowerCase()).toBe(SUPPLIER.toLowerCase());
    expect(decoded.args[1]).toBe(5000000000n);
    // The swap was recorded before the payout, and the bill ends paid.
    const swapUpdate = state.updates.find((u) => u.update.event?.kind === "swap");
    expect(swapUpdate?.update.patch).toMatchObject({ status: "converting" });
    const paidUpdate = state.updates.find((u) => u.update.event?.kind === "payout");
    expect(paidUpdate?.update.patch).toMatchObject({ status: "paid" });
  });

  it("force-converts at the deadline below the minimum", async () => {
    const { rt, state } = fakeRuntime({
      previewRate: { buyAmount: "5000000000", takerPays: "4000000" },
      firmRate: { buyAmount: "5000000000", takerPays: "4000000" },
    });
    const bill = fakeBill({ deadline: new Date(Date.now() - 1000).toISOString() });
    const res = await processBills([bill], rt, 10);
    expect(res.paid).toBe(1);
    const swapUpdate = state.updates.find((u) => u.update.event?.kind === "swap");
    expect(swapUpdate?.update.patch).toMatchObject({ forced: true });
    expect(String(swapUpdate?.update.event?.reason)).toContain("Deadline reached");
  });

  it("cancels the firm quote when it comes back below the minimum", async () => {
    const { rt, state } = fakeRuntime({
      firmRate: { buyAmount: "5000000000", takerPays: "4000000" }, // firm 1250 < 1400, preview was fine
    });
    const res = await processBills([fakeBill()], rt, 10);
    expect(res.refused).toBe(1);
    expect(state.cancels).toEqual(["rfq_test_1"]);
    expect(state.raw).toHaveLength(0);
  });

  it("resumes a converting bill: pays out when the swap landed, waits while it is unmined", async () => {
    const converting = fakeBill({ status: "converting", swapTxHash: `0x${"c".repeat(64)}` });
    const { rt, state } = fakeRuntime();
    const res = await processBills([converting], rt, 10);
    expect(res.paid).toBe(1);
    expect(state.tagged).toHaveLength(1); // only the payout — no second swap
    expect(state.raw).toHaveLength(0);

    const pending = fakeRuntime();
    pending.state.swapReceipt = null;
    const res2 = await processBills([converting], pending.rt, 10);
    expect(res2.waiting).toBe(1);
    expect(pending.state.tagged).toHaveLength(0);
  });

  it("refuses a bill that would pay the agent wallet itself", async () => {
    const { rt, state } = fakeRuntime();
    const res = await processBills([fakeBill({ supplierWallet: TAKER })], rt, 10);
    expect(res.failed).toBe(1);
    expect(state.tagged).toHaveLength(0);
    expect(state.raw).toHaveLength(0);
    expect(state.updates[0].update.patch).toMatchObject({ status: "failed" });
  });

  it("waits on no_quote, and waits (without moving anything) when the swap fails", async () => {
    const { rt, state } = fakeRuntime({ previewNoQuote: true });
    expect((await processBills([fakeBill()], rt, 10)).waiting).toBe(1);
    expect(state.firmQuotes).toBe(0);

    const failing = fakeRuntime({ swapThrows: "firm quote expired during approval" });
    const res = await processBills([fakeBill()], failing.rt, 10);
    expect(res.waiting).toBe(1);
    expect(failing.state.raw).toHaveLength(0);
    expect(failing.state.tagged).toHaveLength(0);
  });

  it("skips bills that are already paid or failed, and stops at the action cap", async () => {
    const { rt } = fakeRuntime();
    const res = await processBills([fakeBill({ status: "paid" }), fakeBill({ status: "failed" })], rt, 10);
    expect(res.checked).toBe(0);
    const capped = await processBills([fakeBill(), fakeBill({ id: "bill_test_2" })], rt, 0);
    expect(capped.checked).toBe(0);
  });
});
