import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { MemoryLedger, PostgresLedger } from "@ikenga/ledger";
import {
  createHire,
  creativeToProgress,
  deliverableKindFor,
  deliveryStageLabel,
  emptyStoredCreative,
  ESTIMATED_TOOL_COST_USDC,
  getChainConfig,
  getHire,
  getReport,
  HireInputSchema,
  listHires,
  progressToCreative,
  setHireStatus,
  setLedgerForTests,
  setReport,
  summarizeHires,
  type HireResult,
} from "./jobs.js";

describe("HireInputSchema", () => {
  it("accepts a valid hire and rejects a bad wallet", () => {
    expect(
      HireInputSchema.safeParse({
        jobType: "website",
        description: "A site for my shop",
        customerWallet: "0x0000000000000000000000000000000000000001",
      }).success,
    ).toBe(true);
    expect(
      HireInputSchema.safeParse({
        jobType: "website",
        description: "A site",
        customerWallet: "not-a-wallet",
      }).success,
    ).toBe(false);
    expect(
      HireInputSchema.safeParse({ jobType: "rocket", description: "x", customerWallet: "0x0000000000000000000000000000000000000001" })
        .success,
    ).toBe(false);
  });
});

describe("getChainConfig", () => {
  const ENV_KEYS = ["IKENGA_CHAIN", "IKENGA_VAULT_ADDRESS", "IKENGA_TOKEN_ADDRESS", "IKENGA_ATTRIBUTION_TAG"] as const;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
  };
  const restoreEnv = () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };

  it("defaults to Celo mainnet, from contracts/deployments/celo.json", () => {
    setEnv({ IKENGA_CHAIN: undefined, IKENGA_VAULT_ADDRESS: undefined, IKENGA_TOKEN_ADDRESS: undefined, IKENGA_ATTRIBUTION_TAG: undefined });
    try {
      expect(getChainConfig()).toEqual({
        chainId: 42220,
        chainName: "Celo",
        vaultAddress: "0x1C2b2E64527B0bA7795ed3CDF7d76da51D24018B",
        tokenAddress: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
        tokenSymbol: "USDT",
        priceAtomic: "1000000",
        bondAtomic: "0",
        explorerUrl: "https://celoscan.io",
        attributionTag: null,
      });
    } finally {
      restoreEnv();
    }
  });

  it("carries the attribution tag from env, and null when none is set", () => {
    setEnv({ IKENGA_CHAIN: "mainnet", IKENGA_ATTRIBUTION_TAG: "celo_5144280c393f" });
    try {
      expect(getChainConfig().attributionTag).toBe("celo_5144280c393f");
    } finally {
      restoreEnv();
    }
    setEnv({ IKENGA_CHAIN: "mainnet", IKENGA_ATTRIBUTION_TAG: undefined });
    try {
      expect(getChainConfig().attributionTag).toBeNull();
    } finally {
      restoreEnv();
    }
    setEnv({ IKENGA_CHAIN: "mainnet", IKENGA_ATTRIBUTION_TAG: "not-a-tag" });
    try {
      expect(getChainConfig().attributionTag).toBeNull();
    } finally {
      restoreEnv();
    }
  });

  it("lets env override the mainnet vault and token", () => {
    setEnv({
      IKENGA_CHAIN: "mainnet",
      IKENGA_VAULT_ADDRESS: "0x00000000000000000000000000000000000000aa",
      IKENGA_TOKEN_ADDRESS: "0x00000000000000000000000000000000000000bb",
    });
    try {
      const config = getChainConfig();
      expect(config.vaultAddress).toBe("0x00000000000000000000000000000000000000aa");
      expect(config.tokenAddress).toBe("0x00000000000000000000000000000000000000bb");
      expect(config.chainId).toBe(42220);
      expect(config.tokenSymbol).toBe("USDT");
    } finally {
      restoreEnv();
    }
  });

  it("reads Sepolia config from env, and refuses to guess without it", () => {
    setEnv({
      IKENGA_CHAIN: "sepolia",
      IKENGA_VAULT_ADDRESS: "0x1A6d11A97e83f563bdA7811413097212362e0EcD",
      IKENGA_TOKEN_ADDRESS: "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
      IKENGA_ATTRIBUTION_TAG: undefined,
    });
    try {
      expect(getChainConfig()).toEqual({
        chainId: 11142220,
        chainName: "Celo Sepolia",
        vaultAddress: "0x1A6d11A97e83f563bdA7811413097212362e0EcD",
        tokenAddress: "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
        tokenSymbol: "USDC",
        priceAtomic: "1000000",
        bondAtomic: "0",
        explorerUrl: "https://celo-sepolia.blockscout.com",
        attributionTag: null,
      });
    } finally {
      restoreEnv();
    }
    setEnv({ IKENGA_CHAIN: "sepolia", IKENGA_VAULT_ADDRESS: undefined, IKENGA_TOKEN_ADDRESS: undefined });
    try {
      expect(() => getChainConfig()).toThrow(/IKENGA_VAULT_ADDRESS/);
    } finally {
      restoreEnv();
    }
    setEnv({ IKENGA_CHAIN: "nowhere" });
    try {
      expect(() => getChainConfig()).toThrow(/IKENGA_CHAIN/);
    } finally {
      restoreEnv();
    }
  });
});

describe("escrowState on the hire", () => {
  it("follows the job: unfunded once registered, funded once paid, settled once decided", async () => {
    const ledger = new MemoryLedger();
    setLedgerForTests(ledger);
    try {
      const hire = await createHire({
        jobType: "flyers",
        description: "Flyers for a market stall",
        customerWallet: "0x0000000000000000000000000000000000000002",
      });
      expect((await getHire(hire.id))?.escrowState).toBeNull();
      await ledger.updateOrderEscrow(hire.id, { escrowAddress: "0x00000000000000000000000000000000000000aa" });
      expect((await getHire(hire.id))?.escrowState).toBe("unfunded");
      await setHireStatus(hire.id, "escrowed");
      expect((await getHire(hire.id))?.escrowState).toBe("funded");
      await setHireStatus(hire.id, "in-progress");
      expect((await getHire(hire.id))?.escrowState).toBe("funded");
      await setHireStatus(hire.id, "accepted");
      expect((await getHire(hire.id))?.escrowState).toBe("accepted");
      await setHireStatus(hire.id, "refunded");
      expect((await getHire(hire.id))?.escrowState).toBe("rejected");
    } finally {
      setLedgerForTests(new MemoryLedger());
    }
  });
});

describe("createHire (Step 1 hire flow)", () => {
  it("creates a $1 draft order with a CFO quote and a decision hash", async () => {
    const before = (await listHires()).length;
    const hire = await createHire({
      jobType: "flyers",
      description: "Flyers for a market stall",
      customerWallet: "0x0000000000000000000000000000000000000002",
    });
    expect(hire.status).toBe("draft");
    expect(hire.priceUsdc).toBe(1);
    // The bond is 0: the vault's BOND bucket holds no USDT, and a bond
    // above 0 would make JobEscrow.reject() revert (no locked bond to
    // pay), so refunds would be impossible.
    expect(hire.bondUsdc).toBe(0);
    expect(hire.escrowAddress).toBeNull();
    expect(hire.fundTxHash).toBeNull();
    expect(hire.escrowState).toBeNull();
    expect(hire.cfoAccepted).toBe(true);
    expect(hire.decisionHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await listHires()).length).toBe(before + 1);
    expect(await getHire(hire.id)).toMatchObject({ id: hire.id, priceUsdc: 1 });
    expect(await getReport(hire.id)).toBeNull();
    expect(ESTIMATED_TOOL_COST_USDC.flyers).toBe(0.4);
  });

  it("status changes and reports persist through the ledger", async () => {
    const hire = await createHire({
      jobType: "market-report",
      description: "Compare payment options",
      customerWallet: "0x0000000000000000000000000000000000000002",
    });
    await setReport(hire.id, {
      report: "", sources: [], steps: [], totalTokens: 0, totalCostUsd: 0,
      status: "in-progress", revisions: 0, deliveredAt: "", stage: 2,
    });
    expect((await getReport(hire.id))?.stage).toBe(2);
    const updated = await setHireStatus(hire.id, "delivered");
    expect(updated?.status).toBe("delivered");
    expect((await getHire(hire.id))?.status).toBe("delivered");
  });
});

// A real Postgres (not pg-mem): the hire made on one connection must be
// found by a second, fresh connection — the serverless case. Run with:
//   IKENGA_TEST_DATABASE_URL=postgres://ikenga:ikenga@localhost:5433/ikenga pnpm --filter @ikenga/web test
const PG_URL = process.env.IKENGA_TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("Postgres hire/report round-trip (gated: IKENGA_TEST_DATABASE_URL)", () => {
  it("a hire made on one ledger is found by a fresh ledger, with its report", async () => {
    const poolA = new Pool({ connectionString: PG_URL });
    const ledgerA = new PostgresLedger(poolA as never);
    await ledgerA.init();
    setLedgerForTests(ledgerA);
    try {
      const hire = await createHire({
        jobType: "market-report",
        description: "Compare payment options for my shop",
        customerWallet: "0x0000000000000000000000000000000000000004",
      });
      await setReport(hire.id, {
        report: "", sources: [{ title: "Paystack", url: "https://example.com/paystack" }],
        steps: [{ agent: "Scout", what: "Looked things up.", detail: "" }],
        totalTokens: 0, totalCostUsd: 0, status: "in-progress", revisions: 0,
        deliveredAt: "", stage: 2,
        pages: [{ title: "Paystack", url: "https://example.com/paystack", text: "Paystack charges 1.5%." }],
      });
      // Fresh instance: a new pool and a new ledger, no shared memory.
      const poolB = new Pool({ connectionString: PG_URL });
      const ledgerB = new PostgresLedger(poolB as never);
      await ledgerB.init();
      setLedgerForTests(ledgerB);
      const found = await getHire(hire.id);
      expect(found?.description).toBe("Compare payment options for my shop");
      expect(found?.priceUsdc).toBe(1);
      expect(found?.bondUsdc).toBe(0);
      expect(found?.cfoAccepted).toBe(true);
      expect(found?.decisionHash).toMatch(/^[0-9a-f]{64}$/);
      const report = await getReport(hire.id);
      expect(report?.stage).toBe(2);
      expect(report?.pages?.[0].text).toContain("1.5%");
      await setHireStatus(hire.id, "delivered");
      expect((await getHire(hire.id))?.status).toBe("delivered");
      await poolB.end();
    } finally {
      await poolA.end();
      setLedgerForTests(new MemoryLedger());
    }
  });
});

describe("creative deliveries (website / flyers / promo video)", () => {
  it("an empty creative delivery starts at stage 1 with the right kind", () => {
    expect(emptyStoredCreative("website").deliverableKind).toBe("website");
    expect(emptyStoredCreative("flyers").deliverableKind).toBe("flyer");
    expect(emptyStoredCreative("promo-video").deliverableKind).toBe("slideshow");
    expect(emptyStoredCreative("website").stage).toBe(1);
    expect(emptyStoredCreative("website").status).toBe("in-progress");
    expect(deliverableKindFor("market-report")).toBe("report");
  });

  it("stage labels name the right team for each job type", () => {
    expect(deliveryStageLabel("website", 2)).toMatch(/Designer is building your website/);
    expect(deliveryStageLabel("flyers", 2)).toMatch(/Designer is making your flyer/);
    expect(deliveryStageLabel("promo-video", 2)).toMatch(/Producer is putting your slideshow together/);
    expect(deliveryStageLabel("market-report", 1)).toMatch(/Scout is looking the market up/);
  });

  it("creative progress survives a round-trip through the stored delivery", async () => {
    const hire = await createHire({
      jobType: "website",
      description: "A site for Ada's Kitchen",
      customerWallet: "0x0000000000000000000000000000000000000005",
    });
    const stored = emptyStoredCreative("website");
    stored.html = "<html><body><h1>Ada's Kitchen</h1></body></html>";
    stored.stage = 3;
    stored.steps = [{ agent: "Designer", what: "Read the brief.", detail: "" }];
    stored.facts = {
      businessName: "Ada's Kitchen",
      whatItDoes: "Home cooking in Lekki",
      services: ["Jollof rice"],
      prices: [{ item: "Jollof rice", price: "₦2,500", listed: true }],
      contact: "WhatsApp 0803 123 4567",
      colours: "",
      notes: "",
    };
    await setReport(hire.id, stored);
    const back = await getReport(hire.id);
    expect(back?.html).toContain("Ada's Kitchen");
    expect(back?.facts?.businessName).toBe("Ada's Kitchen");
    // The staged runner can pick it up again from the stored shape.
    const progress = creativeToProgress(back!, hire.description, "website");
    expect(progress.stage).toBe(3);
    expect(progress.facts?.businessName).toBe("Ada's Kitchen");
    expect(progressToCreative(progress).html).toContain("Ada's Kitchen");
    expect(progressToCreative(progress).deliverableKind).toBe("website");
  });

  it("a slideshow delivery stores slides, not HTML", () => {
    const stored = emptyStoredCreative("promo-video");
    stored.slides = [{ title: "Real food", text: "Home cooking in Lekki." }];
    stored.stage = 0;
    stored.status = "delivered";
    const progress = creativeToProgress(stored, "A promo for Ada's Kitchen", "promo-video");
    expect(progress.slides).toHaveLength(1);
    expect(progress.html).toBe("");
    expect(progressToCreative(progress).slides?.[0].title).toBe("Real food");
  });
});

describe("summarizeHires — the landing page's live numbers", () => {
  const hire = (over: Partial<HireResult>): HireResult =>
    ({
      id: "ord_test",
      jobType: "market-report",
      description: "test",
      customerWallet: "0x0000000000000000000000000000000000000001",
      status: "in-progress",
      priceUsdc: 1,
      bondUsdc: 0,
      cfoAccepted: true,
      cfoReason: "",
      decisionHash: "",
      createdAt: "2026-11-23T11:00:00.000Z",
      escrowAddress: null,
      fundTxHash: null,
      deliverableTxHash: null,
      settleTxHash: null,
      escrowState: null,
      ...over,
    }) as HireResult;

  it("counts done and settled, and links the first finished job", () => {
    const s = summarizeHires([
      hire({ id: "ord_a", status: "accepted", createdAt: "2026-11-23T11:00:00.000Z" }),
      hire({ id: "ord_b", status: "delivered", customerWallet: "0x0000000000000000000000000000000000000002", createdAt: "2026-11-23T12:00:00.000Z" }),
      hire({ id: "ord_c", status: "in-progress" }),
    ]);
    expect(s).toEqual({ jobs: 3, done: 2, settled: 1, customers: 2, firstDoneJobId: "ord_a" });
  });

  it("is all zeros with no finished job", () => {
    expect(summarizeHires([hire({ status: "in-progress" })])).toEqual({
      jobs: 1,
      done: 0,
      settled: 0,
      customers: 0,
      firstDoneJobId: null,
    });
  });
});
