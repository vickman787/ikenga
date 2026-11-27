import { getBillEvents, listBills } from "@/lib/bills";
import { privateJson, walletSession } from "@/lib/walletSession";

function dateBoundary(value: string | null, end = false): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const calendarDate = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== value) return null;
  // Date boundaries follow Africa/Lagos (UTC+1), matching the date control shown to Nigerian users.
  return Date.parse(value + (end ? "T23:59:59.999+01:00" : "T00:00:00.000+01:00"));
}

/** A wallet-private activity export. It includes only verified funding owner records and on-ledger receipts. */
export async function GET(request: Request) {
  const session = walletSession(request);
  if (!session) return privateJson({ error: "Sign in with the wallet you used to fund your bills." }, 401);
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const start = dateBoundary(from);
  const end = dateBoundary(to, true);
  if (start === null || end === null || start > end) {
    return privateJson({ error: "Choose a valid start and end date, with the start on or before the end." }, 400);
  }
  const wallet = session.address.toLowerCase();
  const bills = (await listBills()).filter((bill) => bill.fundingPayerWallet?.toLowerCase() === wallet);
  const activity = [];
  for (const bill of bills) {
    const events = await getBillEvents(bill.id);
    for (const event of events) {
      const timestamp = Date.parse(event.createdAt);
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) continue;
      const fundingAtomic = event.kind === "funded" ? event.entryText?.split("|")[2] ?? null : null;
      activity.push({
        id: event.id,
        billId: bill.id,
        purpose: bill.purpose,
        amountNgn: bill.amountNgn,
        supplierWallet: bill.supplierWallet,
        kind: event.kind,
        reason: event.reason,
        txHash: event.txHash,
        rateSeen: event.rateSeen,
        fundingUsdtAtomic: fundingAtomic && /^\d+$/.test(fundingAtomic) ? fundingAtomic : null,
        createdAt: event.createdAt,
      });
    }
  }
  activity.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const fundedUsdtAtomic = activity.reduce((sum, item) => sum + BigInt(item.fundingUsdtAtomic ?? "0"), 0n).toString();
  const paidNgn = activity.reduce((sum, item) => sum + (item.kind === "payout" ? item.amountNgn : 0), 0);
  return privateJson({
    wallet: session.address,
    from,
    to,
    generatedAt: new Date().toISOString(),
    activity,
    totals: { fundedUsdtAtomic, paidNgn, eventCount: activity.length },
  });
}