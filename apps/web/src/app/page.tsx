import HireForm from "@/components/HireForm";

/**
 * Ikenga home page — rebuilt to match Syncly's live site
 * (hiresyncly.site) in structure and feel: a dark hero panel, numbered
 * sections (02 How it works, 03 Real work, 04 Pay your way, 05 the CFO,
 * 06 Follow the money, 07 The team, 08 The office, 09 Questions, 10 Start
 * here), cream paper, forest ink and leaf green. Ikenga branding and Celo
 * throughout — Textile FX USDT ↔ cNGN instead of Bachs/USDC-on-Arc, and
 * Self Agent ID instead of an unverified team.
 *
 * Honesty rule: Ikenga has no live jobs or customers yet, so this page
 * invents none. Where Syncly shows live numbers, Ikenga shows an honest
 * empty state and the one live check that is real (the Textile FX preview).
 */

const TEAM: { name: string; role: string; line: string; buys: string; pays: string }[] = [
  { name: "Scout", role: "Finds things", line: "Finds every business, page and source the brief asks for.", buys: "Search and maps", pays: "x402 · its own USDT balance on Celo" },
  { name: "Researcher", role: "Turns sentences into plans", line: "Turns your sentence into a search plan, then pulls out the facts.", buys: "AI models", pays: "x402 · its own USDT balance on Celo" },
  { name: "Reader", role: "Reads what matters", line: "Opens the websites and reads what matters on them.", buys: "Page reading", pays: "x402 · its own USDT balance on Celo" },
  { name: "Writer", role: "Writes the words", line: "Writes the posts, the ad copy, the briefs, and a personal first line for every lead.", buys: "AI models", pays: "x402 · its own USDT balance on Celo" },
  { name: "Designer", role: "Builds and designs", line: "Builds your website and makes the product photos and ad creatives.", buys: "AI models and images", pays: "x402 · its own USDT balance on Celo" },
  { name: "Producer", role: "Makes the motion", line: "Makes the motion ads, and the video in every ad launch.", buys: "Video and music", pays: "x402 · its own USDT balance on Celo" },
  { name: "Investigator", role: "Checks before you pay", line: "Checks every email, phone number and seller before any money moves.", buys: "Checks and screening", pays: "x402 · its own USDT balance on Celo" },
  { name: "Analyst", role: "Compares the numbers", line: "Compares prices, answers and signals: the numbers on every report.", buys: "AI models", pays: "x402 · its own USDT balance on Celo" },
  { name: "Auditor", role: "Checks the work twice", line: "Checks the work on a different AI before it is delivered.", buys: "A second model family", pays: "x402 · its own USDT balance on Celo" },
  { name: "Messenger", role: "Gets it to you", line: "Packs the files and gets them to you.", buys: "Delivery", pays: "Paid by the CFO · one plan, not per delivery" },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Do I need crypto?",
    a: "You need a Celo wallet with USDT — that is how the $1 goes into escrow. The naira leg runs through Textile FX, which converts USDT to cNGN on Celo, so the supplier is paid in cNGN. There is no bank-transfer option yet.",
  },
  {
    q: "What if I don't like the work?",
    a: "Ask for one free revision with what to change, or reject it: you get your money back in full, plus a bond the CFO put up when it took your job.",
  },
  {
    q: "How fast is it?",
    a: "The money path is instant — pricing, escrow and CFO decisions happen on the job page as they run. The work itself is delivered and reviewed on your job page; the creative work is not yet fully automated, so the first jobs are finished by the team and shown to you before you accept.",
  },
  {
    q: "Is it really $1?",
    a: "Yes. Every service is $1 while we grow. You always see the exact price before you pay, and the CFO puts up a bond on every job.",
  },
  {
    q: "Who does the work?",
    a: "A team of AI agents, each with one job: one finds things, one reads, one writes, one designs, one checks. A separate AI audits the work before it reaches you, and every step is shown on your job page. An agent is paid only after its Self Agent ID is verified.",
  },
  {
    q: "Is my information private?",
    a: "Your full-quality files unlock only when you accept. Every CFO decision is hash-chained and signed in the public audit log — the log shows the money, not your private brief.",
  },
];

function SectionLabel({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <span className="label">
      <span className="n">{n}</span>
      {children}
    </span>
  );
}

export default function Home() {
  return (
    <>
      <header className="nav">
        <div className="nav__bar">
          <a href="#top" className="nav__logo">
            <span className="nav__mark">I</span> Ikenga
          </a>
          <nav className="nav__links" aria-label="Sections">
            <a href="#how">How it works</a>
            <a href="#cfo">The CFO</a>
            <a href="#money">Follow the money</a>
            <a href="#team">The team</a>
            <a href="#questions">Questions</a>
          </nav>
          <span style={{ flex: 1 }} />
          <a href="#hire" className="pill dark">
            Hire Ikenga — $1 <span className="pill__ic">→</span>
          </a>
        </div>
      </header>

      <main id="top">
        {/* 01 · hero */}
        <section className="hx">
          <div className="hx__panel">
            <div className="hx__copy">
              <span className="hx__tag">
                <span className="dot" /> Built for Celo mainnet · Agents Open for Business
              </span>
              <h1>
                Your business&rsquo;s AI team. <em>Every job $1.</em>
              </h1>
              <p className="hx__lede">
                Websites, flyers, promo videos and a report on where your money
                goes. Order in a minute, watch a team of AI agents do it, and pay
                in USDT or cNGN only if you accept the work. An AI CFO runs the
                money: your payment waits in escrow on Celo until you say yes.
              </p>
              <div className="hx__cta">
                <a href="#hire" className="pill white lg">
                  See what we do <span className="pill__ic">→</span>
                </a>
                <a href="#cfo" className="pill ghost lg">
                  How the AI CFO works <span className="pill__ic">→</span>
                </a>
              </div>
              <div className="hx__menu">
                <a href="#hire">Website</a>
                <a href="#hire">Flyers</a>
                <a href="#hire">Promo video</a>
                <a href="#hire">Market report</a>
              </div>
            </div>
            <div className="hx__foot mono">
              <span>Pay in USDT or cNGN · only if you accept · every job $1</span>
              <span>Scroll ↓</span>
            </div>
          </div>
        </section>

        {/* 02 · How it works */}
        <section className="section" id="how">
          <div className="wrap">
            <div className="shead" style={{ textAlign: "left", margin: "0 0 40px" }}>
              <SectionLabel n="02">How it works</SectionLabel>
              <h2 className="h2" style={{ marginTop: 18 }}>
                Four steps. Pay only for work you accept.
              </h2>
            </div>
            <div className="steps">
              <div className="card step">
                <span className="step__no">01 / 04</span>
                <div>
                  <h3>Tell us what you need.</h3>
                  <p>
                    A short form. You see the price first. Pick a job and answer a
                    few questions about your business. The AI CFO prices it before
                    anything starts, and <b>puts up a bond you receive if you reject
                    the work</b>.
                  </p>
                </div>
              </div>
              <div className="card step">
                <span className="step__no">02 / 04</span>
                <div>
                  <h3>Pay $1, in USDT or cNGN.</h3>
                  <p>
                    Your money waits in escrow, not with us. Pay <b>1 USDT from
                    your own wallet on Celo</b> — about ₦1,444 in cNGN at the live
                    Textile FX preview — or let the naira leg convert it for you.
                    The money is held by <b>a contract on Celo</b> until you accept
                    the work.
                  </p>
                </div>
              </div>
              <div className="card step">
                <span className="step__no">03 / 04</span>
                <div>
                  <h3>Watch the team work.</h3>
                  <p>
                    Live, step by step, on your job page. The agents search, read,
                    write and design while you watch, and <b>every tool they pay
                    for is listed</b>, linked to its payment on Celo.
                  </p>
                </div>
              </div>
              <div className="card step">
                <span className="step__no">04 / 04</span>
                <div>
                  <h3>Accept, revise, or get your money back.</h3>
                  <p>
                    You decide. Silence for 48 hours counts as yes. Preview the
                    work, then accept to unlock the full files, ask for <b>one free
                    revision</b>, or reject it and <b>get your money back plus the
                    bond</b>.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 03 · Real work — honest empty state */}
        <section className="section tight" id="work">
          <div className="wrap">
            <div className="shead" style={{ textAlign: "left", margin: "0 0 40px" }}>
              <SectionLabel n="03">Real work</SectionLabel>
              <h2 className="h2" style={{ marginTop: 18 }}>
                Real businesses. Real work. Starting now.
              </h2>
            </div>
            <div className="card pad" style={{ maxWidth: 880 }}>
              <span className="chip demo">
                <span className="dot" /> No jobs delivered yet
              </span>
              <p style={{ marginTop: 16, fontSize: "var(--lede)", color: "var(--ink-2)", lineHeight: 1.6 }}>
                Ikenga has no finished jobs to show yet — no customer story, no
                job counts. The first real job will appear here, with its job
                page, its escrow and its CFO decisions, once a named user hires
                the team.
              </p>
              <p style={{ marginTop: 12, color: "var(--ink-2)", lineHeight: 1.6 }}>
                What is real today: the money path is built and checked. A live
                Textile FX preview on Celo (verified 2026-11-21) turns $10 USDT
                into about <b>14,440 cNGN</b> — roughly ₦1,444 per dollar. The
                CFO pricing, the hash-chained ledger, the Celo x402 client and
                the Self Agent ID gate are all built and tested.
              </p>
              <div style={{ marginTop: 24 }}>
                <a href="#hire" className="btn primary lg">
                  Be the first job →
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* 04 · Pay your way */}
        <section className="section tight" id="pay">
          <div className="wrap">
            <div className="shead" style={{ textAlign: "left", margin: "0 0 40px" }}>
              <SectionLabel n="04">Pay your way</SectionLabel>
              <h2 className="h2" style={{ marginTop: 18 }}>
                Pay in USDT or cNGN. Only if you accept.
              </h2>
            </div>
            <div className="paygrid">
              <div className="card paycard">
                <span className="chip live">
                  <span className="dot" /> cNGN
                </span>
                <p className="amount">≈ ₦1,444</p>
                <p>
                  Pay in cNGN from your own wallet on Celo. The naira leg runs
                  through <b>Textile FX</b>, which converts USDT to cNGN on Celo
                  mainnet — no bank transfer, no middleman holding your money.
                </p>
              </div>
              <div className="card paycard">
                <span className="chip">USDT</span>
                <p className="amount">$1</p>
                <p>
                  Pay <b>from your own wallet</b> on Celo. Works with MetaMask,
                  Rabby, Coinbase Wallet and other wallets. Your $1 waits in
                  escrow until you accept the work.
                </p>
              </div>
            </div>
            <div className="card pad" style={{ marginTop: 16 }}>
              <h3 style={{ fontSize: 18, marginBottom: 16 }}>Our promise</h3>
              <ul className="promise">
                <li>
                  <span>
                    <b>The price is fixed</b> before anything starts.
                  </span>
                </li>
                <li>
                  <span>
                    <b>Your money waits in escrow</b>, not with us, until you accept.
                  </span>
                </li>
                <li>
                  <span>
                    <b>One free revision</b> if it&rsquo;s not quite right.
                  </span>
                </li>
                <li>
                  <span>
                    <b>Reject it</b> and you get your money back, plus a bond.
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* 05 · Behind the scenes — the CFO */}
        <section className="section tight" id="cfo">
          <div className="wrap">
            <div className="dark-panel on-dark">
              <SectionLabel n="05">Behind the scenes · the CFO</SectionLabel>
              <h2 className="h2" style={{ marginTop: 18 }}>
                An AI runs the money. A contract keeps it honest.
              </h2>
              <p className="lede">
                Ikenga&rsquo;s money lives in a vault on Celo, and an AI CFO runs
                it. Every few minutes it reads the vault and every agent&rsquo;s
                balance, then decides by fixed rules: it plans the week, puts
                revenue to work and tops up agents who run low. No language
                model touches the money, and every decision is signed.
              </p>
              <div className="cfo-grid">
                <div className="cfo-card">
                  <h3>→ Plans the week</h3>
                  <p>
                    Each agent&rsquo;s allowance comes from what it actually spent
                    per job. The plan&rsquo;s hash is sealed on-chain before any
                    money moves.
                  </p>
                </div>
                <div className="cfo-card">
                  <h3>→ Puts revenue to work</h3>
                  <p>
                    Tools first, then bond cover for guarantees, then the
                    reserve. The rest stays in operating. Four buckets:
                    operating, tools, bond, reserve.
                  </p>
                </div>
                <div className="cfo-card">
                  <h3>→ Asks the Boss</h3>
                  <p>
                    It moves money alone only up to 5 USDT per move, the limit
                    the owner sets on the vault. Anything bigger waits for a
                    human to co-sign on-chain.
                  </p>
                </div>
              </div>
              <div className="cfo-log">
                <span>
                  Decision log · <b>0</b> carried out · <b>0</b> to the Boss
                </span>
                <span>
                  No decisions yet — the first ones appear here once a job runs.
                </span>
                <a href="/api/cfo">Read the CFO&rsquo;s rules →</a>
              </div>
              <p style={{ marginTop: 20, color: "var(--on-deep-3)", fontSize: 14, lineHeight: 1.6 }}>
                IkengaVault · Celo mainnet · not yet deployed. Weekly tool
                budget: 30 USDT. An agent is paid only after its Self Agent ID
                is verified.
              </p>
            </div>
          </div>
        </section>

        {/* 06 · Follow the money */}
        <section className="section tight" id="money">
          <div className="wrap">
            <div className="shead" style={{ textAlign: "left", margin: "0 0 40px" }}>
              <SectionLabel n="06">Follow the money</SectionLabel>
              <h2 className="h2" style={{ marginTop: 18 }}>
                From the invoice to the audit trail.
              </h2>
              <p style={{ marginTop: 16, fontSize: "var(--lede)", color: "var(--ink-2)" }}>
                Real businesses pay real USDT. This is the path every dollar
                takes through Ikenga, and the rule at each step.
              </p>
            </div>
            <div className="money">
              <div className="card money-step">
                <span className="money-step__no">01 · Invoices</span>
                <div>
                  <h3>
                    Customers pay into escrow <small>JobEscrow · Celo</small>
                  </h3>
                  <p>
                    Every order is a fixed-price bill, paid into JobEscrow on
                    Celo. Ikenga is paid only when the customer accepts. A
                    rejection refunds it, <b>plus a bond the CFO put up</b>.
                  </p>
                </div>
              </div>
              <div className="card money-step">
                <span className="money-step__no">02 · Treasury</span>
                <div>
                  <h3>
                    The vault splits it by rule <small>4 buckets</small>
                  </h3>
                  <p>
                    Released money lands in IkengaVault. The CFO puts it to work
                    across four buckets — operating, tools, bond, reserve — and
                    keeps the reserve above its floor.
                  </p>
                  <p className="mono">A plan sealed on Celo each week</p>
                </div>
              </div>
              <div className="card money-step">
                <span className="money-step__no">03 · Contractors</span>
                <div>
                  <h3>
                    Each agent gets an allowance <small>per agentId</small>
                  </h3>
                  <p>
                    Ten agents, each with its own wallet and a weekly allowance
                    set from what it really spends per job. The CFO tops them up
                    when they run low — and only after their Self Agent ID is
                    verified.
                  </p>
                  <p className="mono">10 agent wallets on Celo</p>
                </div>
              </div>
              <div className="card money-step">
                <span className="money-step__no">04 · Payments</span>
                <div>
                  <h3>
                    Agents pay suppliers per call <small>x402</small>
                  </h3>
                  <p>
                    Search, AI models and checks are bought with x402 on Celo.
                    Payout addresses are pinned and screened before anything is
                    signed, and every payment carries the hackathon attribution
                    tag.
                  </p>
                </div>
              </div>
              <div className="card money-step">
                <span className="money-step__no">05 · Audit trail</span>
                <div>
                  <h3>
                    Every decision is signed <small>hash-chained</small>
                  </h3>
                  <p>
                    Each decision is hash-chained to the one before and signed
                    by the CFO&rsquo;s key, and its hash rides on the vault
                    transaction. Anyone can replay the log.
                  </p>
                  <p className="mono">
                    <a href="/api/cfo">The decision log →</a> ·{" "}
                    <a href="/api/traction">Live numbers →</a>
                  </p>
                </div>
              </div>
            </div>
            <p style={{ marginTop: 24, color: "var(--ink-2)", lineHeight: 1.6, maxWidth: 680 }}>
              <b style={{ color: "var(--ink)" }}>
                Autonomous, inside hard limits.
              </b>{" "}
              The CFO acts alone only up to a limit the owner sets on the vault.
              Anything bigger is a proposal that only the owner&rsquo;s wallet can
              co-sign on Celo, and no language model ever touches the money.
            </p>
          </div>
        </section>

        {/* 07 · The team */}
        <section className="section tight" id="team">
          <div className="wrap">
            <div className="shead" style={{ textAlign: "left", margin: "0 0 40px" }}>
              <SectionLabel n="07">The team</SectionLabel>
              <h2 className="h2" style={{ marginTop: 18 }}>
                Ten agents. One job each.
              </h2>
              <p style={{ marginTop: 16, fontSize: "var(--lede)", color: "var(--ink-2)", maxWidth: 640 }}>
                Each one works like a contractor: its own wallet, a weekly
                allowance from the CFO, and it pays for its own tools one call
                at a time.
              </p>
            </div>
            <div className="team-grid">
              {TEAM.map((a) => (
                <div key={a.name} className="card agent">
                  <span className="agent__avatar" aria-hidden="true">
                    {a.name[0]}
                  </span>
                  <div>
                    <h3>{a.name}</h3>
                    <p className="role">{a.role}</p>
                    <p>{a.line}</p>
                    <p className="buys">
                      Buys <b>{a.buys}</b> · Pays with <b>{a.pays}</b>
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <p style={{ marginTop: 20, color: "var(--muted)", fontSize: 14 }}>
              On the team, waiting for their first paid call — the agents are
              built and gated by Self Agent ID, but no agent has been paid yet.
            </p>
          </div>
        </section>

        {/* 08 · The office */}
        <section className="section tight" id="office">
          <div className="wrap">
            <div className="office-panel">
              <SectionLabel n="08">The office</SectionLabel>
              <h2 className="h2" style={{ marginTop: 18 }}>
                Watch them work. Every movement is a real event.
              </h2>
              <p style={{ marginTop: 16, fontSize: "var(--lede)", color: "var(--ink-2)", maxWidth: 640, marginLeft: "auto", marginRight: "auto" }}>
                Every step an agent takes shows up on your job page — what it
                searched, what it read, what it paid for — linked to its
                payment on Celo.
              </p>
              <div className="office-avatars" aria-hidden="true">
                {TEAM.map((a) => (
                  <span key={a.name} className="agent__avatar" title={a.name}>
                    {a.name[0]}
                  </span>
                ))}
              </div>
              <p style={{ marginTop: 24, color: "var(--muted)", fontSize: 14 }}>
                Ikenga HQ · the live office view opens with the first job.
              </p>
            </div>
          </div>
        </section>

        {/* 09 · Questions */}
        <section className="section tight" id="questions">
          <div className="wrap">
            <div className="shead">
              <SectionLabel n="09">Questions</SectionLabel>
              <h2 className="h2" style={{ marginTop: 18 }}>
                Before you order.
              </h2>
              <p>
                Still unsure? Order the $1 job you need most and see for
                yourself.
              </p>
            </div>
            <div className="faq">
              {FAQ.map((f) => (
                <div key={f.q} className="card faq-item">
                  <h3>{f.q}</h3>
                  <p>{f.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 10 · Start here */}
        <section className="section tight" id="hire">
          <div className="wrap">
            <div className="shead">
              <SectionLabel n="10">Start here</SectionLabel>
              <h2 className="h2" style={{ marginTop: 18 }}>
                What should the team do for you?
              </h2>
              <p>
                Pick a job and say what you need in a sentence. You see the price
                before anything starts, and every job is $1.
              </p>
            </div>
            <div style={{ maxWidth: 720, margin: "0 auto" }}>
              <HireForm />
            </div>
            <p className="mono" style={{ textAlign: "center", marginTop: 24, fontSize: 13, color: "var(--muted)" }}>
              $1 a job · pay in USDT or cNGN · only if you accept · refund + bond if you reject
            </p>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap footer__inner">
          <div>
            <a href="#top" className="nav__logo" style={{ marginBottom: 12 }}>
              <span className="nav__mark">I</span> Ikenga
            </a>
            <p style={{ marginTop: 12 }}>
              Agents do the work. The CFO runs the money. Built for the Celo
              &ldquo;Agents Open for Business&rdquo; hackathon — Track 1
              Stablecoin Corridors (Textile FX USDT ↔ cNGN) and Track 3 Self
              Agent ID. Inspired by Syncly (github.com/neromtoobad/syncly).
              Fresh implementation — no code copied.
            </p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 14.5 }}>
            <a href="/api/cfo">The signed CFO log →</a>
            <a href="/api/traction">Live numbers →</a>
            <a href="https://github.com/vickman787/ikenga">GitHub →</a>
          </div>
        </div>
      </footer>
    </>
  );
}
