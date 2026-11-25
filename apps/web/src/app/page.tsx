"use client";

import { useEffect, useState } from "react";
import HireForm from "@/components/HireForm";
import WorkspaceHome, { type TreasuryVault } from "@/components/WorkspaceHome";

interface LiveNumbers {
  vaults: TreasuryVault[] | null;
  vault: { operating: string; tools: string; bond: string; reserve: string; total: string } | null;
  vaultError: boolean;
  onchainDecisions: number | null;
  verifyOk: boolean | null;
  jobs: number | null;
  done: number | null;
  settled: number | null;
  customers: number | null;
}

function useLiveNumbers(): LiveNumbers {
  const [live, setLive] = useState<LiveNumbers>({
    vaults: null,
    vault: null,
    vaultError: false,
    onchainDecisions: null,
    verifyOk: null,
    jobs: null,
    done: null,
    settled: null,
    customers: null,
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [vaultRes, cfoRes] = await Promise.all([fetch("/api/vault"), fetch("/api/cfo")]);
        const vaultJson = (await vaultRes.json().catch(() => null)) as {
          vaults?: TreasuryVault[];
          buckets?: { operating: string; tools: string; bond: string; reserve: string };
        } | null;
        const cfoJson = (await cfoRes.json().catch(() => null)) as {
          verify?: { ok: boolean };
          onchainDecisions?: number;
          summary?: { jobs: number; done: number; settled: number; customers: number };
        } | null;
        if (cancelled) return;
        setLive({
          vaults: vaultRes.ok && Array.isArray(vaultJson?.vaults) ? vaultJson.vaults : null,
          vault: vaultRes.ok && vaultJson?.buckets
            ? {
                ...vaultJson.buckets,
                total: (
                  ["operating", "tools", "bond", "reserve"] as const
                ).reduce((sum, k) => sum + Number(vaultJson.buckets![k]), 0).toString(),
              }
            : null,
          vaultError: !vaultRes.ok,
          onchainDecisions: cfoRes.ok
            ? (cfoJson?.onchainDecisions ?? null)
            : null,
          verifyOk: cfoRes.ok ? (cfoJson?.verify?.ok ?? null) : null,
          jobs: cfoRes.ok ? (cfoJson?.summary?.jobs ?? null) : null,
          done: cfoRes.ok ? (cfoJson?.summary?.done ?? null) : null,
          settled: cfoRes.ok ? (cfoJson?.summary?.settled ?? null) : null,
          customers: cfoRes.ok ? (cfoJson?.summary?.customers ?? null) : null,
        });
      } catch {
        if (!cancelled) setLive((prev) => ({ ...prev, vaultError: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return live;
}


export default function Home() {
  const live = useLiveNumbers();
  return <WorkspaceHome live={live}><HireForm /></WorkspaceHome>;
}
