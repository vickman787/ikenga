/**
 * Boss worker config — pure parts only (no chain, no site, no keys
 * leave this file): .env parsing, config resolution, and picking the
 * deliverable content out of a stored report. The live passes are
 * proven by the Sepolia end-to-end run, not by unit tests.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAINNET_TOKEN_ADDRESS,
  MAINNET_VAULT_ADDRESS,
  loadEnvFile,
  parseEnvFile,
  reportToDeliverableContent,
  resolveBossConfig,
} from "./boss-worker.js";

const BOSS_KEY = `0x${"1".repeat(64)}`;

describe("parseEnvFile", () => {
  it("parses KEY=VALUE, skips comments and blanks, strips export and quotes", () => {
    const parsed = parseEnvFile(
      [
        "# a comment",
        "",
        "IKENGA_CHAIN=sepolia",
        "export IKENGA_BOSS_PRIVATE_KEY=0xabc",
        'IKENGA_ATTRIBUTION_TAG="celo_5144280c393f"',
        "IKENGA_SITE_URL='http://localhost:3000'",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      IKENGA_CHAIN: "sepolia",
      IKENGA_BOSS_PRIVATE_KEY: "0xabc",
      IKENGA_ATTRIBUTION_TAG: "celo_5144280c393f",
      IKENGA_SITE_URL: "http://localhost:3000",
    });
  });

  it("never includes a key for a line without =", () => {
    expect(parseEnvFile("JUSTAKEY\nA=1")).toEqual({ A: "1" });
  });
});

describe("resolveBossConfig", () => {
  const base = {
    IKENGA_BOSS_PRIVATE_KEY: BOSS_KEY,
    IKENGA_ATTRIBUTION_TAG: "celo_5144280c393f",
  };

  it("mainnet defaults to the deployed vault, token and Ankr RPC", () => {
    const config = resolveBossConfig({ ...base });
    expect(config.chain).toBe("mainnet");
    expect(config.chainId).toBe(42220);
    expect(config.vaultAddress).toBe(MAINNET_VAULT_ADDRESS);
    expect(config.tokenAddress).toBe(MAINNET_TOKEN_ADDRESS);
    expect(config.rpcUrl).toBe("https://rpc.ankr.com/celo");
    expect(config.siteUrl).toBe("https://ikenga-two.vercel.app");
  });

  it("sepolia needs both addresses from env — it never guesses them", () => {
    expect(() =>
      resolveBossConfig({ ...base, IKENGA_CHAIN: "sepolia" }),
    ).toThrow(/IKENGA_VAULT_ADDRESS/);
    const config = resolveBossConfig({
      ...base,
      IKENGA_CHAIN: "sepolia",
      IKENGA_VAULT_ADDRESS: "0x1A6d11A97e83f563bdA7811413097212362e0EcD",
      IKENGA_TOKEN_ADDRESS: "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
      IKENGA_SITE_URL: "http://localhost:3000/",
    });
    expect(config.chain).toBe("sepolia");
    expect(config.chainId).toBe(11142220);
    expect(config.rpcUrl).toBe("https://rpc.ankr.com/celo_sepolia");
    expect(config.siteUrl).toBe("http://localhost:3000");
  });

  it("refuses a bad chain, a missing boss key, and a missing tag", () => {
    expect(() => resolveBossConfig({ ...base, IKENGA_CHAIN: "base" })).toThrow(/IKENGA_CHAIN/);
    expect(() => resolveBossConfig({ IKENGA_ATTRIBUTION_TAG: "celo_5144280c393f" })).toThrow(
      /No boss key found/,
    );
    expect(() => resolveBossConfig({ IKENGA_BOSS_PRIVATE_KEY: "not-a-key" })).toThrow(
      /No boss key found/,
    );
    expect(() => resolveBossConfig({ IKENGA_BOSS_PRIVATE_KEY: BOSS_KEY })).toThrow(
      /IKENGA_ATTRIBUTION_TAG/,
    );
  });

  it("falls back to the agent key on mainnet and the test key on sepolia", () => {
    const mainnet = resolveBossConfig({
      IKENGA_AGENT_PRIVATE_KEY: BOSS_KEY,
      IKENGA_ATTRIBUTION_TAG: "celo_5144280c393f",
    });
    expect(mainnet.bossPrivateKey).toBe(BOSS_KEY);
    const sepolia = resolveBossConfig({
      IKENGA_CHAIN: "sepolia",
      IKENGA_TEST_PRIVATE_KEY: BOSS_KEY,
      IKENGA_ATTRIBUTION_TAG: "celo_5144280c393f",
      IKENGA_VAULT_ADDRESS: "0x1A6d11A97e83f563bdA7811413097212362e0EcD",
      IKENGA_TOKEN_ADDRESS: "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
    });
    expect(sepolia.bossPrivateKey).toBe(BOSS_KEY);
    // An explicit boss key always wins over the fallback.
    const explicit = resolveBossConfig({
      IKENGA_CHAIN: "sepolia",
      IKENGA_BOSS_PRIVATE_KEY: `0x${"2".repeat(64)}`,
      IKENGA_TEST_PRIVATE_KEY: BOSS_KEY,
      IKENGA_ATTRIBUTION_TAG: "celo_5144280c393f",
      IKENGA_VAULT_ADDRESS: "0x1A6d11A97e83f563bdA7811413097212362e0EcD",
      IKENGA_TOKEN_ADDRESS: "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
    });
    expect(explicit.bossPrivateKey).toBe(`0x${"2".repeat(64)}`);
  });
});

describe("loadEnvFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ikenga-boss-env-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fills missing vars from IKENGA_ENV_FILE and never overrides existing env", () => {
    const file = join(dir, ".env");
    writeFileSync(file, "IKENGA_BOSS_PRIVATE_KEY=0xaaa\nIKENGA_ATTRIBUTION_TAG=celo_5144280c393f\n");
    const env: NodeJS.ProcessEnv = { IKENGA_ATTRIBUTION_TAG: "celo_000000000000", IKENGA_ENV_FILE: file };
    loadEnvFile(env);
    expect(env.IKENGA_BOSS_PRIVATE_KEY).toBe("0xaaa");
    expect(env.IKENGA_ATTRIBUTION_TAG).toBe("celo_000000000000");
  });

  it("is silent when no .env exists anywhere", () => {
    const env: NodeJS.ProcessEnv = { IKENGA_ENV_FILE: join(dir, "no-such.env") };
    expect(() => loadEnvFile(env)).not.toThrow();
    expect(env.IKENGA_BOSS_PRIVATE_KEY).toBeUndefined();
  });
});

describe("reportToDeliverableContent", () => {
  it("picks report, html and slides — and null when there is nothing to seal", () => {
    expect(reportToDeliverableContent(null)).toBeNull();
    expect(reportToDeliverableContent({ report: "", html: "", slides: [] })).toBeNull();
    expect(reportToDeliverableContent({ report: "Paystack charges 1.5%." })).toEqual({
      report: "Paystack charges 1.5%.",
    });
    expect(
      reportToDeliverableContent({
        html: "<h1>Ada's Kitchen</h1>",
        slides: [{ title: "Real food", text: "Home cooking." }],
      }),
    ).toEqual({
      html: "<h1>Ada's Kitchen</h1>",
      slides: [{ title: "Real food", text: "Home cooking." }],
    });
  });
});
