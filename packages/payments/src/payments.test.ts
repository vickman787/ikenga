import { describe, expect, it } from "vitest";
import {
  buildPaymentRequest,
  CELO_MAINNET_CHAIN_ID,
  CELO_TOKENS,
  createFacilitatorClient,
  ERC8004_IDENTITY_REGISTRY,
  sendTagged,
  settlePayment,
  TEXTILE_FX_LIMIT_ORDER_REACTOR,
  verifyPayment,
  verifySelfAgentId,
} from "./index.js";

describe("Celo constants (verified, public addresses)", () => {
  it("uses Celo mainnet chain 42220 and the verified token/reactor addresses", () => {
    expect(CELO_MAINNET_CHAIN_ID).toBe(42220);
    expect(CELO_TOKENS.cNGN.address).toBe("0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f");
    expect(CELO_TOKENS.USDT.address).toBe("0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e");
    expect(TEXTILE_FX_LIMIT_ORDER_REACTOR).toBe("0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3");
    expect(ERC8004_IDENTITY_REGISTRY).toBe("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
  });
});

describe("buildPaymentRequest", () => {
  it("builds a well-formed request on eip155:42220", () => {
    const req = buildPaymentRequest({
      amount: "1000000",
      asset: "USDT",
      payTo: "0x0000000000000000000000000000000000000001",
      attributionTag: "celo_ikenga_step1",
      memo: "job payment",
    });
    expect(req.network).toBe("eip155:42220");
    expect(req.amount).toBe("1000000");
  });

  it("rejects a bad payee, a non-integer amount, and a missing celo_ tag", () => {
    const base = {
      amount: "1000000",
      asset: "USDT" as const,
      payTo: "0x0000000000000000000000000000000000000001",
      attributionTag: "celo_ikenga_step1",
      memo: "x",
    };
    expect(() => buildPaymentRequest({ ...base, payTo: "not-an-address" })).toThrow();
    expect(() => buildPaymentRequest({ ...base, amount: "1.5" })).toThrow();
    expect(() => buildPaymentRequest({ ...base, attributionTag: "no-tag" })).toThrow();
  });
});

describe("Step 2: the money paths are real, not stubs", () => {
  it("verify/settle delegate to the facilitator and sendTagged is exported", async () => {
    // Detailed behaviour lives in x402.test.ts / send.test.ts (mocked
    // facilitator, fake HTTP server, counting signer). Here: the Step 1
    // stubs are gone, the real entry points exist, and the Self gate still
    // defaults closed for an invalid address (live registry reads are
    // covered by the gated tests in self.test.ts).
    expect(typeof verifyPayment).toBe("function");
    expect(typeof settlePayment).toBe("function");
    expect(typeof sendTagged).toBe("function");
    expect(createFacilitatorClient().url).toBe("https://api.x402.celo.org");
    expect((await verifySelfAgentId("not-an-address")).verified).toBe(false);
    expect((await verifySelfAgentId("not-an-address")).reason).toBe("INVALID_ADDRESS");
  });
});
