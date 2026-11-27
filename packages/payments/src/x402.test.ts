/**
 * Tests for the real x402 path via the Celo facilitator (Step 2, Workstream A).
 *
 * Layers, cheapest first:
 * 1. Pure: route price config validation (bare "$" rejected, missing
 *    extra.name/version rejected, non-atomic amounts rejected).
 * 2. Mocked facilitator: a fake FacilitatorClient returning / throwing the
 *    exact shapes the real HTTPFacilitatorClient produces, so every failure
 *    mode is surfaced distinctly (invalid signature, insufficient balance,
 *    wrong token, 401 missing key, 402 out of credits, 412 Permit2
 *    allowance, post-sign timeout — the last one is never retried).
 * 3. Real HTTPFacilitatorClient against a local fake HTTP server: proves the
 *    real client parses the real /verify, /settle and /supported envelopes.
 * 4. Buyer side: real x402Client + ExactEvmScheme with a counting signer —
 *    an over-cap payment is blocked BEFORE signing; spendControls:false is
 *    refused; wrapFetchWithPayment retries with the v2 PAYMENT-SIGNATURE
 *    header (not the v1 X-PAYMENT header).
 * 5. Live-gated: Sepolia /supported reachable; one real Sepolia USDC
 *    settlement — skipped unless IKENGA_LIVE_TESTS=1 AND a key, a funded
 *    test wallet and a payee are present. NOT run in this VM.
 *
 * No test here spends money, signs a real payment, or needs an API key.
 */
import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import {
  FacilitatorTimeoutError,
  SettleError,
  VerifyError,
  type PaymentPayload,
  type PaymentRequirements,
  type SupportedResponse,
  type VerifyResponse,
  type SettleResponse,
} from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme, type ClientEvmSigner } from "@x402/evm";
import { x402Client } from "@x402/fetch";
import {
  buildPaymentOption,
  buildRouteConfig,
  CELO_X402_SEPOLIA_NETWORK,
  classifySettleFailure,
  classifyVerifyFailure,
  createAuthHeaders,
  createFacilitatorClient,
  createResourceServer,
  getSupportedKinds,
  settlePayment,
  verifyPayment,
  X402_FACILITATOR_TIMEOUT_MS,
  X402_SUPPORTED_ASSETS,
} from "./x402.js";
import {
  createBuyerClient,
  createPaymentFetch,
  PAYMENT_RETRY_HEADER_V2,
} from "./x402-client.js";

// ---------------------------------------------------------------- fixtures

const SEPOLIA_USDC = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";
const MAINNET_USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const MAINNET_CNGN = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f";
const PAYEE = "0x00000000000000000000000000000000000000Aa";

const sepoliaRequirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:11142220",
  asset: SEPOLIA_USDC,
  amount: "10000", // $0.01 USDC
  payTo: PAYEE,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};

const mainnetUsdtRequirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:42220",
  asset: MAINNET_USDT,
  amount: "1000000", // $1 USDT
  payTo: PAYEE,
  maxTimeoutSeconds: 300,
  extra: { name: "Tether USD", version: "1" },
};

const payload: PaymentPayload = {
  x402Version: 2,
  accepted: sepoliaRequirements,
  payload: {
    authorization: {
      from: "0x00000000000000000000000000000000000000Bb",
      to: PAYEE,
      value: "10000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: "0x1234",
    },
    signature: `0x${"ab".repeat(65)}`,
  },
};

// ------------------------------------------------------- pure: price config

describe("buildPaymentOption", () => {
  it("builds an explicit USDT option with name/version in extra", () => {
    const option = buildPaymentOption({
      payTo: PAYEE,
      price: {
        amount: "1000000",
        asset: MAINNET_USDT,
        extra: { name: "Tether USD", version: "1" },
      },
    });
    expect(option.scheme).toBe("exact");
    expect(option.network).toBe("eip155:42220");
    expect(option.payTo).toBe(PAYEE);
    expect(option.price).toEqual({
      amount: "1000000",
      asset: MAINNET_USDT,
      // assetTransferMethod is filled in from the supported-asset table so
      // the client routes USDT to EIP-3009.
      extra: { name: "Tether USD", version: "1", assetTransferMethod: "eip3009" },
    });
  });

  it("rejects a bare dollar price — it would silently resolve to USDC", () => {
    expect(() =>
      buildPaymentOption({ payTo: PAYEE, price: "$0.01" }),
    ).toThrow(/bare dollar/i);
    expect(() => buildPaymentOption({ payTo: PAYEE, price: "$1" })).toThrow(/bare dollar/i);
  });

  it("rejects any other Money price (number or plain string)", () => {
    expect(() => buildPaymentOption({ payTo: PAYEE, price: 0.01 })).toThrow(/explicit AssetAmount/i);
    expect(() => buildPaymentOption({ payTo: PAYEE, price: "0.01" })).toThrow(
      /explicit AssetAmount/i,
    );
  });

  it("rejects a missing extra.name / extra.version — the EIP-712 domain must match the token", () => {
    const base = { amount: "1000000", asset: MAINNET_USDT };
    expect(() =>
      buildPaymentOption({ payTo: PAYEE, price: { ...base, extra: { version: "1" } } }),
    ).toThrow(/extra\.name/i);
    expect(() =>
      buildPaymentOption({ payTo: PAYEE, price: { ...base, extra: { name: "Tether USD" } } }),
    ).toThrow(/extra\.version/i);
    expect(() =>
      buildPaymentOption({ payTo: PAYEE, price: { ...base, extra: {} } }),
    ).toThrow(/extra\.name/i);
    expect(() => buildPaymentOption({ payTo: PAYEE, price: base })).toThrow(/extra/i);
  });

  it("rejects non-atomic amounts and a bad payee / network", () => {
    const extra = { name: "Tether USD", version: "1" };
    expect(() =>
      buildPaymentOption({
        payTo: PAYEE,
        price: { amount: "1.5", asset: MAINNET_USDT, extra },
      }),
    ).toThrow(/atomic/i);
    expect(() =>
      buildPaymentOption({
        payTo: PAYEE,
        price: { amount: "-5", asset: MAINNET_USDT, extra },
      }),
    ).toThrow(/atomic/i);
    expect(() =>
      buildPaymentOption({
        payTo: "not-an-address",
        price: { amount: "1000000", asset: MAINNET_USDT, extra },
      }),
    ).toThrow(/payTo/i);
    expect(() =>
      buildPaymentOption({
        payTo: PAYEE,
        network: "eip155:1",
        price: { amount: "1000000", asset: MAINNET_USDT, extra },
      }),
    ).toThrow(/network/i);
  });

  it("rejects gas sponsoring for cNGN — cNGN has no EIP-2612 permit()", () => {
    expect(() =>
      buildPaymentOption({
        payTo: PAYEE,
        price: {
          amount: "1000000",
          asset: MAINNET_CNGN,
          extra: { name: "cNGN", version: "1", assetTransferMethod: "permit2" },
        },
        gasSponsoring: true,
      }),
    ).toThrow(/cNGN.*EIP-2612|EIP-2612.*cNGN/i);
  });
});

describe("buildRouteConfig", () => {
  const price = {
    amount: "10000",
    asset: SEPOLIA_USDC,
    extra: { name: "USDC", version: "2" },
  };

  it("builds a Hono route key with the payment option", () => {
    const routes = buildRouteConfig({
      method: "GET",
      path: "/api/tools/quote",
      payTo: PAYEE,
      price,
      network: "eip155:11142220",
    });
    const route = routes["GET /api/tools/quote"];
    expect(route).toBeDefined();
    const accepts = Array.isArray(route!.accepts) ? route!.accepts : [route!.accepts];
    expect(accepts).toHaveLength(1);
    expect(accepts[0]!.price).toEqual({
      ...price,
      extra: { ...price.extra, assetTransferMethod: "eip3009" },
    });
  });

  it("declares the builder-code extension when a tag is given, and eip2612 sponsoring for USDC", () => {
    const routes = buildRouteConfig({
      method: "GET",
      path: "/api/tools/quote",
      payTo: PAYEE,
      price,
      network: "eip155:11142220",
      attributionTag: "celo_0123456789ab",
    });
    const ext = routes["GET /api/tools/quote"]!.extensions ?? {};
    expect(ext["builder-code"]).toBeDefined();
    expect(Object.keys(ext).some((k) => k.toLowerCase().includes("eip2612"))).toBe(true);
  });

  it("does NOT declare eip2612 sponsoring for a cNGN route", () => {
    const routes = buildRouteConfig({
      method: "POST",
      path: "/api/tools/pay-cngn",
      payTo: PAYEE,
      price: {
        amount: "1000000",
        asset: MAINNET_CNGN,
        extra: { name: "cNGN", version: "1", assetTransferMethod: "permit2" },
      },
    });
    const ext = routes["POST /api/tools/pay-cngn"]!.extensions ?? {};
    expect(Object.keys(ext).some((k) => k.toLowerCase().includes("eip2612"))).toBe(false);
  });
});

describe("supported assets (verified live against the facilitator 2026-11-21)", () => {
  it("lists mainnet USDC/USDT/USAT (EIP-3009) + 7 Permit2 assets, and Sepolia USDC only", () => {
    const mainnet = X402_SUPPORTED_ASSETS.filter((a) => a.network === "eip155:42220");
    expect(mainnet.map((a) => a.symbol).sort()).toEqual(
      ["USDC", "USDT", "USAT", "cNGN", "wARS", "wBRL", "wCLP", "wCOP", "wMXN", "wPEN"].sort(),
    );
    expect(mainnet.filter((a) => a.transferMethod === "eip3009").map((a) => a.symbol).sort()).toEqual(
      ["USAT", "USDC", "USDT"],
    );
    expect(mainnet.find((a) => a.symbol === "USDT")).toMatchObject({
      asset: MAINNET_USDT,
      name: "Tether USD",
      version: "1",
      decimals: 6,
    });
    expect(mainnet.find((a) => a.symbol === "cNGN")).toMatchObject({
      asset: MAINNET_CNGN,
      name: "cNGN",
      version: "1",
      decimals: 6,
      transferMethod: "permit2",
    });
    const sepolia = X402_SUPPORTED_ASSETS.filter((a) => a.network === "eip155:11142220");
    expect(sepolia.map((a) => a.symbol)).toEqual(["USDC"]);
    expect(sepolia[0]!.asset).toBe(SEPOLIA_USDC);
  });
});

describe("createFacilitatorClient / createAuthHeaders", () => {
  it("defaults to the mainnet facilitator with a 30 s timeout", () => {
    const client = createFacilitatorClient();
    expect(client.url).toBe("https://api.x402.celo.org");
    expect(client.timeoutMs).toBe(X402_FACILITATOR_TIMEOUT_MS);
    expect(X402_FACILITATOR_TIMEOUT_MS).toBe(30_000);
  });

  it("uses the Sepolia facilitator for eip155:11142220 and honours X402_FACILITATOR_URL", () => {
    expect(createFacilitatorClient({ network: CELO_X402_SEPOLIA_NETWORK }).url).toBe(
      "https://api.x402.sepolia.celo.org",
    );
    expect(
      createFacilitatorClient({ url: "https://example.invalid/facilitator" }).url,
    ).toBe("https://example.invalid/facilitator");
  });

  it("createAuthHeaders puts the key under X-API-Key on the settle path only", async () => {
    const auth = createAuthHeaders("x402_test_key");
    const settle = await auth();
    expect(settle.settle).toEqual({ "X-API-Key": "x402_test_key" });
    expect(settle.verify).toBeUndefined();
    expect(settle.supported).toBeUndefined();
  });

  it("createResourceServer registers the exact scheme for the network", () => {
    const server = createResourceServer(createFacilitatorClient(), {
      network: "eip155:11142220",
    });
    expect(server.hasRegisteredScheme("eip155:11142220", "exact")).toBe(true);
  });
});

// ------------------------------------------------- mocked facilitator client

class FakeFacilitator implements FacilitatorClient {
  verifyMode: "valid" | "invalid-signature" | "insufficient" | "wrong-token" | "throw-verify" =
    "valid";
  settleMode: "success" | "401" | "402" | "412" | "timeout" = "success";
  verifyCalls = 0;
  settleCalls = 0;

  async verify(
    _payload: PaymentPayload,
    _req: PaymentRequirements,
  ): Promise<VerifyResponse> {
    this.verifyCalls++;
    switch (this.verifyMode) {
      case "valid":
        return { isValid: true, payer: "0x00000000000000000000000000000000000000Bb" };
      case "invalid-signature":
        return { isValid: false, invalidReason: "invalid_exact_evm_signature" };
      case "insufficient":
        return { isValid: false, invalidReason: "invalid_exact_evm_insufficient_balance" };
      case "wrong-token":
        return { isValid: false, invalidReason: "invalid_token" };
      case "throw-verify":
        throw new VerifyError(402, {
          isValid: false,
          invalidReason: "invalid_exact_evm_signature",
        });
    }
  }

  async settle(
    _payload: PaymentPayload,
    _req: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.settleCalls++;
    switch (this.settleMode) {
      case "success":
        return {
          success: true,
          transaction: "0xsettle00000000000000000000000000000000000000000000000000000000",
          network: "eip155:11142220",
        };
      case "401":
        throw new SettleError(401, {
          success: false,
          errorReason: "unauthorized",
          transaction: "",
          network: "eip155:11142220",
        });
      case "402":
        throw new SettleError(402, {
          success: false,
          errorReason: "insufficient_credits",
          transaction: "",
          network: "eip155:11142220",
        });
      case "412":
        throw new SettleError(412, {
          success: false,
          errorReason: "permit2_allowance_required",
          transaction: "",
          network: "eip155:11142220",
        });
      case "timeout":
        throw new FacilitatorTimeoutError("settle", 30_000);
    }
  }

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [
        { x402Version: 2, scheme: "exact", network: "eip155:11142220", extra: {} },
      ],
      extensions: ["eip2612GasSponsoring"],
      signers: {},
    };
  }
}

describe("verifyPayment / settlePayment against a mocked facilitator", () => {
  it("verify: valid payload verifies with the payer", async () => {
    const fake = new FakeFacilitator();
    const res = await verifyPayment(payload, sepoliaRequirements, fake);
    expect(res).toEqual({ ok: true, payer: "0x00000000000000000000000000000000000000Bb" });
    expect(fake.verifyCalls).toBe(1);
  });

  it("verify: invalid signature, insufficient balance and wrong token are distinct", async () => {
    const fake = new FakeFacilitator();
    fake.verifyMode = "invalid-signature";
    await expect(verifyPayment(payload, sepoliaRequirements, fake)).resolves.toMatchObject({
      ok: false,
      reason: "invalid_signature",
    });
    fake.verifyMode = "insufficient";
    await expect(verifyPayment(payload, sepoliaRequirements, fake)).resolves.toMatchObject({
      ok: false,
      reason: "insufficient_balance",
    });
    fake.verifyMode = "wrong-token";
    await expect(verifyPayment(payload, sepoliaRequirements, fake)).resolves.toMatchObject({
      ok: false,
      reason: "wrong_token",
    });
  });

  it("verify: a thrown VerifyError is classified the same way", async () => {
    const fake = new FakeFacilitator();
    fake.verifyMode = "throw-verify";
    await expect(verifyPayment(payload, sepoliaRequirements, fake)).resolves.toMatchObject({
      ok: false,
      reason: "invalid_signature",
    });
    expect(classifyVerifyFailure(new VerifyError(402, { isValid: false }))).toMatchObject({
      reason: "unknown",
    });
  });

  it("settle: success returns the transaction hash", async () => {
    const fake = new FakeFacilitator();
    const res = await settlePayment(payload, sepoliaRequirements, fake);
    expect(res).toMatchObject({
      ok: true,
      transaction: expect.stringMatching(/^0xsettle/),
      network: "eip155:11142220",
    });
    expect(fake.settleCalls).toBe(1);
  });

  it("settle: 401 / 402 / 412 are surfaced distinctly", async () => {
    const fake = new FakeFacilitator();
    fake.settleMode = "401";
    await expect(settlePayment(payload, sepoliaRequirements, fake)).resolves.toMatchObject({
      ok: false,
      reason: "missing_api_key",
      statusCode: 401,
    });
    fake.settleMode = "402";
    await expect(settlePayment(payload, sepoliaRequirements, fake)).resolves.toMatchObject({
      ok: false,
      reason: "insufficient_credits",
      statusCode: 402,
    });
    fake.settleMode = "412";
    await expect(settlePayment(payload, sepoliaRequirements, fake)).resolves.toMatchObject({
      ok: false,
      reason: "permit2_allowance_required",
      statusCode: 412,
    });
    expect(
      classifySettleFailure(new SettleError(402, { success: false, transaction: "", network: "eip155:42220" })),
    ).toMatchObject({ reason: "insufficient_credits" });
  });

  it("settle: a post-sign timeout is ambiguous and is called exactly once (never retried)", async () => {
    const fake = new FakeFacilitator();
    fake.settleMode = "timeout";
    const res = await settlePayment(payload, sepoliaRequirements, fake);
    expect(res).toMatchObject({ ok: false, reason: "timeout", ambiguous: true });
    expect(fake.settleCalls).toBe(1);
  });

  it("getSupportedKinds returns the facilitator kinds", async () => {
    const fake = new FakeFacilitator();
    const kinds = await getSupportedKinds(fake);
    expect(kinds[0]).toMatchObject({ scheme: "exact", network: "eip155:11142220" });
  });
});

// --------------------------- real HTTPFacilitatorClient with mocked transport

describe("real HTTPFacilitatorClient with a mocked fetch transport", () => {
  const baseUrl = "https://facilitator.test";
  // Scriptable behaviour: each test configures the same HTTP response the
  // facilitator would send. The real x402 client still builds and parses the
  // request; replacing fetch keeps these tests independent of loopback access.
  let verifyStatus = 200;
  let verifyBody: Record<string, unknown> = { isValid: true, payer: PAYEE };
  let settleStatus = 200;
  let settleBody: Record<string, unknown> = {
    success: true,
    transaction: "0xlocalsettle00000000000000000000000000000000000000000000000000",
    network: "eip155:11142220",
  };
  let seenAuthHeader: string | undefined;
  let seenPaths: string[] = [];
  let seenBodies: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    verifyStatus = 200;
    verifyBody = { isValid: true, payer: PAYEE };
    settleStatus = 200;
    settleBody = {
      success: true,
      transaction: "0xlocalsettle00000000000000000000000000000000000000000000000000",
      network: "eip155:11142220",
    };
    seenAuthHeader = undefined;
    seenPaths = [];
    seenBodies = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const path = url.pathname;
      seenPaths.push(path);
      seenAuthHeader = new Headers(init?.headers).get("x-api-key") ?? undefined;
      if (typeof init?.body === "string") seenBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      const status = path === "/verify" ? verifyStatus : path === "/settle" ? settleStatus : 200;
      const payloadBody = path === "/verify" ? verifyBody : path === "/settle" ? settleBody : {
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:11142220", extra: {} }],
        extensions: [],
        signers: {},
      };
      return new Response(JSON.stringify(payloadBody), {
        status,
        headers: { "content-type": "application/json" },
      });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("/verify valid and /supported reachable through the real client", async () => {
    verifyStatus = 200;
    verifyBody = { isValid: true, payer: PAYEE };
    const client = createFacilitatorClient({ url: baseUrl });
    const res = await verifyPayment(payload, sepoliaRequirements, client);
    expect(res).toEqual({ ok: true, payer: PAYEE });
    const kinds = await getSupportedKinds(client);
    expect(kinds[0]).toMatchObject({ scheme: "exact", network: "eip155:11142220" });
    expect(seenPaths).toContain("/verify");
    expect(seenPaths).toContain("/supported");
    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0]).toMatchObject({
      x402Version: 2,
      paymentPayload: expect.any(Object),
      paymentRequirements: expect.any(Object),
    });
  });

  it("/verify invalid (200, isValid:false) and /settle 402 map distinctly", async () => {
    verifyStatus = 200;
    verifyBody = { isValid: false, invalidReason: "invalid_exact_evm_insufficient_balance" };
    settleStatus = 402;
    settleBody = {
      success: false,
      errorReason: "insufficient_credits",
      transaction: "",
      network: "eip155:11142220",
    };
    const client = createFacilitatorClient({ url: baseUrl });
    await expect(verifyPayment(payload, sepoliaRequirements, client)).resolves.toMatchObject({
      ok: false,
      reason: "insufficient_balance",
    });
    await expect(settlePayment(payload, sepoliaRequirements, client)).resolves.toMatchObject({
      ok: false,
      reason: "insufficient_credits",
      statusCode: 402,
    });
    expect(seenBodies).toHaveLength(2);
  });

  it("the API key is sent as X-API-Key on /settle", async () => {
    settleStatus = 200;
    settleBody = {
      success: true,
      transaction: "0xlocalsettle00000000000000000000000000000000000000000000000000",
      network: "eip155:11142220",
    };
    seenAuthHeader = undefined;
    const client = createFacilitatorClient({ url: baseUrl, apiKey: "x402_local_key" });
    await settlePayment(payload, sepoliaRequirements, client);
    expect(seenAuthHeader).toBe("x402_local_key");
    expect(seenPaths).toContain("/settle");
  });
});

// ------------------------------------------------------------------ buyer side

function countingSigner(): ClientEvmSigner & { calls: number } {
  const signer = {
    calls: 0,
    address: "0x00000000000000000000000000000000000000Bb" as `0x${string}`,
    async signTypedData(_message: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`> {
      signer.calls++;
      return `0x${"ab".repeat(65)}` as `0x${string}`;
    },
  };
  return signer;
}

describe("buyer client (x402-client)", () => {
  it("uses PAYMENT-SIGNATURE for v2 retries — X-PAYMENT is the v1 header", () => {
    // Verified against the installed @x402 2.32.0: encodePaymentSignatureHeader
    // emits PAYMENT-SIGNATURE for x402Version 2 and X-PAYMENT for v1.
    expect(PAYMENT_RETRY_HEADER_V2).toBe("PAYMENT-SIGNATURE");
  });

  it("blocks an over-cap payment BEFORE signing (default $1 cap)", async () => {
    const signer = countingSigner();
    const client = createBuyerClient({
      signer,
      network: "eip155:11142220",
      rpcUrl: "https://forno.celo-sepolia.celo-testnet.org",
    });
    const overCap = {
      x402Version: 2,
      resource: { url: "https://example.invalid/tool" },
      accepts: [{ ...sepoliaRequirements, amount: "2000000" }], // $2 > $1 cap
    };
    await expect(client.createPaymentPayload(overCap)).rejects.toThrow(/spendControls/i);
    expect(signer.calls).toBe(0);
  });

  it("signs an under-cap payment exactly once", async () => {
    const signer = countingSigner();
    const client = createBuyerClient({
      signer,
      network: "eip155:11142220",
      rpcUrl: "https://forno.celo-sepolia.celo-testnet.org",
    });
    const underCap = {
      x402Version: 2,
      resource: { url: "https://example.invalid/tool" },
      accepts: [sepoliaRequirements],
    };
    const result = await client.createPaymentPayload(underCap);
    expect(signer.calls).toBe(1);
    expect(result.x402Version).toBe(2);
    expect(result.accepted.amount).toBe("10000");
    const auth = result.payload.authorization as Record<string, unknown>;
    expect(auth.value).toBe("10000");
    // The scheme returns the checksummed payee; compare case-insensitively.
    expect(String(auth.to).toLowerCase()).toBe(PAYEE.toLowerCase());
  });

  it("refuses spendControls:false — spend controls are never disabled", () => {
    const signer = countingSigner();
    expect(() =>
      createBuyerClient({
        signer,
        network: "eip155:11142220",
        // @ts-expect-error deliberate: false must be rejected at runtime
        spendControls: false,
      }),
    ).toThrow(/spendControls.*false|never.*disabled/i);
  });

  it("wrapFetchWithPayment pays a 402 and retries with PAYMENT-SIGNATURE", async () => {
    const signer = countingSigner();
    const client = createBuyerClient({
      signer,
      network: "eip155:11142220",
      rpcUrl: "https://forno.celo-sepolia.celo-testnet.org",
    });
    const paymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.invalid/tool" },
      accepts: [sepoliaRequirements],
    };
    const b64 = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");
    const seenHeaders: Array<Record<string, string>> = [];
    let calls = 0;
    const stubFetch = async (input: unknown): Promise<Response> => {
      calls++;
      const req = input as Request;
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      seenHeaders.push(headers);
      if (calls === 1) {
        return new Response("{}", {
          status: 402,
          headers: { "payment-required": b64 },
        });
      }
      return new Response(JSON.stringify({ paid: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const fetchWithPay = createPaymentFetch(client, stubFetch as typeof fetch);
    const res = await fetchWithPay("https://example.invalid/tool");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paid: true });
    expect(calls).toBe(2);
    expect(signer.calls).toBe(1);
    // The retry carried the v2 header — and NOT the v1 header.
    expect(seenHeaders[1]!["payment-signature"]).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(seenHeaders[1]!["x-payment"]).toBeUndefined();
    const decoded = JSON.parse(
      Buffer.from(seenHeaders[1]!["payment-signature"]!, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    expect(decoded.x402Version).toBe(2);
  });
});

// ------------------------------------------------------------- live-gated

const LIVE = process.env.IKENGA_LIVE_TESTS === "1";
const CAN_SETTLE =
  LIVE &&
  !!process.env.X402_API_KEY &&
  !!process.env.IKENGA_TEST_PRIVATE_KEY &&
  !!process.env.IKENGA_LIVE_PAY_TO;

describe.skipIf(!LIVE)("live facilitator (gated: IKENGA_LIVE_TESTS=1)", () => {
  it("Sepolia /supported is reachable and lists USDC only", async () => {
    const client = createFacilitatorClient({ network: CELO_X402_SEPOLIA_NETWORK });
    const kinds = await getSupportedKinds(client);
    const v2 = kinds.find((k) => k.x402Version === 2 && k.network === "eip155:11142220");
    expect(v2).toBeDefined();
    const assets = (v2!.extra?.supportedAssets as Array<Record<string, unknown>>) ?? [];
    expect(assets.map((a) => a.symbol)).toEqual(["USDC"]);
  });
});

describe.skipIf(!CAN_SETTLE)(
  "live Sepolia USDC settlement (gated: key + funded wallet + payee)",
  () => {
    it("settles $0.01 Sepolia USDC and returns a tx hash", async () => {
      const { privateKeyToAccount } = await import("viem/accounts");
      const { toClientEvmSigner } = await import("@x402/evm");
      const account = privateKeyToAccount(
        process.env.IKENGA_TEST_PRIVATE_KEY as `0x${string}`,
      );
      const signer = toClientEvmSigner(account);
      const buyer = createBuyerClient({
        signer,
        network: "eip155:11142220",
        rpcUrl: "https://forno.celo-sepolia.celo-testnet.org",
      });
      const requirements: PaymentRequirements = {
        ...sepoliaRequirements,
        payTo: process.env.IKENGA_LIVE_PAY_TO!,
      };
      const made = await buyer.createPaymentPayload({
        x402Version: 2,
        resource: { url: "https://example.invalid/live-test" },
        accepts: [requirements],
      });
      const verified = await verifyPayment(made, requirements);
      expect(verified.ok).toBe(true);
      const settled = await settlePayment(made, requirements);
      expect(settled.ok).toBe(true);
      if (settled.ok) expect(settled.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);
    });
  },
);
