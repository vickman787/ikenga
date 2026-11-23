import { describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi, type Hex, type PublicClient } from "viem";
import { appendAttribution, stripAttribution } from "./attribution.js";
import { verifyFundingTransfer } from "./escrow.js";

const TAG = "celo_5144280c393f";
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const CNGN = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f";
const AGENT = "0x61aD7AEAC0B94C91B4681d1D8624d82d5DaF4Fc0";
const PAYER = "0x00000000000000000000000000000000000000aa";
const OTHER = "0x00000000000000000000000000000000000000bb";
const AMOUNT = 3_462_600n;

function transferInput(to: string, amount: bigint, tag: boolean): Hex {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [to as `0x${string}`, amount],
  });
  return tag ? appendAttribution(data, TAG) : data;
}

function fakeClient(opts: {
  receipt?: { status: "success" | "reverted"; from: string; to: string | null } | "not-found" | "throws";
  input?: Hex;
}): PublicClient {
  return {
    getTransactionReceipt: async () => {
      if (opts.receipt === "not-found") {
        throw new Error("Transaction with hash 0x00 not found.");
      }
      if (opts.receipt === "throws") throw new Error("RPC is down");
      if (!opts.receipt) return null;
      return opts.receipt as never;
    },
    getTransaction: async () => ({ input: opts.input ?? "0x" }) as never,
  } as unknown as PublicClient;
}

const EXPECTED = { token: USDT, from: PAYER, recipient: AGENT, amountAtomic: AMOUNT };

describe("stripAttribution", () => {
  it("strips the tag back to the exact transfer call, and leaves untagged data alone", () => {
    const plain = transferInput(AGENT, AMOUNT, false);
    const tagged = transferInput(AGENT, AMOUNT, true);
    expect(stripAttribution(tagged)).toBe(plain);
    expect(stripAttribution(plain)).toBe(plain);
  });
});

describe("verifyFundingTransfer", () => {
  it("verifies a tagged funding transfer: tag strips back to the exact transfer(to, amount)", async () => {
    const client = fakeClient({
      receipt: { status: "success", from: PAYER, to: USDT },
      input: transferInput(AGENT, AMOUNT, true),
    });
    const check = await verifyFundingTransfer(`0x${"a".repeat(64)}`, EXPECTED, { client });
    expect(check.ok).toBe(true);
    expect(check.reason).toBeNull();
    expect(check.recipient?.toLowerCase()).toBe(AGENT.toLowerCase());
    expect(check.amountAtomic).toBe(AMOUNT);
  });

  it("verifies an untagged manual transfer the same way", async () => {
    const client = fakeClient({
      receipt: { status: "success", from: PAYER, to: USDT },
      input: transferInput(AGENT, AMOUNT, false),
    });
    const check = await verifyFundingTransfer(`0x${"a".repeat(64)}`, EXPECTED, { client });
    expect(check.ok).toBe(true);
  });

  it("refuses the wrong amount, and reports the amount that was actually paid", async () => {
    const client = fakeClient({
      receipt: { status: "success", from: PAYER, to: USDT },
      input: transferInput(AGENT, 1_000_000n, true),
    });
    const check = await verifyFundingTransfer(`0x${"a".repeat(64)}`, EXPECTED, { client });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("wrong amount");
    expect(check.amountAtomic).toBe(1_000_000n);
  });

  it("refuses a transfer to the wrong recipient, from the wrong payer, or to the wrong token", async () => {
    const wrongRecipient = fakeClient({
      receipt: { status: "success", from: PAYER, to: USDT },
      input: transferInput(OTHER, AMOUNT, true),
    });
    expect((await verifyFundingTransfer(`0x${"a".repeat(64)}`, EXPECTED, { client: wrongRecipient })).reason).toBe("wrong recipient");

    const wrongPayer = fakeClient({
      receipt: { status: "success", from: OTHER, to: USDT },
      input: transferInput(AGENT, AMOUNT, true),
    });
    expect((await verifyFundingTransfer(`0x${"a".repeat(64)}`, EXPECTED, { client: wrongPayer })).reason).toBe("wrong payer");

    const wrongToken = fakeClient({
      receipt: { status: "success", from: PAYER, to: CNGN },
      input: transferInput(AGENT, AMOUNT, true),
    });
    expect((await verifyFundingTransfer(`0x${"a".repeat(64)}`, EXPECTED, { client: wrongToken })).reason).toBe("wrong token");
  });

  it("refuses a reverted transaction, a transaction that isn't onchain yet, and input that isn't a transfer", async () => {
    const reverted = fakeClient({
      receipt: { status: "reverted", from: PAYER, to: USDT },
      input: transferInput(AGENT, AMOUNT, true),
    });
    expect((await verifyFundingTransfer(`0x${"a".repeat(64)}`, EXPECTED, { client: reverted })).reason).toBe("reverted");

    const notFound = fakeClient({ receipt: "not-found" });
    expect((await verifyFundingTransfer(`0x${"a".repeat(64)}`, EXPECTED, { client: notFound })).reason).toBe("not onchain yet");

    const notTransfer = fakeClient({
      receipt: { status: "success", from: PAYER, to: USDT },
      input: "0xdeadbeef",
    });
    expect((await verifyFundingTransfer(`0x${"a".repeat(64)}`, EXPECTED, { client: notTransfer })).reason).toBe("not a transfer");
  });

  it("throws when the RPC can't be reached, so the caller can answer 502", async () => {
    const client = fakeClient({ receipt: "throws" });
    await expect(verifyFundingTransfer(`0x${"a".repeat(64)}`, EXPECTED, { client })).rejects.toThrow(/RPC is down/);
  });

  it("rejects a malformed hash without touching the chain", async () => {
    await expect(verifyFundingTransfer("not-a-hash", EXPECTED)).rejects.toThrow(/hash/);
  });
});
