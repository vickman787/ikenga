import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { listBills, type BillResult } from "@/lib/bills";
import { SESSION_COOKIE, signToken } from "@/lib/walletSession";
vi.mock("@/lib/bills", () => ({ listBills: vi.fn() }));
const OWNER = "0x00000000000000000000000000000000000000a2";
const OTHER = "0x00000000000000000000000000000000000000b3";
const SITE = "https://ikenga.example";
function request(address?: typeof OWNER | typeof OTHER, expires = Date.now() + 60000) {
  return new Request(SITE + "/api/bills/history", { headers: {
    ...(address ? { cookie: SESSION_COOKIE + "=" + signToken({ kind: "session", address, origin: SITE, expires }) } : {}),
    "x-ikenga-verified-access": "worker",
  } });
}
function bill(id: string, wallet: string | null, status: BillResult["status"], createdAt: string): BillResult {
  return { id, fundingPayerWallet: wallet, status, createdAt, purpose: id + " purpose", amountNgn: 1500, deadline: "2026-12-01T00:00:00Z", supplierWallet: OTHER, fundingPaidUsdtAtomic: wallet ? "1040000" : null, payerName: "Not part of the history response", note: "Private worker metadata" } as BillResult;
}
beforeEach(() => {
  vi.stubEnv("IKENGA_SESSION_SECRET", "isolated-test-session-secret-more-than-32-characters");
  vi.mocked(listBills).mockReset();
  vi.mocked(listBills).mockResolvedValue([
    bill("older", OWNER, "paid", "2026-11-24T00:00:00Z"),
    bill("other-wallet-secret", OTHER, "paid", "2026-11-26T00:00:00Z"),
    bill("unfunded-secret", null, "created", "2026-11-26T00:00:00Z"),
    bill("newer", "0x" + OWNER.slice(2).toUpperCase(), "watching", "2026-11-26T00:00:00Z"),
    bill("failed", OWNER, "failed", "2026-11-25T00:00:00Z"),
  ]);
});
afterEach(() => vi.unstubAllEnvs());
describe("wallet bill history", () => {
  it("refuses anonymous and expired sessions before reading records, regardless of forged access headers", async () => {
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request(OWNER, Date.now() - 1))).status).toBe(401);
    expect(listBills).not.toHaveBeenCalled();
  });
  it("returns only this wallet's funded bills, newest first, across active, paid and failed states", async () => {
    const response = await GET(request(OWNER));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    const data = await response.json();
    expect(data.bills.map((b: { id: string }) => b.id)).toEqual(["newer", "failed", "older"]);
    expect(JSON.stringify(data)).not.toMatch(/other-wallet-secret|unfunded-secret|Not part of|Private worker/);
    expect(data.bills[0]).toMatchObject({ status: "watching", amountNgn: 1500, fundingPaidUsdtAtomic: "1040000" });
  });
  it("switching wallets changes which bills are returned", async () => {
    const response = await GET(request(OTHER));
    expect((await response.json()).bills.map((b: { id: string }) => b.id)).toEqual(["other-wallet-secret"]);
  });
});
