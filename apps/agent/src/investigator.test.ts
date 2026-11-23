import { describe, expect, it } from "vitest";
import type { EscrowOnchain } from "@ikenga/payments";
import { payoutCalldata } from "./bills.js";
import { investigateBillPayout, investigateBillSwap, investigateJobEscrow } from "./investigator.js";

const CUSTOMER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x61aD7AEAC0B94C91B4681d1D8624d82d5DaF4Fc0";
const ESCROW = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const VAULT = "0x1C2b2E64527B0bA7795ed3CDF7d76da51D24018B";
const CNGN = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f";
const REACTOR = "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3";
const SUPPLIER = "0x3333333333333333333333333333333333333333";
const ZERO = "0x0000000000000000000000000000000000000000";

function goodEscrow(overrides: Partial<EscrowOnchain> = {}): EscrowOnchain {
  return {
    exists: true,
    customer: CUSTOMER as `0x${string}`,
    vault: VAULT as `0x${string}`,
    token: TOKEN as `0x${string}`,
    state: 1,
    price: 1_000_000n,
    tokenBalance: 1_000_000n,
    ...overrides,
  };
}

const jobInput = {
  customerWallet: CUSTOMER,
  escrowAddress: ESCROW,
  tokenAddress: TOKEN,
  vaultAddress: VAULT,
  priceAtomic: "1000000",
};

describe("investigateJobEscrow", () => {
  it("passes a good escrow: customer, token, vault, price, funded state and balance all match", async () => {
    const res = await investigateJobEscrow(jobInput, { readEscrow: async () => goodEscrow() });
    expect(res.passed).toBe(true);
    expect(res.readable).toBe(true);
    expect(res.checks.every((c) => c.result === "passed")).toBe(true);
    expect(res.summary).toContain("Investigator checked the escrow");
  });

  it("passes when the price cannot be read onchain (old escrow) — the check is skipped, not failed", async () => {
    const res = await investigateJobEscrow(jobInput, { readEscrow: async () => goodEscrow({ price: null }) });
    expect(res.passed).toBe(true);
    expect(res.checks.find((c) => c.name === "escrow price")?.result).toBe("skipped");
  });

  it("rejects a zero-address customer wallet", async () => {
    const res = await investigateJobEscrow({ ...jobInput, customerWallet: ZERO }, { readEscrow: async () => goodEscrow() });
    expect(res.passed).toBe(false);
    expect(res.checks.find((c) => c.name === "customer wallet")?.result).toBe("failed");
  });

  it("rejects an escrow with no contract code", async () => {
    const res = await investigateJobEscrow(jobInput, {
      readEscrow: async () => ({ exists: false, customer: null, vault: null, token: null, state: null, price: null, tokenBalance: null }),
    });
    expect(res.passed).toBe(false);
    expect(res.checks.find((c) => c.name === "escrow contract")?.result).toBe("failed");
    expect(res.summary).toContain("no contract at the escrow address");
  });

  it("rejects an escrow that belongs to a different customer", async () => {
    const res = await investigateJobEscrow(jobInput, {
      readEscrow: async () => goodEscrow({ customer: "0x4444444444444444444444444444444444444444" as `0x${string}` }),
    });
    expect(res.passed).toBe(false);
    expect(res.summary).toContain("different wallet");
  });

  it("rejects an escrow holding a different token, and one that is not funded", async () => {
    const wrongToken = await investigateJobEscrow(jobInput, {
      readEscrow: async () => goodEscrow({ token: CNGN as `0x${string}` }),
    });
    expect(wrongToken.passed).toBe(false);
    const unfunded = await investigateJobEscrow(jobInput, { readEscrow: async () => goodEscrow({ state: 0, tokenBalance: 0n }) });
    expect(unfunded.passed).toBe(false);
    expect(unfunded.summary).toContain("not funded yet");
  });

  it("reports unreadable — not a pass, not a fail — when the chain cannot be read", async () => {
    const res = await investigateJobEscrow(jobInput, {
      readEscrow: async () => {
        throw new Error("RPC down");
      },
    });
    expect(res.passed).toBe(false);
    expect(res.readable).toBe(false);
  });
});

describe("investigateBillSwap", () => {
  it("passes when the USDT token and the swap contract both have code", async () => {
    const res = await investigateBillSwap(
      { usdtAddress: TOKEN, reactorAddress: REACTOR },
      { codeAt: async () => "0x60806040" },
    );
    expect(res.passed).toBe(true);
    expect(res.checks).toHaveLength(2);
  });

  it("fails when the swap contract has no code", async () => {
    const res = await investigateBillSwap(
      { usdtAddress: TOKEN, reactorAddress: REACTOR },
      { codeAt: async (addr: string) => (addr.toLowerCase() === REACTOR.toLowerCase() ? "0x" : "0x60806040") },
    );
    expect(res.passed).toBe(false);
    expect(res.checks.find((c) => c.name === "swap reactor")?.result).toBe("failed");
  });

  it("reports unreadable when the chain cannot be read", async () => {
    const res = await investigateBillSwap(
      { usdtAddress: TOKEN, reactorAddress: REACTOR },
      {
        codeAt: async () => {
          throw new Error("RPC down");
        },
      },
    );
    expect(res.passed).toBe(false);
    expect(res.readable).toBe(false);
  });
});

describe("investigateBillPayout", () => {
  const payoutInput = {
    supplierWallet: SUPPLIER,
    agentWallet: AGENT,
    amountNgn: 5000,
    cngnAddress: CNGN,
    payoutData: payoutCalldata(SUPPLIER, "5000000000"),
  };

  it("passes a good payout: the right supplier, the exact amount, a real cNGN token", async () => {
    const res = await investigateBillPayout(payoutInput, { codeAt: async () => "0x60806040" });
    expect(res.passed).toBe(true);
    expect(res.readable).toBe(true);
    expect(res.summary).toContain("Investigator checked the supplier payout");
  });

  it("rejects the zero address as supplier", async () => {
    const res = await investigateBillPayout({ ...payoutInput, supplierWallet: ZERO }, { codeAt: async () => "0x60806040" });
    expect(res.passed).toBe(false);
    expect(res.summary).toContain("zero address");
  });

  it("rejects the agent's own wallet as supplier", async () => {
    const res = await investigateBillPayout(
      { ...payoutInput, supplierWallet: AGENT, payoutData: payoutCalldata(AGENT, "5000000000") },
      { codeAt: async () => "0x60806040" },
    );
    expect(res.passed).toBe(false);
    expect(res.summary).toContain("cannot pay itself");
  });

  it("rejects a payout whose amount is not the bill's amount", async () => {
    const res = await investigateBillPayout(
      { ...payoutInput, payoutData: payoutCalldata(SUPPLIER, "4999000000") },
      { codeAt: async () => "0x60806040" },
    );
    expect(res.passed).toBe(false);
    expect(res.summary).toContain("not the bill's amount");
  });

  it("rejects a payout to a different wallet than the supplier", async () => {
    const res = await investigateBillPayout(
      { ...payoutInput, payoutData: payoutCalldata("0x5555555555555555555555555555555555555555", "5000000000") },
      { codeAt: async () => "0x60806040" },
    );
    expect(res.passed).toBe(false);
  });

  it("rejects a cNGN token with no code, and reports unreadable when the chain is down", async () => {
    const noCode = await investigateBillPayout(payoutInput, { codeAt: async () => "0x" });
    expect(noCode.passed).toBe(false);
    expect(noCode.checks.find((c) => c.name === "cNGN token")?.result).toBe("failed");
    const down = await investigateBillPayout(payoutInput, {
      codeAt: async () => {
        throw new Error("RPC down");
      },
    });
    expect(down.passed).toBe(false);
    expect(down.readable).toBe(false);
  });
});
