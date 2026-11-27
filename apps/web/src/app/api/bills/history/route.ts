import { listBills } from "@/lib/bills";
import { privateJson, walletSession } from "@/lib/walletSession";

/** Only chain-verified funding ownership links an existing bill to a wallet. */
export async function GET(request: Request) {
  const session = walletSession(request);
  if (!session) return privateJson({ error: "Sign in with the wallet you used to fund your bills.", code: "SIGN_IN_REQUIRED" }, 401);
  const address = session.address.toLowerCase();
  const bills = (await listBills())
    .filter(bill => bill.fundingPayerWallet?.toLowerCase() === address)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(bill => ({
      id: bill.id, purpose: bill.purpose, amountNgn: bill.amountNgn,
      status: bill.status, createdAt: bill.createdAt, deadline: bill.deadline,
      supplierWallet: bill.supplierWallet, fundingPaidUsdtAtomic: bill.fundingPaidUsdtAtomic,
    }));
  return privateJson({ bills });
}
