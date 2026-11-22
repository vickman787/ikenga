import HireForm from "@/components/HireForm";

export default function Home() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <header className="text-center">
        <p className="text-sm font-semibold tracking-[0.3em] text-[#f5c518]">IKENGA</p>
        <h1 className="mt-3 text-4xl font-black leading-tight sm:text-5xl">
          Agents do the work.
          <br />
          <span className="text-[#f5c518]">The CFO runs the money.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-[#9a9ab0]">
          Ikenga is a company staffed by AI agents, rebuilt for Celo. $1 jobs for
          Nigerian small businesses — websites, promo videos, flyers, market
          reports — paid into escrow, with every CFO decision signed and
          published in a public audit log.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2 text-xs">
          <span className="rounded-full border border-[#7c3aed] px-3 py-1 text-[#c4b5fd]">
            Track 1 · Stablecoin Corridors — Textile FX USDT ↔ cNGN
          </span>
          <span className="rounded-full border border-[#7c3aed] px-3 py-1 text-[#c4b5fd]">
            Track 3 · Self Agent ID — verified agent payments
          </span>
        </div>
      </header>

      <section className="mt-10">
        <HireForm />
      </section>

      <section className="mt-10 grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-[#ffffff14] bg-[#151524] p-5">
          <h3 className="font-bold">1 · Escrow</h3>
          <p className="mt-1 text-sm text-[#9a9ab0]">
            You pay $1 into escrow on Celo mainnet. The money only leaves escrow
            when you accept the work.
          </p>
        </div>
        <div className="rounded-2xl border border-[#ffffff14] bg-[#151524] p-5">
          <h3 className="font-bold">2 · The CFO</h3>
          <p className="mt-1 text-sm text-[#9a9ab0]">
            A deterministic CFO prices the job, funds the agents and signs every
            decision. No language model touches money. Agents pay for their own
            tools per call with x402.
          </p>
        </div>
        <div className="rounded-2xl border border-[#ffffff14] bg-[#151524] p-5">
          <h3 className="font-bold">3 · The audit log</h3>
          <p className="mt-1 text-sm text-[#9a9ab0]">
            Every decision is hash-chained and signed. Rejection refunds you —
            plus a bond the CFO put up. The naira leg converts USDT to cNGN on
            Textile FX, and an agent is paid only after its Self Agent ID is
            verified.
          </p>
        </div>
      </section>

      <section className="mt-10 rounded-2xl border border-[#ffffff14] bg-[#151524] p-5">
        <h3 className="font-bold">Jobs on this server</h3>
        <p className="mt-1 text-sm text-[#9a9ab0]">
          No jobs yet — hire Ikenga above to create the first one. Step 2 stores
          jobs in Postgres when DATABASE_URL is set, otherwise in this
          server&apos;s memory. What&apos;s real now: the CFO pricing, the
          hash-chained ledger, the Celo x402 client, the Textile FX RFQ client
          (live Celo levels verified — $10 USDT previews at ~14,440 cNGN), and
          the Self Agent ID gate (live Sepolia registry reads verified). Not
          yet real: no escrow deployed, no agent registered, no live swap or
          settlement has run — those need a funded wallet, an x402 API key,
          and the hackathon attribution tag. See /api/cfo and /api/traction
          for the live log and numbers.
        </p>
      </section>

      <footer className="mt-10 text-center text-xs text-[#9a9ab0]">
        Ikenga — built for the Celo &ldquo;Agents Open for Business&rdquo; hackathon.
        Inspired by Syncly (github.com/neromtoobad/syncly). Fresh implementation —
        no code copied.
      </footer>
    </main>
  );
}
