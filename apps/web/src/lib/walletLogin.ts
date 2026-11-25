"use client";
import { getAddress, toHex, type Address } from "viem";
export interface WalletLogin { address: Address; expires: number }
export async function signOutWallet() {
  const response = await fetch("/api/auth/session", { method: "DELETE" });
  if (!response.ok) throw new Error("Could not sign out. Please try again.");
}
export async function connectedWallet(): Promise<string | null> {
  const accounts = await window.ethereum?.request({ method: "eth_accounts" });
  return Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0].toLowerCase() : null;
}
export async function signInWallet(expected?: string): Promise<WalletLogin> {
  const provider = window.ethereum;
  if (!provider) throw new Error("Open Ikenga in your wallet browser or install a Celo wallet extension to sign in.");
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") throw new Error("Choose a wallet account to continue.");
  const address = getAddress(accounts[0]);
  if (expected && address.toLowerCase() !== expected.toLowerCase()) throw new Error("Your wallet account changed. Reconnect the wallet you want to use.");
  const challenge = await fetch("/api/auth/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });
  const data = await challenge.json();
  if (!challenge.ok) throw new Error(data.error ?? "Could not start wallet sign-in.");
  const signature = await provider.request({ method: "personal_sign", params: [toHex(data.message), address] });
  if (await connectedWallet() !== address.toLowerCase()) throw new Error("Your account changed during sign-in. Please try again.");
  const response = await fetch("/api/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signature }) });
  const session = await response.json();
  if (!response.ok) throw new Error(session.error ?? "Could not verify your wallet.");
  if (await connectedWallet() !== address.toLowerCase()) { await signOutWallet(); throw new Error("Your account changed. Sign in again."); }
  return session as WalletLogin;
}
export async function ensureWalletSession(address: string) {
  const response = await fetch("/api/auth/session", { cache: "no-store" });
  const session = await response.json();
  if (response.ok && session.address?.toLowerCase() === address.toLowerCase() && await connectedWallet() === address.toLowerCase()) return;
  await signInWallet(address);
}
