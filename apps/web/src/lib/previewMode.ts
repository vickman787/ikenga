/** A non-secret flag enabled only on the UI review deployment. */
export function assertWalletEnabled(): void {
  if (process.env.NEXT_PUBLIC_IKENGA_READ_ONLY === "1") {
    throw new Error("This preview is read-only. Wallet connections and payments are disabled; use the live app for a real job.");
  }
}
