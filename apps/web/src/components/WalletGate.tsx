"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { connectedWallet, signInWallet, signOutWallet, type WalletLogin } from "@/lib/walletLogin";
export default function WalletGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<WalletLogin | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const loginInFlight = useRef(false);
  const blocked = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    let active = true; mounted.current = true;
    const invalidate = () => { if (loginInFlight.current) { setSession(null); return; } blocked.current = true; generation.current++; setSession(null); setError(null); void signOutWallet().catch(() => setError("Your session could not be cleared. Please try signing out again.")); };
    const check = async () => {
      if (loginInFlight.current || blocked.current) return;
      const checkGeneration = generation.current;
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        const value = await response.json();
        if (!active || generation.current !== checkGeneration) return;
        const account = await connectedWallet();
        if (!active || generation.current !== checkGeneration) return;
        if (value.address && value.address.toLowerCase() === account && value.expires > Date.now()) setSession(value);
        else { setSession(null); if (value.address) { blocked.current = true; await signOutWallet(); } }
      } catch { if (active) setSession(null); }
      finally { if (active) setLoading(false); }
    };
    const onFocus = () => { setSession(null); void check(); };
    const provider = window.ethereum;
    provider?.on?.("accountsChanged", invalidate);
    provider?.on?.("disconnect", invalidate);
    window.addEventListener("focus", onFocus);
    void check();
    const timer = setInterval(() => { void check(); }, 10_000);
    return () => { active = false; mounted.current = false; generation.current++; clearInterval(timer); provider?.removeListener?.("accountsChanged", invalidate); provider?.removeListener?.("disconnect", invalidate); window.removeEventListener("focus", onFocus); };
  }, []);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => { blocked.current = true; generation.current++; setSession(null); void signOutWallet().catch(() => {}); }, Math.max(0, session.expires - Date.now()));
    return () => clearTimeout(timer);
  }, [session]);
  async function login() {
    const attempt = ++generation.current; loginInFlight.current = true;
    setBusy(true); setError(null);
    try { const value = await signInWallet(); if (mounted.current && generation.current === attempt) { blocked.current = false; setSession(value); } }
    catch (err) { setError(err instanceof Error ? err.message : "Wallet sign-in was cancelled. Please try again."); }
    finally { loginInFlight.current = false; if (mounted.current) setBusy(false); }
  }
  async function logout() {
    blocked.current = true; loginInFlight.current = true; generation.current++; setSession(null); setBusy(true); setError(null);
    try { await signOutWallet(); } catch (err) { setError(err instanceof Error ? err.message : "Could not sign out."); }
    finally { loginInFlight.current = false; if (mounted.current) setBusy(false); }
  }
  if (loading) return <main className="wrap" style={{ paddingBlock: 64 }}><p role="status">Checking wallet sign-in…</p></main>;
  return <><div className="wrap" style={{ paddingBlock: 18, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}><div style={{ display: "flex", alignItems: "center", gap: 16 }}><a href="/" aria-label="Ikenga home"><img src="/logo-mark.png" width="34" height="34" alt="" /></a><a href="/jobs">My jobs</a></div>{session && <div style={{ display: "flex", alignItems: "center", gap: 12 }}><span title={session.address}>{session.address.slice(0,6)}…{session.address.slice(-4)}</span><button className="btn secondary" type="button" onClick={logout} disabled={busy}>Sign out / switch wallet</button></div>}</div>{error && <p className="wrap" role="alert">{error}</p>}{session ? children : <main className="wrap" style={{ paddingBlock: 64, maxWidth: 620 }}><div className="card pad"><span className="chip">YOUR WORKSPACE</span><h1 style={{ fontSize: 34, marginTop: 16 }}>Your work, with you.</h1><p style={{ marginBlock: 16, lineHeight: 1.8 }}>Sign in with the wallet you used to order. Your previous USDT and cNGN jobs will appear here, including their progress and delivered work.</p><p style={{ marginBottom: 24, color: "var(--muted)", lineHeight: 1.7 }}>Your wallet will ask you to sign a login message. It costs no gas and does not approve a payment. Used more than one wallet? Sign in with each wallet to see its jobs.</p><button className="btn primary" type="button" onClick={login} disabled={busy}>{busy ? "Waiting for your wallet…" : "Connect wallet & sign in"}</button><p style={{ marginTop: 20 }}><a href="/">Back to Ikenga</a></p></div></main>}</>;
}
