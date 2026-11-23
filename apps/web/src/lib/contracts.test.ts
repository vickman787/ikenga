import { describe, expect, it } from "vitest";
import { decodeAbiParameters, decodeFunctionData, encodeDeployData, encodeFunctionData, parseAbi } from "viem";
import { parseAttribution, stripAttribution } from "@ikenga/payments";
import {
  JOB_ESCROW_BYTECODE,
  fundingTransferCalldata,
  jobEscrowAbi,
  PRICE_ATOMIC,
  tagCalldata,
  taggedFundingTransferCalldata,
  type ChainConfig,
} from "./contracts.js";

const transferAbi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

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
    agentWallet: "0x61aD7AEAC0B94C91B4681d1D8624d82d5DaF4Fc0",
    payTokens: ["USDT"],
    tokens: { USDT: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" },
    vaults: { USDT: "0x1C2b2E64527B0bA7795ed3CDF7d76da51D24018B" },
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
        PRICE_ATOMIC,
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      ],
    });
    const tagged = tagCalldata(data, testChain(TAG));
    expect(tagged.startsWith(data)).toBe(true);
    expect(parseAttribution(tagged)?.codes).toContain(TAG);
  });

  it("a cNGN escrow deploys with the cNGN token and the fixed cNGN price, tagged", () => {
    const cngn = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f";
    const cngnVault = "0x00000000000000000000000000000000000000c1";
    const price = 1_445_000_000n;
    const data = encodeDeployData({
      abi: jobEscrowAbi,
      bytecode: JOB_ESCROW_BYTECODE,
      args: [
        "0x0000000000000000000000000000000000000001",
        cngnVault,
        cngn,
        0n,
        price,
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      ],
    });
    // The constructor args are the last 6 words (192 bytes) of the deploy data.
    const argsData = `0x${data.slice(-384)}` as const;
    const decoded = decodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      argsData,
    );
    expect(decoded[1]?.toLowerCase()).toBe(cngnVault.toLowerCase());
    expect(decoded[2]?.toLowerCase()).toBe(cngn.toLowerCase());
    expect(decoded[3]).toBe(0n); // bond always 0
    expect(decoded[4]).toBe(price); // the fixed cNGN price, not $1 in USDT units
    const tagged = tagCalldata(data, testChain(TAG));
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

describe("funding transfer calldata — the friend pays the bill from their own wallet", () => {
  it("encodes the exact transfer to the agent wallet and the tag parses back off it", () => {
    const chain = testChain(TAG);
    const amount = 3_462_600n;
    const { tagged, codes } = taggedFundingTransferCalldata(chain, amount);
    expect(codes).toContain(TAG);
    expect(parseAttribution(tagged)?.codes).toContain(TAG);
    // Stripping the tag leaves the exact transfer call — the tag changes nothing about the payment.
    const untagged = fundingTransferCalldata(chain, amount);
    expect(tagged.startsWith(untagged)).toBe(true);
    expect(stripAttribution(tagged)).toBe(untagged);
    const decoded = decodeFunctionData({ abi: transferAbi, data: untagged });
    expect(decoded.args[0]?.toLowerCase()).toBe(chain.agentWallet.toLowerCase());
    expect(decoded.args[1]).toBe(amount);
  });

  it("goes through untagged, never blocked, when the server gave no tag", () => {
    const chain = testChain(null);
    const { tagged, codes } = taggedFundingTransferCalldata(chain, 3_462_600n);
    expect(codes).toEqual([]);
    expect(tagged).toBe(fundingTransferCalldata(chain, 3_462_600n));
    expect(parseAttribution(tagged)).toBeNull();
  });
});
