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
  getLedger,
  getReport,
  HireInputSchema,
  isRealHire,
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
        agentWallet: "0x61aD7AEAC0B94C91B4681d1D8624d82d5DaF4Fc0",
        payTokens: ["USDT", "cNGN"],
        tokens: {
          USDT: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
          cNGN: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f",
        },
        // The cNGN vault is not deployed yet (see DeployCngnVault.s.sol),
        // so there is no cNGN vault in the config until it is.
        vaults: { USDT: "0x1C2b2E64527B0bA7795ed3CDF7d76da51D24018B" },
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
        agentWallet: "0x61aD7AEAC0B94C91B4681d1D8624d82d5DaF4Fc0",
        payTokens: ["USDC"],
        tokens: { USDC: "0x01C5C0122039549AD1493B8220cABEdD739BC44E" },
        vaults: { USDC: "0x1A6d11A97e83f563bdA7811413097212362e0EcD" },
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

describe("createHire payment currency (USDT / cNGN)", () => {
  const CNGN_VAULT = "0x00000000000000000000000000000000000000c1";
  const CNGN_TOKEN = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f";
  const WALLET = "0x0000000000000000000000000000000000000002";
  const savedVault = process.env.IKENGA_CNGN_VAULT_ADDRESS;
  const savedChain = process.env.IKENGA_CHAIN;
  const savedSepoliaVault = process.env.IKENGA_VAULT_ADDRESS;
  const savedSepoliaToken = process.env.IKENGA_TOKEN_ADDRESS;
  const setMainnetCngn = () => {
    process.env.IKENGA_CNGN_VAULT_ADDRESS = CNGN_VAULT;
    delete process.env.IKENGA_CHAIN;
  };
  const restoreEnv = () => {
    if (savedVault === undefined) delete process.env.IKENGA_CNGN_VAULT_ADDRESS;
    else process.env.IKENGA_CNGN_VAULT_ADDRESS = savedVault;
    if (savedChain === undefined) delete process.env.IKENGA_CHAIN;
    else process.env.IKENGA_CHAIN = savedChain;
    if (savedSepoliaVault === undefined) delete process.env.IKENGA_VAULT_ADDRESS;
    else process.env.IKENGA_VAULT_ADDRESS = savedSepoliaVault;
    if (savedSepoliaToken === undefined) delete process.env.IKENGA_TOKEN_ADDRESS;
    else process.env.IKENGA_TOKEN_ADDRESS = savedSepoliaToken;
    setLedgerForTests(new MemoryLedger());
  };

  it("defaults a hire to $1 USDT in the USDT vault", async () => {
    setLedgerForTests(new MemoryLedger());
    try {
      const hire = await createHire({ jobType: "website", description: "A site", customerWallet: WALLET });
      expect(hire.payCurrency).toBe("USDT");
      expect(hire.priceAtomic).toBe("1000000");
      expect(hire.priceRate).toBeNull();
      expect(hire.tokenAddress).toBe("0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e");
      expect(hire.vaultAddress).toBe("0x1C2b2E64527B0bA7795ed3CDF7d76da51D24018B");
      expect(hire.priceUsdc).toBe(1);
    } finally {
      restoreEnv();
    }
  });

  it("fixes a cNGN hire's price from the live rate, rounded up to whole naira", async () => {
    setLedgerForTests(new MemoryLedger());
    setMainnetCngn();
    try {
      const hire = await createHire(
        { jobType: "flyers", description: "Flyers", customerWallet: WALLET, payCurrency: "cNGN" },
        { previewCngnUsd: async () => "1444067000" },
      );
      expect(hire.payCurrency).toBe("cNGN");
      expect(hire.priceAtomic).toBe("1445000000");
      expect(hire.priceRate).toBe("1444.067");
      expect(hire.tokenAddress).toBe(CNGN_TOKEN);
      expect(hire.vaultAddress).toBe(CNGN_VAULT);
      // The $1 value never changes — only the currency it is paid in.
      expect(hire.priceUsdc).toBe(1);
      // The decision names the currency, so the log says what was paid.
      const decisions = await (await getLedger()).listDecisions(hire.id);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.currency).toBe("cNGN");
      expect(decisions[0]?.entryText).toMatch(/^quote\|cNGN\|/);
    } finally {
      restoreEnv();
    }
  });

  it("a rate move after hire does not change the hired price", async () => {
    setLedgerForTests(new MemoryLedger());
    setMainnetCngn();
    try {
      const first = await createHire(
        { jobType: "website", description: "A site", customerWallet: WALLET, payCurrency: "cNGN" },
        { previewCngnUsd: async () => "1444067000" },
      );
      // The rate moves to 1,500 per $1 — a new hire fixes a new price,
      // but the hired job keeps the price it was hired at.
      const second = await createHire(
        { jobType: "website", description: "A site", customerWallet: WALLET, payCurrency: "cNGN" },
        { previewCngnUsd: async () => "1500000000" },
      );
      expect(first.priceAtomic).toBe("1445000000");
      expect(second.priceAtomic).toBe("1500000000");
      expect((await getHire(first.id))?.priceAtomic).toBe("1445000000");
    } finally {
      restoreEnv();
    }
  });

  it("refuses cNGN when the cNGN vault is not deployed yet", async () => {
    setLedgerForTests(new MemoryLedger());
    delete process.env.IKENGA_CNGN_VAULT_ADDRESS;
    delete process.env.IKENGA_CHAIN;
    try {
      await expect(
        createHire(
          { jobType: "website", description: "A site", customerWallet: WALLET, payCurrency: "cNGN" },
          { previewCngnUsd: async () => "1444067000" },
        ),
      ).rejects.toThrow(/aren't switched on yet/);
    } finally {
      restoreEnv();
    }
  });

  it("refuses cNGN on Sepolia — there is no cNGN there", async () => {
    setLedgerForTests(new MemoryLedger());
    process.env.IKENGA_CHAIN = "sepolia";
    process.env.IKENGA_VAULT_ADDRESS = "0x1A6d11A97e83f563bdA7811413097212362e0EcD";
    process.env.IKENGA_TOKEN_ADDRESS = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";
    try {
      await expect(
        createHire(
          { jobType: "website", description: "A site", customerWallet: WALLET, payCurrency: "cNGN" },
          { previewCngnUsd: async () => "1444067000" },
        ),
      ).rejects.toThrow(/isn't a way to pay/);
    } finally {
      restoreEnv();
    }
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
  // The default fixture is a REAL job: a mainnet customer whose $1 is
  // already in a funded escrow. Tests that mean a test run override
  // the wallet, the token, or the escrow/funding below.
  const hire = (over: Partial<HireResult>): HireResult =>
    ({
      id: "ord_test",
      jobType: "market-report",
      description: "test",
      customerWallet: "0x1111111111111111111111111111111111111111",
      status: "in-progress",
      priceUsdc: 1,
      bondUsdc: 0,
      payCurrency: "USDT",
      priceAtomic: "1000000",
      priceRate: null,
      tokenAddress: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
      vaultAddress: "0x1C2b2E64527B0bA7795ed3CDF7d76da51D24018B",
      cfoAccepted: true,
      cfoReason: "",
      decisionHash: "",
      createdAt: "2026-11-23T11:00:00.000Z",
      escrowAddress: "0x9c2ca8e46e44017226393b2d20ce69ef0234448e",
      fundTxHash: "0x48c02989f12d6bd82f76e5f5a1caa3a7e3fec16a9d67f3c6ad53dc297f7c0d6f",
      deliverableTxHash: null,
      settleTxHash: null,
      escrowState: "funded",
      ...over,
    }) as HireResult;

  it("counts done and settled, and links the first finished job", () => {
    const s = summarizeHires([
      hire({ id: "ord_a", status: "accepted", createdAt: "2026-11-23T11:00:00.000Z", settleTxHash: "0x3f4551a248970d882a3a569ca98bfc379dc44d030debbfec85fdc28273d08a22", escrowState: "accepted" }),
      hire({ id: "ord_b", status: "delivered", customerWallet: "0x0000000000000000000000000000000000000002", createdAt: "2026-11-23T12:00:00.000Z" }),
      hire({ id: "ord_c", status: "in-progress" }),
    ]);
    expect(s).toEqual({ jobs: 3, done: 2, settled: 1, customers: 2, firstDoneJobId: "ord_a", excludedTestJobs: 0 });
  });

  it("is all zeros with no finished job", () => {
    expect(summarizeHires([hire({ status: "in-progress" })])).toEqual({
      jobs: 1,
      done: 0,
      settled: 0,
      customers: 0,
      firstDoneJobId: null,
      excludedTestJobs: 0,
    });
  });

  it("excludes the three known test runs and keeps Amaka's real job", () => {
    const s = summarizeHires([
      // FortyTwo key test — delivered, never funded, dummy wallet.
      hire({ id: "ord_mwsc5dbd_7d9s76", status: "delivered", customerWallet: "0x0000000000000000000000000000000000000001", escrowAddress: null, fundTxHash: null, tokenAddress: "", vaultAddress: "", escrowState: null }),
      // Sepolia end-to-end — accepted on testnet, test wallet, no funding recorded on the live row.
      hire({ id: "ord_mwssqak9_tsinmi", status: "accepted", customerWallet: "0x94CcF19e6e12B64272D3b4946Dc34a9Ae9B74C50", escrowAddress: null, fundTxHash: null, tokenAddress: "", vaultAddress: "", escrowState: null }),
      // Speed-fix test — delivered, never funded, dummy wallet.
      hire({ id: "ord_mwsufnqe_urs8v7", status: "delivered", customerWallet: "0x0000000000000000000000000000000000000001", escrowAddress: null, fundTxHash: null, tokenAddress: "", vaultAddress: "", escrowState: null }),
      // Amaka — the real job: mainnet, funded escrow, accepted.
      hire({ id: "ord_mwt6lzin_6ou3oj", status: "accepted", customerWallet: "0xcc4BCDD595Ee20cFB8A214Dc570eCB3Fb1C1d3A1", settleTxHash: "0x3f4551a248970d882a3a569ca98bfc379dc44d030debbfec85fdc28273d08a22", escrowState: "accepted", createdAt: "2026-11-23T11:27:48.000Z" }),
    ]);
    expect(s).toEqual({ jobs: 1, done: 1, settled: 1, customers: 1, firstDoneJobId: "ord_mwt6lzin_6ou3oj", excludedTestJobs: 3 });
  });

  it("excludes a future Sepolia job automatically, even funded", () => {
    // A test run that DID go through the live fund flow on Sepolia: its
    // escrow is funded, but its token is Sepolia test USDC, not mainnet.
    const s = summarizeHires([
      hire({
        id: "ord_sepolia_next",
        status: "accepted",
        customerWallet: "0x2222222222222222222222222222222222222222",
        tokenAddress: "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
        vaultAddress: "0x1A6d11A97e83f563bdA7811413097212362e0EcD",
        settleTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        escrowState: "accepted",
      }),
    ]);
    expect(s).toEqual({ jobs: 0, done: 0, settled: 0, customers: 0, firstDoneJobId: null, excludedTestJobs: 1 });
  });

  it("excludes a mainnet job funded from a test wallet", () => {
    const s = summarizeHires([
      hire({
        id: "ord_agent_test",
        status: "accepted",
        customerWallet: "0x61aD7AEAC0B94C91B4681d1D8624d82d5DaF4Fc0",
        settleTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        escrowState: "accepted",
      }),
    ]);
    expect(s).toEqual({ jobs: 0, done: 0, settled: 0, customers: 0, firstDoneJobId: null, excludedTestJobs: 1 });
  });

  it("includes a future mainnet funded job", () => {
    const s = summarizeHires([
      hire({
        id: "ord_real_next",
        status: "accepted",
        customerWallet: "0x3333333333333333333333333333333333333333",
        settleTxHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        escrowState: "accepted",
      }),
    ]);
    expect(s).toEqual({ jobs: 1, done: 1, settled: 1, customers: 1, firstDoneJobId: "ord_real_next", excludedTestJobs: 0 });
  });

  it("excludes a real customer's job until its escrow is funded", () => {
    const s = summarizeHires([
      hire({ id: "ord_unfunded", status: "escrowed", fundTxHash: null, escrowState: "unfunded" }),
    ]);
    expect(s).toEqual({ jobs: 0, done: 0, settled: 0, customers: 0, firstDoneJobId: null, excludedTestJobs: 1 });
  });

  it("isRealHire: needs a funded escrow, a real wallet, and a mainnet token", () => {
    const real = hire({ status: "accepted" });
    expect(isRealHire(real)).toBe(true);
    expect(isRealHire({ ...real, fundTxHash: null })).toBe(false);
    expect(isRealHire({ ...real, escrowAddress: null })).toBe(false);
    expect(isRealHire({ ...real, customerWallet: "0x94CcF19e6e12B64272D3b4946Dc34a9Ae9B74C50" })).toBe(false);
    expect(isRealHire({ ...real, tokenAddress: "0x01C5C0122039549AD1493B8220cABEdD739BC44E" })).toBe(false);
    // Old rows store no token — the escrow and funding checks prove those.
    expect(isRealHire({ ...real, tokenAddress: "" })).toBe(true);
    expect(isRealHire({ ...real, tokenAddress: null })).toBe(true);
  });
});
