import { describe, expect, it } from "vitest";
import { encodeDeployData, encodeFunctionData } from "viem";
import { parseAttribution } from "@ikenga/payments";
import {
  JOB_ESCROW_BYTECODE,
  jobEscrowAbi,
  tagCalldata,
  type ChainConfig,
} from "./contracts.js";

const TAG = "celo_5144280c393f";

function testChain(tag: string | null): ChainConfig {
  return {
    chainId: 42220,
    chainName: "Celo",
    vaultAddress: "0x1C2b2E64527B0bA7795ed3CDF7d76da51D24018B",
    tokenAddress: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
    tokenSymbol: "USDT",
    priceAtomic: "1000000",
    bondAtomic: "0",
    explorerUrl: "https://celoscan.io",
    attributionTag: tag,
  };
}

describe("tagCalldata — the customer's own transactions carry the tag", () => {
  it("sticks the tag on a fund() call without changing the call itself", () => {
    const data = encodeFunctionData({ abi: jobEscrowAbi, functionName: "fund", args: [] });
    const tagged = tagCalldata(data, testChain(TAG));
    expect(tagged.startsWith(data)).toBe(true);
    expect(tagged.slice(0, 10)).toBe(data.slice(0, 10)); // same fund() selector
    const parsed = parseAttribution(tagged);
    expect(parsed?.codes).toContain(TAG);
  });

  it("sticks the tag on an accept() call", () => {
    const data = encodeFunctionData({ abi: jobEscrowAbi, functionName: "accept", args: [] });
    const parsed = parseAttribution(tagCalldata(data, testChain(TAG)));
    expect(parsed?.codes).toContain(TAG);
  });

  it("sticks the tag on an escrow deployment", () => {
    const data = encodeDeployData({
      abi: jobEscrowAbi,
      bytecode: JOB_ESCROW_BYTECODE,
      args: [
        "0x0000000000000000000000000000000000000001",
        "0x1C2b2E64527B0bA7795ed3CDF7d76da51D24018B",
        "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
        0n,
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      ],
    });
    const tagged = tagCalldata(data, testChain(TAG));
    expect(tagged.startsWith(data)).toBe(true);
    expect(parseAttribution(tagged)?.codes).toContain(TAG);
  });

  it("sends the payment untagged — never blocks the job — when the server gave no tag", () => {
    const data = encodeFunctionData({ abi: jobEscrowAbi, functionName: "fund", args: [] });
    expect(tagCalldata(data, testChain(null))).toBe(data);
    expect(parseAttribution(tagCalldata(data, testChain(null)))).toBeNull();
  });

  it("sends the payment untagged when the tag is malformed", () => {
    const data = encodeFunctionData({ abi: jobEscrowAbi, functionName: "fund", args: [] });
    expect(tagCalldata(data, testChain("not-a-tag"))).toBe(data);
  });
});
