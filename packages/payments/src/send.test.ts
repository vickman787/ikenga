/**
 * Tests for sendTagged() — the ONE chokepoint for all of Ikenga's own
 * outbound transactions (Step 2, Workstream A).
 *
 * Covered here (pure, no chain, no network):
 * - the ERC-8021 tag is appended and parseable by @celo/attribution-tags
 * - the original calldata is unchanged (the tag is only a suffix)
 * - a missing/invalid tag throws — never invented, never silently skipped
 * - feeCurrency (CIP-64 stablecoin gas) is passed through untouched
 *
 * The tag under test is a placeholder-shaped code (celo_ + 12 hex chars).
 * It is NOT Ikenga's assigned hackathon code — that code does not exist
 * yet and must come from env IKENGA_ATTRIBUTION_TAG at runtime.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { fromDataSuffix } from "@celo/attribution-tags";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { appendAttribution, isAttributionTag, parseAttribution } from "./attribution.js";
import { sendTagged, type TaggedTxClient } from "./send.js";

const TAG = "celo_0123456789ab";
const CALLDATA = "0x12345678abcdef" as Hex;
const TO = "0x0000000000000000000000000000000000000001" as Address;
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as Address;

let savedTag: string | undefined;

beforeEach(() => {
  savedTag = process.env.IKENGA_ATTRIBUTION_TAG;
});

afterEach(() => {
  if (savedTag === undefined) delete process.env.IKENGA_ATTRIBUTION_TAG;
  else process.env.IKENGA_ATTRIBUTION_TAG = savedTag;
});

describe("isAttributionTag", () => {
  it("accepts celo_ + 12 hex chars and rejects everything else", () => {
    expect(isAttributionTag("celo_0123456789ab")).toBe(true);
    expect(isAttributionTag("celo_0123456789AB")).toBe(true);
    expect(isAttributionTag("celo_ikenga_step1")).toBe(false);
    expect(isAttributionTag("celo_0123456789a")).toBe(false);
    expect(isAttributionTag("celo_0123456789ab12")).toBe(false);
    expect(isAttributionTag("celo_0123456789ag")).toBe(false);
    expect(isAttributionTag("")).toBe(false);
    expect(isAttributionTag("no-tag")).toBe(false);
  });
});

describe("appendAttribution / parseAttribution", () => {
  it("appends a suffix parseable by fromDataSuffix, leaving calldata unchanged", () => {
    const tagged = appendAttribution(CALLDATA, TAG);
    expect(tagged.slice(0, CALLDATA.length)).toBe(CALLDATA);
    expect(tagged.length).toBeGreaterThan(CALLDATA.length);
    const suffix = `0x${tagged.slice(CALLDATA.length)}` as Hex;
    const decoded = fromDataSuffix(suffix);
    expect(decoded).not.toBeNull();
    expect(decoded!.codes).toContain(TAG);
    expect(decoded!.schemaId).toBe(0);
  });

  it("parseAttribution round-trips the tag out of full calldata", () => {
    const tagged = appendAttribution(CALLDATA, TAG);
    const parsed = parseAttribution(tagged);
    expect(parsed).not.toBeNull();
    expect(parsed!.codes).toContain(TAG);
    expect(parsed!.schemaId).toBe(0);
  });

  it("parseAttribution returns null for untagged calldata", () => {
    expect(parseAttribution(CALLDATA)).toBeNull();
    expect(parseAttribution("0x" as Hex)).toBeNull();
  });

  it("appendAttribution rejects a missing or malformed tag", () => {
    expect(() => appendAttribution(CALLDATA, "")).toThrow(/attribution tag/i);
    expect(() => appendAttribution(CALLDATA, "celo_ikenga_step1")).toThrow(/attribution tag/i);
    expect(() => appendAttribution(CALLDATA, "no-tag")).toThrow(/attribution tag/i);
  });

  it("appendAttribution merges with an already-tagged calldata (no double suffix)", () => {
    const once = appendAttribution(CALLDATA, TAG);
    const twice = appendAttribution(once, TAG);
    const parsed = parseAttribution(twice);
    expect(parsed).not.toBeNull();
    expect(parsed!.codes).toEqual([TAG]);
    expect(twice).toBe(once);
  });
});

describe("sendTagged", () => {
  function fakeClient() {
    const seen: Array<{ to: Address; data: Hex; value?: bigint; feeCurrency?: Address }> = [];
    const client: TaggedTxClient = {
      async sendTransaction(args) {
        seen.push(args);
        return "0xhash00000000000000000000000000000000000000000000000000000000" as Hex;
      },
    };
    return { client, seen };
  }

  it("sends tagged calldata with feeCurrency and returns the hash", async () => {
    process.env.IKENGA_ATTRIBUTION_TAG = TAG;
    const { client, seen } = fakeClient();
    const { hash } = await sendTagged(client, {
      to: TO,
      data: CALLDATA,
      value: 0n,
      feeCurrency: USDT,
    });
    expect(hash).toMatch(/^0xhash/);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.to).toBe(TO);
    expect(seen[0]!.feeCurrency).toBe(USDT);
    expect(seen[0]!.value).toBe(0n);
    // Original calldata is a strict prefix of what was sent; the tag parses.
    expect(seen[0]!.data.slice(0, CALLDATA.length)).toBe(CALLDATA);
    const parsed = parseAttribution(seen[0]!.data);
    expect(parsed!.codes).toContain(TAG);
  });

  it("works without feeCurrency (gas then pays in CELO) and without value", async () => {
    process.env.IKENGA_ATTRIBUTION_TAG = TAG;
    const { client, seen } = fakeClient();
    await sendTagged(client, { to: TO, data: CALLDATA });
    expect(seen[0]!.feeCurrency).toBeUndefined();
    expect(seen[0]!.value).toBeUndefined();
  });

  it("throws when no tag is configured — never invents one", async () => {
    delete process.env.IKENGA_ATTRIBUTION_TAG;
    const { client } = fakeClient();
    await expect(sendTagged(client, { to: TO, data: CALLDATA })).rejects.toThrow(
      /IKENGA_ATTRIBUTION_TAG/,
    );
  });

  it("accepts an explicit tag override without env", async () => {
    delete process.env.IKENGA_ATTRIBUTION_TAG;
    const { client, seen } = fakeClient();
    await sendTagged(client, { to: TO, data: CALLDATA }, { attributionTag: TAG });
    expect(parseAttribution(seen[0]!.data)!.codes).toContain(TAG);
  });

  it("rejects an invalid explicit tag", async () => {
    const { client } = fakeClient();
    await expect(
      sendTagged(client, { to: TO, data: CALLDATA }, { attributionTag: "celo_nope" }),
    ).rejects.toThrow(/attribution tag/i);
  });

  it("accepts a real viem celo WalletClient structurally (no network call made)", () => {
    const account = privateKeyToAccount(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
    const wallet = createWalletClient({
      account,
      chain: celo,
      transport: http("https://forno.celo.org"),
    });
    // Type-level: a celo WalletClient must satisfy TaggedTxClient, so the
    // production path can pass its wallet straight into sendTagged().
    const asTagged: TaggedTxClient = wallet;
    expect(typeof asTagged.sendTransaction).toBe("function");
  });
});
