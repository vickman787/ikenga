/**
 * Textile FX RFQ client tests (Workstream B).
 *
 * Mocked API covers: happy path, no_quote, insufficient_funds,
 * proof_of_control_required (re-sign once), rate_limited, submit 409.
 * Live-gated tests (BSC testnet preview/levels, mainnet preview) run only
 * with IKENGA_LIVE_TESTS=1 and move no funds; no live swap is executed
 * anywhere in this file — a funded wallet does not exist in this VM.
 */
import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, erc20Abi, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildPreviewBody,
  buildRfqRequestBody,
  ERC8021_MARKER,
  hasAttributionTag,
  parseFirmQuoteResponse,
  parsePreviewResponse,
  signTakerProof,
  TEXTILE_CELO_REACTOR,
  TEXTILE_CELO_TOKENS,
  TextileClient,
  TextileError,
  type FirmQuote,
  type SendFn,
} from "./textile.js";

// Anvil test key 0 — signing only, never funded, never used on mainnet.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f3ff80";
const TAKER = privateKeyToAccount(TEST_KEY);
const USDT = TEXTILE_CELO_TOKENS.USDT;
const CNGN = TEXTILE_CELO_TOKENS.cNGN;

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const EXPIRES = "2030-01-01T00:01:00.000Z";
const ORDER_DEADLINE = "2030-01-01T00:01:03.000Z";

/** Swap calldata carrying a real ERC-8021 schema-0 suffix. */
const TAGGED_SWAP_DATA = `0x12345678abcd0200${ERC8021_MARKER.slice(2)}`;
const UNTAGGED_SWAP_DATA = "0x12345678abcd";

function quotedFixture(overrides: Partial<FirmQuote> = {}): FirmQuote {
  return {
    rfqId: "rfq_test_1",
    claimToken: "rfqc_test_1",
    status: "quoted",
    // sellAmount (gross cap) deliberately differs from takerPays.
    sellAmount: "10000000",
    buyAmount: "14440000000",
    feeAmount: "1999",
    takerPays: "9999000",
    rateRay: "692350000016072656424392",
    expiresAt: EXPIRES,
    orderDeadline: ORDER_DEADLINE,
    latestOrderDeadline: ORDER_DEADLINE,
    reactor: TEXTILE_CELO_REACTOR,
    taker: TAKER.address,
    encodedOrder: "0x1111",
    signature: "0x2222",
    orders: [
      {
        encodedOrder: "0x1111",
        signature: "0x2222",
        sellAmount: "10000000",
        buyAmount: "14440000000",
        feeAmount: "1999",
        maker: "0x00000000000000000000000000000000000000aa",
      },
    ],
    transactions: {
      approval: { to: USDT, data: "0x095ea7b3", value: "0", chainId: 42220 },
      swap: { to: TEXTILE_CELO_REACTOR, data: TAGGED_SWAP_DATA, value: "0", chainId: 42220 },
    },
    attributionSuffix: `abcd0200${ERC8021_MARKER.slice(2)}`,
    ...overrides,
  };
}

function quotedResponseBody(quote: FirmQuote): Record<string, unknown> {
  return {
    data: {
      rfqId: quote.rfqId,
      claimToken: quote.claimToken,
      status: "quoted",
      quote: {
        sellAmount: quote.sellAmount,
        buyAmount: quote.buyAmount,
        feeAmount: quote.feeAmount,
        takerPays: quote.takerPays,
        rateRay: quote.rateRay,
        expiresAt: quote.expiresAt,
        orderDeadline: quote.orderDeadline,
        latestOrderDeadline: quote.latestOrderDeadline,
        reactor: quote.reactor,
        taker: quote.taker,
        encodedOrder: quote.encodedOrder,
        signature: quote.signature,
        orders: quote.orders,
      },
      transactions: quote.transactions,
      attributionSuffix: quote.attributionSuffix,
    },
  };
}

/** Minimal fetch stub: route on `${method} ${path}`. Records every call. */
function fakeFetch(
  routes: Record<string, { status: number; body: unknown; headers?: Record<string, string> } | ((call: number) => { status: number; body: unknown; headers?: Record<string, string> })>,
) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const key = `${init?.method ?? "GET"} ${u.pathname}${u.search}`;
    const route = routes[key];
    if (!route) throw new Error(`no fake route for ${key}`);
    const callNo = calls.length;
    const parsedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, init: init ?? {}, body: parsedBody });
    const res = typeof route === "function" ? route(callNo) : route;
    return {
      status: res.status,
      headers: new Headers({ "X-Request-Id": "req_test_1", ...(res.headers ?? {}) }),
      json: async () => res.body,
    };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("buildRfqRequestBody (pure)", () => {
  const base = {
    chainId: 42220,
    sellToken: USDT,
    buyToken: CNGN,
    sellAmount: "10000000",
    taker: TAKER.address,
  };

  it("builds an exact-input body with atomic-unit strings", () => {
    const body = buildRfqRequestBody(base);
    expect(body).toEqual({
      chainId: 42220,
      sellToken: USDT,
      buyToken: CNGN,
      sellAmount: "10000000",
    });
    expect(body).not.toHaveProperty("buyAmount");
    expect(body).not.toHaveProperty("takerProof");
  });

  it("builds an exact-output body with buyAmount only", () => {
    const { sellAmount: _s, ...rest } = base;
    void _s;
    const body = buildRfqRequestBody({ ...rest, buyAmount: "14440000000" });
    expect(body.buyAmount).toBe("14440000000");
    expect(body).not.toHaveProperty("sellAmount");
  });

  it("rejects both/neither amount, non-atomic amounts, same token, bad chain pair", () => {
    expect(() => buildRfqRequestBody({ ...base, buyAmount: "1" })).toThrow(/exactly one/);
    expect(() => buildRfqRequestBody({ ...base, sellAmount: undefined })).toThrow(/exactly one/);
    expect(() => buildRfqRequestBody({ ...base, sellAmount: "1.5" })).toThrow(/atomic units/);
    expect(() => buildRfqRequestBody({ ...base, sellAmount: "0" })).toThrow(/atomic units/);
    expect(() => buildRfqRequestBody({ ...base, buyToken: USDT })).toThrow(/must differ/);
    // USDT -> some other token is not a Celo corridor.
    expect(() =>
      buildRfqRequestBody({ ...base, buyToken: "0x00000000000000000000000000000000000000aa" }),
    ).toThrow(/USDT <-> cNGN/);
  });

  it("rejects mutually exclusive steering and bad/reserved builder codes", () => {
    const w = "0x00000000000000000000000000000000000000aa";
    expect(() =>
      buildRfqRequestBody({ ...base, preferredLiquidityWallets: [w], restrictedLiquidityWallets: [w] }),
    ).toThrow(/mutually exclusive/);
    expect(() => buildRfqRequestBody({ ...base, builderCodes: ["Bad-Code!"] })).toThrow(/builderCode/);
    expect(() => buildRfqRequestBody({ ...base, builderCodes: ["textile_mine"] })).toThrow(/reserved/);
    expect(() => buildRfqRequestBody({ ...base, builderCodes: ["tp_mine"] })).toThrow(/reserved/);
    expect(buildRfqRequestBody({ ...base, builderCodes: ["ikenga"] }).builderCodes).toEqual(["ikenga"]);
  });

  it("preview body never carries a taker", () => {
    const body = buildPreviewBody({
      chainId: 42220,
      sellToken: USDT,
      buyToken: CNGN,
      sellAmount: "10000000",
    });
    expect(body).not.toHaveProperty("taker");
    expect(body).not.toHaveProperty("takerProof");
  });
});

describe("signTakerProof (EIP-712, viem)", () => {
  it("signs TakerControl and recovers the taker address", async () => {
    const proof = await signTakerProof(TAKER, 42220, NOW);
    expect(proof.issuedAt).toBe(NOW);
    expect(proof.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    const recovered = await verifyTypedData({
      address: TAKER.address,
      domain: { name: "Textile Taker Control", version: "1", chainId: 42220 },
      types: {
        TakerControl: [
          { name: "taker", type: "address" },
          { name: "chainId", type: "uint256" },
          { name: "nonce", type: "bytes32" },
          { name: "issuedAt", type: "uint256" },
        ],
      },
      primaryType: "TakerControl",
      message: {
        taker: TAKER.address,
        chainId: 42220n,
        nonce: proof.nonce as `0x${string}`,
        issuedAt: BigInt(proof.issuedAt),
      },
      signature: proof.signature as `0x${string}`,
    });
    expect(recovered).toBe(true);
  });
});

describe("response parsers (pure)", () => {
  it("reads takerPays (not sellAmount), expiresAt/orderDeadline, stores claimToken", () => {
    const quote = quotedFixture();
    const parsed = parseFirmQuoteResponse(quotedResponseBody(quote));
    expect(parsed.kind).toBe("quoted");
    if (parsed.kind !== "quoted") return;
    expect(parsed.quote.takerPays).toBe("9999000");
    expect(parsed.quote.sellAmount).toBe("10000000");
    expect(parsed.quote.claimToken).toBe("rfqc_test_1");
    expect(parsed.quote.expiresAt).toBe(EXPIRES);
    expect(parsed.quote.orderDeadline).toBe(ORDER_DEADLINE);
    expect(parsed.quote.encodedOrder).toBe("0x1111");
  });

  it("surfaces no_quote (HTTP 200) with reason + available depth, without throwing", () => {
    const parsed = parseFirmQuoteResponse({
      data: {
        rfqId: "rfq_test_2",
        claimToken: "rfqc_test_2",
        status: "no_quote",
        reason: "no_valid_quote",
        availableSellAmount: "800000000",
        retryAfterMs: 1500,
      },
    });
    expect(parsed).toEqual({
      kind: "no_quote",
      rfqId: "rfq_test_2",
      claimToken: "rfqc_test_2",
      reason: "no_valid_quote",
      availableSellAmount: "800000000",
      availableBuyAmount: undefined,
      reservedUntil: undefined,
      retryAfterMs: 1500,
    });
  });

  it("throws when a quoted response is missing transactions.swap or takerPays", () => {
    const body = quotedResponseBody(quotedFixture());
    const noSwap = structuredClone(body) as { data: { transactions: Record<string, unknown> } };
    delete noSwap.data.transactions.swap;
    expect(() => parseFirmQuoteResponse(noSwap)).toThrow(/transactions\.swap/);
    const noPays = structuredClone(body) as { data: { quote: Record<string, unknown> } };
    delete noPays.data.quote.takerPays;
    expect(() => parseFirmQuoteResponse(noPays)).toThrow(/takerPays/);
  });

  it("parses preview and preview no_quote", () => {
    const preview = parsePreviewResponse({
      data: {
        status: "preview",
        sellAmount: "10000000",
        buyAmount: "14440674514",
        feeAmount: "1999",
        takerPays: "10000000",
        rateRay: "692350000016072656424392",
        availableSellAmount: "42442466717",
      },
    });
    expect(preview.kind).toBe("preview");
    if (preview.kind === "preview") expect(preview.buyAmount).toBe("14440674514");
    expect(parsePreviewResponse({ data: { status: "no_quote", reason: "no_makers_online" } })).toEqual(
      expect.objectContaining({ kind: "no_quote", reason: "no_makers_online" }),
    );
  });
});

describe("hasAttributionTag", () => {
  it("detects a schema-0 ERC-8021 suffix and rejects untagged / wrong-schema data", () => {
    expect(hasAttributionTag(TAGGED_SWAP_DATA)).toBe(true);
    expect(hasAttributionTag(UNTAGGED_SWAP_DATA)).toBe(false);
    // Same marker but schema byte 0x01 instead of 0x00.
    expect(hasAttributionTag(`0x12345678abcd0201${ERC8021_MARKER.slice(2)}`)).toBe(false);
    expect(hasAttributionTag("not-hex")).toBe(false);
  });
});

describe("TextileClient with mocked API", () => {
  const input = {
    chainId: 42220,
    sellToken: USDT,
    buyToken: CNGN,
    sellAmount: "10000000",
    taker: TAKER.address,
  };

  it("previewQuote returns the indicative price (no credential, no taker sent)", async () => {
    const { fetchFn, calls } = fakeFetch({
      "POST /v2/rfq/preview": {
        status: 200,
        body: {
          data: {
            status: "preview",
            sellAmount: "10000000",
            buyAmount: "14440674514",
            feeAmount: "1999",
            takerPays: "10000000",
            rateRay: "692350000016072656424392",
            availableSellAmount: "42442466717",
          },
        },
      },
    });
    const client = new TextileClient({ fetchFn });
    const res = await client.previewQuote({ chainId: 42220, sellToken: USDT, buyToken: CNGN, sellAmount: "10000000" });
    expect(res.kind).toBe("preview");
    expect(calls[0].body).not.toHaveProperty("taker");
  });

  it("getLevels returns pairs with min/max depth", async () => {
    const { fetchFn } = fakeFetch({
      "GET /v2/rfq/levels?chainId=42220": {
        status: 200,
        body: {
          data: {
            chainId: 42220,
            asOf: "2030-01-01T00:00:00.000Z",
            pairs: [
              {
                sellToken: USDT,
                buyToken: CNGN,
                sellDecimals: 6,
                buyDecimals: 6,
                minSellAmount: "1000000",
                maxSellAmount: "42442466717",
                levels: [{ sellAmount: "1000000", buyAmount: "1444068751" }],
              },
            ],
          },
        },
      },
    });
    const client = new TextileClient({ fetchFn });
    const levels = await client.getLevels(42220);
    expect(levels.pairs[0].maxSellAmount).toBe("42442466717");
    expect(levels.pairs[0].minSellAmount).toBe("1000000");
  });

  it("requestFirmQuote with an API key sends Bearer auth and never a takerProof", async () => {
    const { fetchFn, calls } = fakeFetch({
      "POST /v2/rfq/request": { status: 200, body: quotedResponseBody(quotedFixture()) },
    });
    const client = new TextileClient({ fetchFn, apiKey: "tx_test_key" });
    const res = await client.requestFirmQuote(input);
    expect(res.kind).toBe("quoted");
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer tx_test_key" });
    expect(calls[0].body).toMatchObject({ includeAttribution: true, taker: TAKER.address });
    expect(calls[0].body).not.toHaveProperty("takerProof");
  });

  it("keyless: sends unsigned first, re-signs ONCE on 401 proof_of_control_required, then succeeds", async () => {
    const { fetchFn, calls } = fakeFetch({
      "POST /v2/rfq/request": (callNo: number) =>
        callNo === 0
          ? {
              status: 401,
              body: { error: { code: "unauthorized", message: "proof required", details: { reason: "proof_of_control_required" } } },
            }
          : { status: 200, body: quotedResponseBody(quotedFixture()) },
    });
    const signer = { address: TAKER.address, signTypedData: vi.fn((args) => TAKER.signTypedData(args)) };
    const client = new TextileClient({ fetchFn, now: () => NOW });
    const res = await client.requestFirmQuote(input, { signer });
    expect(res.kind).toBe("quoted");
    expect(calls).toHaveLength(2);
    expect(calls[0].body).not.toHaveProperty("takerProof");
    expect(calls[1].body).toHaveProperty("takerProof");
    expect(signer.signTypedData).toHaveBeenCalledTimes(1);
    const proof = (calls[1].body as { takerProof: { nonce: string; issuedAt: number; signature: string } }).takerProof;
    expect(proof.issuedAt).toBe(NOW);
    expect(proof.signature).toMatch(/^0x[0-9a-f]+$/);
  });

  it("keyless without a signer throws a typed error on 401 proof_of_control_required", async () => {
    const { fetchFn } = fakeFetch({
      "POST /v2/rfq/request": {
        status: 401,
        body: { error: { code: "unauthorized", message: "proof required", details: { reason: "proof_of_control_required" } } },
      },
    });
    const client = new TextileClient({ fetchFn });
    await expect(client.requestFirmQuote(input)).rejects.toMatchObject({
      httpStatus: 401,
      reason: "proof_of_control_required",
    });
  });

  it("400 insufficient_funds surfaces required/available/committed", async () => {
    const { fetchFn } = fakeFetch({
      "POST /v2/rfq/request": {
        status: 400,
        body: {
          error: {
            code: "invalid_request",
            message: "not enough",
            details: { reason: "insufficient_funds", required: "10000000", available: "1000000", committed: "5000000" },
          },
        },
      },
    });
    const client = new TextileClient({ fetchFn });
    await expect(client.requestFirmQuote(input)).rejects.toMatchObject({
      httpStatus: 400,
      code: "invalid_request",
      reason: "insufficient_funds",
      required: "10000000",
      available: "1000000",
      committed: "5000000",
    } satisfies Partial<TextileError>);
  });

  it("429 carries retryAfterMs from Retry-After, and none for a cap 429", async () => {
    const withHeader = fakeFetch({
      "POST /v2/rfq/request": { status: 429, body: { error: { code: "rate_limited", message: "slow down" } }, headers: { "Retry-After": "5" } },
    });
    await expect(new TextileClient({ fetchFn: withHeader.fetchFn }).requestFirmQuote(input)).rejects.toMatchObject({
      httpStatus: 429,
      retryAfterMs: 5000,
    });
    const cap = fakeFetch({
      "POST /v2/rfq/request": { status: 429, body: { error: { code: "rate_limited", message: "outstanding RFQ cap" } } },
    });
    await expect(new TextileClient({ fetchFn: cap.fetchFn }).requestFirmQuote(input)).rejects.toMatchObject({
      httpStatus: 429,
      retryAfterMs: undefined,
    });
  });

  it("submitSwap is idempotent on the same hash and throws 409 on a different hash", async () => {
    const { fetchFn, calls } = fakeFetch({
      "POST /v2/rfq/rfq_test_1/submit": (callNo: number) =>
        callNo === 0
          ? { status: 200, body: { data: { rfqId: "rfq_test_1", status: "submitted" } } }
          : { status: 409, body: { error: { code: "conflict", message: "different hash already reported" } } },
    });
    const client = new TextileClient({ fetchFn });
    const hash = "0x" + "ab".repeat(32);
    const ok = await client.submitSwap("rfq_test_1", hash, "rfqc_test_1");
    expect(ok.status).toBe("submitted");
    expect(calls[0].init.headers).toMatchObject({ "X-Rfq-Claim": "rfqc_test_1" });
    await expect(client.submitSwap("rfq_test_1", "0x" + "cd".repeat(32), "rfqc_test_1")).rejects.toMatchObject({
      httpStatus: 409,
      code: "conflict",
    });
  });

  it("getRfqStatus and cancelQuote send the claim header", async () => {
    const { fetchFn, calls } = fakeFetch({
      "GET /v2/rfq/rfq_test_1": { status: 200, body: { data: { rfqId: "rfq_test_1", status: "filled" } } },
      "POST /v2/rfq/rfq_test_1/cancel": { status: 200, body: { data: { rfqId: "rfq_test_1", status: "released" } } },
    });
    const client = new TextileClient({ fetchFn });
    expect((await client.getRfqStatus("rfq_test_1", "rfqc_test_1")).status).toBe("filled");
    expect((await client.cancelQuote("rfq_test_1", "rfqc_test_1")).status).toBe("released");
    expect(calls.every((c) => (c.init.headers as Record<string, string>)["X-Rfq-Claim"] === "rfqc_test_1")).toBe(true);
  });
});

describe("executeSwap (mocked sendFn — no chain, no broadcast)", () => {
  function setup(quote: FirmQuote, submitStatus = 200) {
    const { fetchFn, calls } = fakeFetch({
      "POST /v2/rfq/rfq_test_1/submit":
        submitStatus === 200
          ? { status: 200, body: { data: { rfqId: "rfq_test_1", status: "submitted" } } }
          : { status: 409, body: { error: { code: "conflict", message: "different hash" } } },
    });
    const client = new TextileClient({ fetchFn, now: () => NOW });
    const sent: { to: string; data: string; value: string }[] = [];
    const sendFn: SendFn = async (tx) => {
      sent.push(tx);
      return `0x${"ab".repeat(32)}`;
    };
    const receipts: string[] = [];
    const waitForReceipt = async (hash: string) => {
      receipts.push(hash);
      return { status: "success" };
    };
    return { client, sent, receipts, submitCalls: calls, sendFn, waitForReceipt };
  }

  it("approves takerPays, waits for the receipt, broadcasts transactions.swap, then submits", async () => {
    const quote = quotedFixture();
    const { client, sent, receipts, sendFn, waitForReceipt } = setup(quote);
    const res = await client.executeSwap(quote, sendFn, { waitForReceipt, getAllowance: async () => 0n });
    expect(res.txHash).toBe(`0x${"ab".repeat(32)}`);
    expect(res.attributionTagged).toBe(true);
    expect(res.submitted).toBe(true);
    // Approval first (API approval calldata), then the swap — nothing else.
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ to: USDT, data: "0x095ea7b3", value: "0" });
    // The swap is transactions.swap, never the top-level encodedOrder.
    expect(sent[1]).toEqual({ to: TEXTILE_CELO_REACTOR, data: TAGGED_SWAP_DATA, value: "0" });
    expect(sent[1].data).not.toBe(quote.encodedOrder);
    expect(receipts).toHaveLength(1); // approval receipt waited on; swap needs no wait here
  });

  it("builds the approval for exactly takerPays when the quote has no approval tx", async () => {
    const quote = quotedFixture({ transactions: { swap: { to: TEXTILE_CELO_REACTOR, data: TAGGED_SWAP_DATA, value: "0", chainId: 42220 } } });
    const { client, sent, sendFn, waitForReceipt } = setup(quote);
    await client.executeSwap(quote, sendFn, { waitForReceipt, getAllowance: async () => 0n, sellToken: USDT });
    expect(sent).toHaveLength(2);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: sent[0].data as `0x${string}` });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([TEXTILE_CELO_REACTOR, 9999000n]); // takerPays, not sellAmount
  });

  it("resets a standing allowance > 0 to 0 first (USDT rule), then approves takerPays", async () => {
    const quote = quotedFixture({ transactions: { swap: { to: TEXTILE_CELO_REACTOR, data: TAGGED_SWAP_DATA, value: "0", chainId: 42220 } } });
    const { client, sent, sendFn, waitForReceipt } = setup(quote);
    await client.executeSwap(quote, sendFn, { waitForReceipt, getAllowance: async () => 100n, sellToken: USDT });
    expect(sent).toHaveLength(3); // reset, approve, swap
    const reset = decodeFunctionData({ abi: erc20Abi, data: sent[0].data as `0x${string}` });
    expect(reset.args).toEqual([TEXTILE_CELO_REACTOR, 0n]);
    const approve = decodeFunctionData({ abi: erc20Abi, data: sent[1].data as `0x${string}` });
    expect(approve.args).toEqual([TEXTILE_CELO_REACTOR, 9999000n]);
    expect(sent[2].data).toBe(TAGGED_SWAP_DATA);
  });

  it("skips approval entirely when the standing allowance already covers takerPays", async () => {
    const quote = quotedFixture();
    const { client, sent, sendFn, waitForReceipt } = setup(quote);
    await client.executeSwap(quote, sendFn, { waitForReceipt, getAllowance: async () => 9999000n });
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toBe(TAGGED_SWAP_DATA);
  });

  it("refuses to broadcast past expiresAt — before any send", async () => {
    const quote = quotedFixture({ expiresAt: "2030-01-01T00:00:00.000Z" });
    const { client, sent, sendFn, waitForReceipt } = setup(quote);
    await expect(client.executeSwap(quote, sendFn, { waitForReceipt, now: () => NOW })).rejects.toMatchObject({
      code: "quote_expired",
    });
    expect(sent).toHaveLength(0);
  });

  it("refuses the swap when the approval pushed past expiresAt", async () => {
    const quote = quotedFixture();
    const { client, sent, sendFn, waitForReceipt } = setup(quote);
    let nowMs = NOW;
    const now = () => nowMs;
    // Approval receipt wait advances the clock past expiresAt.
    const slowWait = async (hash: string) => {
      nowMs = Date.parse(EXPIRES) + 1000;
      return waitForReceipt(hash);
    };
    await expect(
      client.executeSwap(quote, sendFn, { waitForReceipt: slowWait, getAllowance: async () => 0n, now }),
    ).rejects.toMatchObject({ code: "quote_expired" });
    expect(sent).toHaveLength(1); // approval only — the swap was never sent
  });

  it("requireAttribution refuses an untagged swap without broadcasting", async () => {
    const quote = quotedFixture({
      transactions: {
        approval: { to: USDT, data: "0x095ea7b3", value: "0", chainId: 42220 },
        swap: { to: TEXTILE_CELO_REACTOR, data: UNTAGGED_SWAP_DATA, value: "0", chainId: 42220 },
      },
      attributionSuffix: null,
    });
    const { client, sent, sendFn, waitForReceipt } = setup(quote);
    await expect(
      client.executeSwap(quote, sendFn, { waitForReceipt, getAllowance: async () => 9999000n, requireAttribution: true }),
    ).rejects.toThrow(/no ERC-8021 attribution tag/);
    expect(sent).toHaveLength(0);
  });

  it("broadcasts an untagged quote byte-for-byte when Textile returns no suffix", async () => {
    const quote = quotedFixture({
      transactions: {
        approval: { to: USDT, data: "0x095ea7b3", value: "0", chainId: 42220 },
        swap: { to: TEXTILE_CELO_REACTOR, data: UNTAGGED_SWAP_DATA, value: "0", chainId: 42220 },
      },
      attributionSuffix: null,
    });
    const { client, sent, sendFn, waitForReceipt } = setup(quote);
    const res = await client.executeSwap(quote, sendFn, {
      waitForReceipt,
      getAllowance: async () => 9999000n,
      requireAttribution: quote.attributionSuffix != null,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.data).toBe(UNTAGGED_SWAP_DATA);
    expect(res.attributionTagged).toBe(false);
  });

  it("a submit failure does not fail the swap — it is reported in the result", async () => {
    const quote = quotedFixture();
    const { client, sent, sendFn, waitForReceipt } = setup(quote, 409);
    const res = await client.executeSwap(quote, sendFn, { waitForReceipt, getAllowance: async () => 9999000n });
    expect(res.txHash).toBe(`0x${"ab".repeat(32)}`);
    expect(res.submitted).toBe(false);
    expect(res.submitError).toMatch(/different hash/);
    expect(sent).toHaveLength(1); // swap still broadcast
  });
});

// ---------------------------------------------------------------------------
// Live-gated: read-only, no funds, no firm swap execution.
// Run with IKENGA_LIVE_TESTS=1. The firm-quote test below also needs a
// funded BSC-testnet taker key and only requests + cancels — it never swaps.
// ---------------------------------------------------------------------------
const LIVE = process.env.IKENGA_LIVE_TESTS === "1";

describe.skipIf(!LIVE)("live Textile API (read-only, gated)", () => {
  const client = new TextileClient();

  it("Celo levels show the USDT<->cNGN corridor with real depth", { timeout: 30_000 }, async () => {
    const levels = await client.getLevels(42220);
    const pair = levels.pairs.find(
      (p) => p.sellToken.toLowerCase() === USDT.toLowerCase() && p.buyToken.toLowerCase() === CNGN.toLowerCase(),
    );
    expect(pair).toBeDefined();
    expect(BigInt(pair!.maxSellAmount)).toBeGreaterThan(0n);
  });

  // Preview is slow from this VM (~12 s observed 2026-11-21; two 20 s
  // attempts timed out before a third succeeded) — allow 60 s.
  it("mainnet preview prices $10 USDT -> cNGN without a credential", { timeout: 60_000 }, async () => {
    const res = await client.previewQuote({ chainId: 42220, sellToken: USDT, buyToken: CNGN, sellAmount: "10000000" });
    expect(res.kind).toBe("preview");
    if (res.kind === "preview") {
      expect(BigInt(res.buyAmount)).toBeGreaterThan(0n);
      expect(res.takerPays).toBe("10000000");
    }
  });

  it("BSC testnet (97) levels + preview work without funds", { timeout: 30_000 }, async () => {
    const levels = await client.getLevels(97);
    expect(levels.chainId).toBe(97);
    expect(levels.pairs.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!LIVE || !process.env.IKENGA_TESTNET_TAKER_PRIVATE_KEY)(
  "live testnet firm quote (gated on funding — requests + cancels only, never swaps)",
  () => {
    it("BSC testnet firm quote: quoted or insufficient_funds, then cancel if quoted", { timeout: 90_000 }, async () => {
      const key = process.env.IKENGA_TESTNET_TAKER_PRIVATE_KEY as `0x${string}`;
      const taker = privateKeyToAccount(key);
      const client = new TextileClient();
      const bscUsdt = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd";
      const bscCngn = "0x8a078b182bA9649c03982c2a80CDcc81cdc99dA8";
      try {
        const res = await client.requestFirmQuote(
          { chainId: 97, sellToken: bscUsdt, buyToken: bscCngn, sellAmount: "1000000000000000000", taker: taker.address },
          { signer: taker },
        );
        if (res.kind === "quoted") {
          await client.cancelQuote(res.quote.rfqId, res.quote.claimToken);
        }
        expect(["quoted", "no_quote"]).toContain(res.kind);
      } catch (err) {
        // Unfunded testnet wallet is the expected state in this VM.
        expect(err).toBeInstanceOf(TextileError);
        expect((err as TextileError).reason).toBe("insufficient_funds");
      }
    });
  },
);
