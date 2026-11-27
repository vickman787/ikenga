import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/jobs", () => ({ getChainConfig: () => ({ chainId: 42220 }), ledgerBackend: () => "memory" }));
vi.mock("@/lib/billQuote", () => ({ previewBill: vi.fn() }));
vi.mock("@/lib/bills", async () => {
  const original = await vi.importActual<typeof import("@/lib/bills")>("@/lib/bills");
  return { ...original, createBill: vi.fn(), listBills: vi.fn() };
});
import { previewBill } from "@/lib/billQuote";
import { createBill } from "@/lib/bills";
import { POST } from "./route";
const input = { payerName: "Test", purpose: "Supplies", amountNgn: 5000, supplierWallet: "0x00000000000000000000000000000000000000aa", deadline: new Date(Date.now() + 86400000).toISOString(), minRate: 1400, rateMode: "current", deadlinePolicy: "keep_waiting" };
const request = (body = input) => new Request("https://example.test/api/bills", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(createBill).mockResolvedValue({ id: "test" } as never); });
it("checks a live rate before saving a current-rate bill and preserves the consented floor", async () => {
  vi.mocked(previewBill).mockResolvedValue({ rate: 1440, minimumRate: 1432.8 } as never);
  expect((await POST(request())).status).toBe(201);
  expect(createBill).toHaveBeenCalledWith(expect.objectContaining({ minRate: 1400, deadlinePolicy: "keep_waiting" }));
});
it("accepts Muse's payNow request shape and checks a live quote before saving", async () => {
  vi.mocked(previewBill).mockResolvedValue({ rate: 1440, minimumRate: 1432.8 } as never);
  expect((await POST(request({ ...input, rateMode: undefined, payNow: true }))).status).toBe(201);
  expect(createBill).toHaveBeenCalledWith(expect.objectContaining({ payNow: true }));
});
it("refuses a current quote that has fallen below the accepted minimum", async () => {
  vi.mocked(previewBill).mockResolvedValue({ rate: 1399 } as never);
  expect((await POST(request())).status).toBe(409); expect(createBill).not.toHaveBeenCalled();
});
it("fails closed when no live current quote is available", async () => {
  vi.mocked(previewBill).mockRejectedValue(new Error("Unavailable"));
  expect((await POST(request())).status).toBe(400); expect(createBill).not.toHaveBeenCalled();
});
it("allows a future target without claiming it is currently available", async () => {
  expect((await POST(request({ ...input, rateMode: "target", minRate: 1600 }))).status).toBe(201);
  expect(previewBill).not.toHaveBeenCalled();
});
it("rejects an unknown deadline rule before saving", async () => {
  expect((await POST(request({ ...input, deadlinePolicy: "ignore" }))).status).toBe(400);
  expect(createBill).not.toHaveBeenCalled();
});
