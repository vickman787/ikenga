import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { getBillEvents, listBills, type BillResult } from "@/lib/bills";
import { SESSION_COOKIE, signToken } from "@/lib/walletSession";
vi.mock("@/lib/bills", () => ({ getBillEvents: vi.fn(), listBills: vi.fn() }));
const OWNER = "0x00000000000000000000000000000000000000a2";
const OTHER = "0x00000000000000000000000000000000000000b3";
const SITE = "https://ikenga.example";
function request(address?: typeof OWNER | typeof OTHER, from = "2026-11-01", to = "2026-11-30") {
  return new Request(SITE + "/api/bills/history/statement?from=" + from + "&to=" + to, { headers: {
    ...(address ? { cookie: SESSION_COOKIE + "=" + signToken({ kind: "session", address, origin: SITE, expires: Date.now() + 60000 }) } : {}),
  } });
}
function bill(id: string, wallet: string): BillResult {
  return { id, fundingPayerWallet: wallet, status: "paid", createdAt: "2026-11-02T00:00:00.000Z", purpose: "Shop stock", amountNgn: 1500, supplierWallet: OTHER } as BillResult;
}
const funded = { id: "funded", billId: "owned", kind: "funded", reason: "USDT received", txHash: "0x" + "a".repeat(64), rateSeen: null, entryText: "funded|hash|1040000", createdAt: "2026-11-03T10:00:00.000Z" };
const payout = { id: "payout", billId: "owned", kind: "payout", reason: "Supplier paid", txHash: "0x" + "b".repeat(64), rateSeen: 1440, entryText: null, createdAt: "2026-11-04T10:00:00.000Z" };
beforeEach(() => {
  vi.stubEnv("IKENGA_SESSION_SECRET", "isolated-test-session-secret-more-than-32-characters");
  vi.mocked(listBills).mockResolvedValue([bill("owned", OWNER), bill("other-wallet", OTHER)]);
  vi.mocked(getBillEvents).mockImplementation(async id => id === "owned" ? [{ ...payout, id: "lagos-start", kind: "waiting", txHash: null, createdAt: "2026-10-31T23:30:00.000Z" }, funded, payout, { ...payout, id: "outside", createdAt: "2026-12-01T00:00:00.000Z" }] as never : [] as never);
});
afterEach(() => vi.unstubAllEnvs());
describe("wallet-private bill statement data", () => {
  it("requires a signed-in wallet and ignores unsigned access headers", async () => {
    expect((await GET(new Request(SITE + "/api/bills/history/statement?from=2026-11-01&to=2026-11-30", { headers: { "x-ikenga-verified-access": "worker" } }))).status).toBe(401);
    expect(listBills).not.toHaveBeenCalled();
  });
  it("returns only the wallet's verified activity in the inclusive date range and totals actual event values", async () => {
    const response = await GET(request(OWNER));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body.activity.map((item: { kind: string }) => item.kind)).toEqual(["waiting", "funded", "payout"]);
    expect(body.totals).toMatchObject({ fundedUsdtAtomic: "1040000", paidNgn: 1500, eventCount: 3 });
    expect(JSON.stringify(body)).not.toContain("other-wallet");
  });
  it("rejects malformed or reversed date ranges", async () => {
    expect((await GET(request(OWNER, "2026-02-30", "2026-03-01"))).status).toBe(400);
    expect((await GET(request(OWNER, "2026-11-30", "2026-11-01"))).status).toBe(400);
  });
});