"use client";

import HireForm from "@/components/HireForm";
import Nav from "@/components/Nav";

/**
 * Ikenga home page — second polish pass, side-by-side against Syncly's
 * live site (hiresyncly.site) and its public repo (web/src/views/Home.tsx,
 * home/sections.tsx, home/art.tsx, components/Nav.tsx, components/Footer.tsx).
 * Same structure, same palette, Ikenga's own code — no Syncly code copied
 * verbatim, no Syncly images or sprites used (every visual here is drawn
 * in CSS). Adapted to what Ikenga is for: Celo not Arc, Textile FX
 * USDT ↔ cNGN not Bachs, Self Agent ID gate, tag celo_5144280c393f.
 *
 * Honesty rule: Ikenga has no live jobs, customers, sellers or deployed
 * contracts yet, so this page invents none. Where Syncly shows live proof,
 * Ikenga shows honest zeros / empty states and the one live check that is
 * real (the Textile FX preview). The seller registry starts empty by
 * design, so no supplier names are shown for the agents.
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

const SERVICES: { id: "website" | "promo-video" | "flyers" | "market-report"; name: string; tagline: string; preview: "site" | "video" | "flyer" | "money" }[] = [
  { id: "website", name: "Business website", tagline: "A one-page site with your best work, your services, and WhatsApp, call and directions on every screen.", preview: "site" },
  { id: "promo-video", name: "Promo video", tagline: "A short motion ad for your feed, Stories and WhatsApp Status — the hook, the dish, the order card.", preview: "video" },
  { id: "flyers", name: "Flyers & price list", tagline: "A price list and flyers your customers can order from, with your WhatsApp number on every one.", preview: "flyer" },
  { id: "market-report", name: "Market report", tagline: "Where your money goes, read from your bank statement and reconciled — the numbers, not a guess.", preview: "money" },
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
    q: "What is Self Agent ID?",
    a: "Before any agent is paid, Ikenga checks that it is a real, verified agent — registered on Celo and verified with Self. An unverified agent is refused, and the refusal is written to the audit log. That is the Self Agent ID track: verified agents only, paid only after proof.",
  },
  {
    q: "Is Ikenga live on Celo mainnet yet?",
    a: "Not yet. The money path — CFO pricing, the hash-chained ledger, the Celo x402 client, the Textile FX client and the Self Agent ID gate — is built and tested, and a live Textile FX preview on Celo turns $10 USDT into about 14,440 cNGN. The escrow and vault contracts are written but not deployed, and no live swap or settlement has run. That happens with the first named real user, on Celo mainnet.",
  },
  {
    q: "Is my information private?",
    a: "Your full-quality files unlock only when you accept. Every CFO decision is hash-chained and signed in the public audit log — the log shows the money, not your private brief.",
  },
];

const BUCKETS: { key: string; label: string; color: string }[] = [
  { key: "operating", label: "OPERATING", color: "#4B8DCF" },
  { key: "tools", label: "TOOLS", color: "#59A53B" },
  { key: "bond", label: "BOND", color: "#8F5FC0" },
  { key: "reserve", label: "RESERVE", color: "#C38300" },
];

function selectJob(id: "website" | "promo-video" | "flyers" | "market-report") {
  window.dispatchEvent(new CustomEvent("ikenga:select-job", { detail: id }));
  document.getElementById("hire")?.scrollIntoView({ behavior: "smooth" });
}

function SectionLabel({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <span className="label">
      <span className="n">{n}</span>
      {children}
    </span>
  );
}

/** The Ikenga HQ building, drawn in CSS — Syncly's hero is a photo of its
 *  office; Ikenga has no photo, so the office is drawn instead. */
function HqBuilding({ big }: { big?: boolean }) {
  return (
    <div className={`hq${big ? " big" : ""}`} aria-hidden="true">
      <div className="hq__sign">IKENGA HQ</div>
      <div className="hq__roof" />
      <div className="hq__floors">
        <div className="hq__floor"><i /><i className="lit" /><i /><i className="lit" /><i /></div>
        <div className="hq__floor"><i className="lit" /><i /><i className="lit" /><i /><i className="lit" /></div>
        <div className="hq__floor"><i /><i className="lit" /><i className="door" /><i className="lit" /><i /></div>
      </div>
      <div className="hq__ground"><i /><i /><i /></div>
    </div>
  );
}

function ServicePreview({ kind }: { kind: "site" | "video" | "flyer" | "money" }) {
  if (kind === "site") {
    return (
      <div className="pv pv-site">
        <div className="phone">
          <i className="bar" />
          <b className="h">Portraits that make you look twice</b>
          <i className="l" /><i className="l s" />
          <span className="btn">WhatsApp</span>
          <div className="ph" />
        </div>
      </div>
    );
  }
  if (kind === "video") {
    return (
      <div className="pv pv-video">
        <div className="frame">
          <b>Power up<br />your home</b>
          <span className="play">▶</span>
          <i className="prog"><i /></i>
        </div>
        <span className="music">♪ licensed music · 16 s</span>
      </div>
    );
  }
  if (kind === "flyer") {
    return (
      <div className="pv pv-flyer">
        <div className="sheet">
          <span className="lg">I</span>
          <b>Price list</b>
          {[
            ["Small chops (50)", "₦12,500"],
            ["Jollof tray", "₦30,000"],
            ["Party tray (20)", "₦25,000"],
            ["Samosa (50)", "₦12,000"],
          ].map(([a, b]) => (
            <p key={a}><span>{a}</span><em /><span>{b}</span></p>
          ))}
          <span className="cta">Order on WhatsApp</span>
        </div>
      </div>
    );
  }
  return (
    <div className="pv pv-money">
      <div className="bars">
        {[[62, 70], [80, 58], [70, 66], [92, 61]].map(([a, b], i) => (
          <span key={i}><i className="in" style={{ height: `${a}%` }} /><i className="out" style={{ height: `${b}%` }} /></span>
        ))}
      </div>
      <div className="rows">
        <span>Rent <b>38%</b></span>
        <span>Stock <b>31%</b></span>
        <span>Charges <b>₦48k/yr</b></span>
        <span className="ok">✓ reconciled</span>
      </div>
    </div>
  );
}

const HOW: { n: string; h: string; s: string; p: React.ReactNode; art: "quote" | "escrow" | "receipt" | "decide" }[] = [
  {
    n: "01", h: "Tell us what you need.", s: "A short form. You see the price first.",
    p: <>Pick a job and answer a few questions about your business. The AI CFO prices it before anything starts, and <b>puts up a bond you receive if you reject the work</b>.</>,
    art: "quote",
  },
  {
    n: "02", h: "Pay $1, in USDT or cNGN.", s: "Your money waits in escrow, not with us.",
    p: <>Pay <b>1 USDT from your own wallet on Celo</b> — about ₦1,444 in cNGN at the live Textile FX preview — or let the naira leg convert it for you. The money is held by <b>a contract on Celo</b> until you accept the work.</>,
    art: "escrow",
  },
  {
    n: "03", h: "Watch the team work.", s: "Live, step by step, on your job page.",
    p: <>The agents search, read, write and design while you watch, and <b>every tool they pay for is listed</b>, linked to its payment on Celo.</>,
    art: "receipt",
  },
  {
    n: "04", h: "Accept, revise, or get your money back.", s: "You decide. Silence for 48 hours counts as yes.",
    p: <>Preview the work, then accept to unlock the full files, ask for <b>one free revision</b>, or reject it and <b>get your money back plus the bond</b>.</>,
    art: "decide",
  },
];

function HowArt({ kind }: { kind: "quote" | "escrow" | "receipt" | "decide" }) {
  if (kind === "quote") {
    return (
      <div className="hw-art">
        <span className="hw-art__k mono">Your brief</span>
        <p className="hw-art__q">“A one-page website for my bakery in Yaba”</p>
        <div className="hw-art__row"><span>Price, before anything starts</span><b>$1</b></div>
        <div className="hw-art__row"><span>CFO bond if you reject</span><b>$0.10</b></div>
      </div>
    );
  }
  if (kind === "escrow") {
    return (
      <div className="hw-art">
        <span className="hw-art__k mono">JobEscrow · Celo</span>
        <p className="hw-art__big">🔒 $1 in escrow</p>
        <p className="hw-art__sub">Held by the contract — not by Ikenga, not by the agent — until you accept the work.</p>
        <span className="chip live"><span className="dot" /> Escrow funded</span>
      </div>
    );
  }
  if (kind === "receipt") {
    return (
      <div className="hw-art">
        <span className="hw-art__k mono">Every tool payment, listed</span>
        {[["Search", "paid"], ["Read", "paid"], ["Design", "paid"]].map(([a, b]) => (
          <div className="hw-art__row" key={a}><span>{a}</span><b>✓ {b} · x402</b></div>
        ))}
        <p className="hw-art__sub">Each line links to its payment on Celo. Nothing is paid to a seller the CFO has not pinned.</p>
      </div>
    );
  }
  return (
    <div className="hw-art">
      <span className="hw-art__k mono">Your decision</span>
      <div className="hw-art__decide">
        <span className="decide accept">✓ Accept — unlock the files</span>
        <span className="decide">↺ One free revision</span>
        <span className="decide">✕ Reject — $1 back + $0.10 bond</span>
      </div>
      <p className="hw-art__sub">Silence for 48 hours counts as yes.</p>
    </div>
  );
}

export default function Home() {
  return (
    <>
      <Nav />

      <main id="top">
        {/* 01 · hero — drawn HQ instead of Syncly's office photo */}
        <section className="hx">
          <div className="hx__panel">
            <div className="hx__art" aria-hidden="true">
              <HqBuilding />
            </div>
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
                <a href="#services" className="pill white lg">
                  See what we do <span className="pill__ic">→</span>
                </a>
                <a href="#money" className="pill ghost lg">
                  How the AI CFO works <span className="pill__ic">→</span>
                </a>
              </div>
              <div className="hx__menu">
                {SERVICES.map((s) => (
                  <button key={s.id} type="button" onClick={() => selectJob(s.id)}>
                    {s.name.replace("Business website", "Website").replace("Flyers & price list", "Flyers")}
                  </button>
                ))}
              </div>
            </div>
            <div className="hx__foot mono">
              <span>Pay in USDT or cNGN · only if you accept · every job $1</span>
              <span>Scroll ↓</span>
            </div>
          </div>
        </section>

        {/* 01 · What we do — the services index Syncly opens with */}
        <section className="section" id="services">
          <div className="wrap">
            <div className="shead" style={{ textAlign: "left", margin: "0 0 40px" }}>
              <SectionLabel n="01">What we do</SectionLabel>
              <h2 className="h2" style={{ marginTop: 18 }}>
                Everything a small business needs done. $1 each.
              </h2>
              <p>
                Pick a job, fill a short form, and a team of AI agents does it.
                You see the price before anything starts and only pay if you
                accept the work.
              </p>
            </div>
            <div className="ww-grid">
              {SERVICES.map((s) => (
                <article key={s.id} className="card ww-card">
                  <ServicePreview kind={s.preview} />
                  <div className="ww-body">
                    <h3>{s.name}</h3>
                    <p>{s.tagline}</p>
                    <div className="ww-meta">
                      <span><b>$1</b> · ≈ ₦1,444</span>
                      <span>pay only if you accept</span>
                    </div>
                  </div>
                  <button type="button" className="ww-go" onClick={() => selectJob(s.id)}>
                    Order <span className="pill__ic">→</span>
                  </button>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* 02 · How it works — stacking cards with art, like Syncly's */}
        <section className="section tight" id="how">
          <div className="wrap">
            <div className="shead" style={{ textAlign: "left", margin: "0 0 40px" }}>
              <SectionLabel n="02">How it works</SectionLabel>
              <h2 className="h2" style={{ marginTop: 18 }}>
                Four steps. Pay only for work you accept.
              </h2>
            </div>
            <ol className="steps">
              {HOW.map((c, i) => (
                <li key={c.n} className="card step">
                  <div>
                    <span className="step__no">{c.n} / 04</span>
                    <h3>{c.h}</h3>
                    <p className="step__s">{c.s}</p>
                    <p>{c.p}</p>
                  </div>
                  <HowArt kind={c.art} />
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* 03 · Real work — Syncly's layout, honest empty state */}
        <section className="section tight" id="work">
          <div className="wrap">
            <div className="rw-grid">
              <div>
                <SectionLabel n="03">Real work</SectionLabel>
                <h2 className="h2" style={{ marginTop: 18 }}>
                  Real businesses. Real work. Starting now.
                </h2>
                <p className="lede" style={{ marginTop: 16, color: "var(--ink-2)", lineHeight: 1.6 }}>
                  Ikenga has no finished jobs to show yet — no customer story,
                  no job counts. The first real job will appear here, with its
                  job page, its escrow and its CFO decisions, once a named user
                  hires the team.
                </p>
                <div className="rw-stats">
                  <div><b>0</b><span>jobs delivered</span></div>
                  <div><b>0</b><span>businesses served</span></div>
                  <div><b>0</b><span>payments settled on Celo</span></div>
                </div>
                <div className="rw-cta">
                  <a href="#hire" className="pill dark">Be the first job <span className="pill__ic">→</span></a>
                  <a href="#money" className="pill green">See how the money moves <span className="pill__ic">→</span></a>
                </div>
              </div>
              <div className="rw-phone">
                <div className="phone big">
                  <i className="bar" />
                  <b className="h">Portraits that make you look twice</b>
                  <i className="l" /><i className="l s" />
                  <span className="btn">WhatsApp</span>
                  <div className="ph" />
                </div>
                <span className="rw-badge mono">First delivery preview · an illustration, not a real customer — yet</span>
              </div>
            </div>
            <p style={{ marginTop: 28, color: "var(--ink-2)", lineHeight: 1.6, maxWidth: 760 }}>
              What is real today: the money path is built and checked. A live
              Textile FX preview on Celo (verified 2026-11-21) turns $10 USDT
              into about <b>14,440 cNGN</b> — roughly ₦1,444 per dollar. The
              CFO pricing, the hash-chained ledger, the Celo x402 client and
              the Self Agent ID gate are all built and tested.
            </p>
          </div>
        </section>

        {/* 04 · Pay your way — three cards in a row, like Syncly's */}
        <section className="section tight" id="pay">
          <div className="wrap">
            <div className="shead" style={{ textAlign: "left", margin: "0 0 40px" }}>
              <SectionLabel n="04">Pay your way</SectionLabel>
              <h2 className="h2" style={{ marginTop: 18 }}>
                Pay in USDT or cNGN. Only if you accept.
              </h2>
            </div>
            <div className="paygrid3">
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
                <p className="fine">Bank transfer is not live yet — the naira desk converts USDT to cNGN on Celo.</p>
              </div>
              <div className="card paycard">
                <span className="chip">USDT</span>
                <p className="amount">$1</p>
                <p>
                  Pay <b>from your own wallet</b> on Celo. Works with MetaMask,
                  Rabby, Coinbase Wallet and other wallets. Your $1 waits in
                  escrow until you accept the work.
                </p>
                <p className="fine">USDT on another chain? Bridge it to Celo first.</p>
              </div>
              <div className="card paycard promise-card">
                <span className="chip">Our promise</span>
                <ul className="promise" style={{ marginTop: 16 }}>
                  <li><span><b>The price is fixed</b> before anything starts.</span></li>
                  <li><span><b>Your money waits in escrow</b>, not with us, until you accept.</span></li>
                  <li><span><b>One free revision</b> if it&rsquo;s not quite right.</span></li>
                  <li><span><b>Reject it</b> and you get your money back, plus a bond.</span></li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* 05 · Behind the scenes — the CFO, with the vault drawn */}
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
              <div className="vault">
                <div className="vault__head mono">
                  <span>IkengaVault · Celo mainnet</span>
                  <span>illustration · vault not yet deployed</span>
                </div>
                <div className="vault__buckets">
                  {BUCKETS.map((b) => (
                    <div key={b.key} className="vault__bucket">
                      <span className="vault__bar" style={{ background: b.color, width: "6%" }} />
                      <span className="vault__label mono">{b.label}</span>
                      <span className="vault__val mono">0.00 USDT</span>
                    </div>
                  ))}
                </div>
                <p className="vault__note">
                  Balances are 0 until the first job settles — the vault holds
                  nothing yet. Weekly tool budget: 30 USDT. An agent is paid
                  only after its Self Agent ID is verified.
                </p>
              </div>
              <div className="cfo-log">
                <span>
                  Decision log · <b>0</b> carried out · <b>0</b> to the Boss ·{" "}
                  <b>✓</b> log verified
                </span>
                <span>
                  No decisions yet — the first ones appear here once a job runs.
                </span>
                <a href="/api/cfo">Read the CFO&rsquo;s rules →</a>
              </div>
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
                  <p className="mono mf-stat"><span className="dot" /> 0 jobs delivered</p>
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
                  <p className="mono mf-stat">
                    {BUCKETS.map((b) => (
                      <i key={b.key} className="bucket-dot" style={{ background: b.color }} title={b.label} />
                    ))}
                    A plan sealed on Celo each week
                  </p>
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
                  <p className="mono mf-stat">
                    <span className="mf-faces">
                      {TEAM.slice(0, 5).map((a) => (
                        <span key={a.name} className="mf-face" title={a.name}>{a.name[0]}</span>
                      ))}
                      <span className="mf-more">+5</span>
                    </span>
                    10 agent wallets on Celo
                  </p>
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
                  <p className="mono mf-stat"><span className="dot" /> 0 paid · 0 settled on Celo · seller registry empty — no sellers pinned yet</p>
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
                  <p className="mono mf-stat">0x… · 0 entries · verified ✓</p>
                </div>
              </div>
            </div>
            <div className="mf-bar">
              <p>
                <b>Autonomous, inside hard limits.</b> The CFO acts alone only
                up to a limit the owner sets on the vault. Anything bigger is a
                proposal that only the owner&rsquo;s wallet can co-sign on Celo,
                and no language model ever touches the money.
              </p>
              <span className="mf-links">
                <a href="/api/cfo" className="pill green">The signed log <span className="pill__ic">→</span></a>
                <a href="https://github.com/vickman787/ikenga/blob/main/docs/spec.md" className="pill ghost light">The CFO&rsquo;s rules <span className="pill__ic">→</span></a>
              </span>
            </div>
            <div className="mf-pay">
              <span className="mf-new mono">New</span>
              <p>
                <b>Ikenga Pay — the naira leg.</b> The same escrow rules, for a
                real naira bill: USDT converts to cNGN on Textile FX and the
                supplier is paid in cNGN — only after the agent&rsquo;s Self
                Agent ID is verified.
              </p>
              <a href="#pay" className="pill dark">How the naira leg works <span className="pill__ic">→</span></a>
            </div>
          </div>
        </section>

        {/* 07 · The team — Syncly's pinned stage, as a stage header + grid */}
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
            <div className="tm-top mono">
              <span><span className="dot" /> Ikenga HQ</span>
              <span className="tm-prog">{TEAM.map((a) => <i key={a.name} />)}</span>
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
                    <p className="mono agent-stat"><span className="dot" /> 0 paid calls · waiting for the first one</p>
                  </div>
                </div>
              ))}
            </div>
            <p style={{ marginTop: 20, color: "var(--muted)", fontSize: 14, lineHeight: 1.6 }}>
              Tool sellers: the registry is empty — a seller is pinned only
              when the user approves that tool, so no agent can pay an
              unapproved supplier. On the team, waiting for their first paid
              call — the agents are built and gated by Self Agent ID, but no
              agent has been paid yet.
            </p>
          </div>
        </section>

        {/* 08 · The office — a drawn office scene, like Syncly's live office */}
        <section className="section tight" id="office">
          <div className="wrap">
            <div className="office-panel">
              <SectionLabel n="08">The office</SectionLabel>
              <h2 className="h2" style={{ marginTop: 18 }}>
                Watch them work. Every movement is a real event.
              </h2>
              <div className="office-scene">
                <HqBuilding big />
                <div className="office-desks">
                  {TEAM.map((a) => (
                    <span key={a.name} className="desk" title={`${a.name} — ${a.role}`}>
                      <span className="agent__avatar">{a.name[0]}</span>
                      <small>{a.name}</small>
                    </span>
                  ))}
                </div>
              </div>
              <p style={{ marginTop: 16, fontSize: "var(--lede)", color: "var(--ink-2)", maxWidth: 640, marginLeft: "auto", marginRight: "auto" }}>
                Every step an agent takes shows up on your job page — what it
                searched, what it read, what it paid for — linked to its
                payment on Celo.
              </p>
              <div className="office-bar mono">
                <span><span className="dot" /> Ikenga HQ · every movement is a real event</span>
                <span>The live office opens with the first job</span>
              </div>
            </div>
          </div>
        </section>

        {/* 09 · Questions — Syncly's two-column accordion layout */}
        <section className="section tight" id="questions">
          <div className="wrap qa-grid">
            <div>
              <SectionLabel n="09">Questions</SectionLabel>
              <h2 className="h2" style={{ marginTop: 18 }}>
                Before you order.
              </h2>
              <p style={{ marginTop: 16, fontSize: "var(--lede)", color: "var(--ink-2)" }}>
                Still unsure?{" "}
                <a href="https://github.com/vickman787/ikenga/blob/main/docs/spec.md">Read the spec</a>
                , or order the $1 job you need most and see for yourself.
              </p>
            </div>
            <div className="faq">
              {FAQ.map((f) => (
                <details key={f.q} className="card faq-item">
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* 10 · Start here — Syncly's dark close, with the hire form */}
        <section className="section tight" id="hire">
          <div className="wrap">
            <div className="dark-panel on-dark close-panel">
              <div className="close-grid">
                <div>
                  <SectionLabel n="10">Start here</SectionLabel>
                  <h2 className="h2" style={{ marginTop: 18 }}>
                    What should the team do for you?
                  </h2>
                  <p className="lede">
                    Pick a job and say what you need in a sentence. You see the
                    price before anything starts, and every job is $1.
                  </p>
                  <div style={{ maxWidth: 560, marginTop: 28 }}>
                    <HireForm />
                  </div>
                  <p className="mono" style={{ marginTop: 24, fontSize: 13, color: "var(--on-deep-3)" }}>
                    $1 a job · pay in USDT or cNGN · only if you accept · refund + bond if you reject
                  </p>
                </div>
                <div className="close-art" aria-hidden="true">
                  <span className="mono close-art__k">Your price, before anything starts</span>
                  <p className="close-art__big">$1</p>
                  <p className="close-art__sub">Every job. Fixed before you pay.</p>
                  <div className="close-art__rows">
                    <div><span>In escrow until you accept</span><b>$1 USDT</b></div>
                    <div><span>CFO bond if you reject</span><b>$0.10</b></div>
                    <div><span>One free revision</span><b>included</b></div>
                  </div>
                  <span className="chip live"><span className="dot" /> Escrow · CFO · Self-verified agents</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap footer__inner">
          <div className="foot-brand">
            <a href="#top" className="nav__logo">
              <span className="nav__mark">I</span> Ikenga
            </a>
            <p style={{ marginTop: 12 }}>
              Your business&rsquo;s AI team: websites, flyers, promo videos and
              a money report, $1 a job. Pay in USDT or cNGN, only if you
              accept. An AI CFO runs the money, inside limits a smart contract
              on Celo enforces.
            </p>
          </div>
          <div className="foot-col">
            <h5 className="mono">Hire the team</h5>
            <ul>
              <li><a href="#services">Services</a></li>
              <li><a href="#how">How it works</a></li>
              <li><a href="#work">Real work</a></li>
              <li><a href="#pay">Pay in USDT or cNGN</a></li>
              <li><a href="#questions">Questions</a></li>
            </ul>
          </div>
          <div className="foot-col">
            <h5 className="mono">How Ikenga runs</h5>
            <ul>
              <li><a href="#cfo">The AI CFO</a></li>
              <li><a href="#money">Follow the money</a></li>
              <li><a href="#team">The team</a></li>
              <li><a href="#office">The office</a></li>
              <li><a href="#pay">Ikenga Pay — the naira leg</a></li>
            </ul>
          </div>
          <div className="foot-col">
            <h5 className="mono">Proof</h5>
            <ul>
              <li><a href="https://github.com/vickman787/ikenga/tree/main/docs">Docs</a></li>
              <li><a href="/api/cfo">The CFO&rsquo;s signed log</a></li>
              <li><a href="/api/traction">Live numbers</a></li>
              <li><a href="https://github.com/vickman787/ikenga">Source code</a></li>
            </ul>
          </div>
          <div className="foot-col">
            <h5 className="mono">On Celo</h5>
            <ul>
              <li><a href="https://celoscan.io/token/0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" target="_blank" rel="noreferrer">USDT on Celo ↗</a></li>
              <li><a href="https://celoscan.io/token/0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f" target="_blank" rel="noreferrer">cNGN on Celo ↗</a></li>
              <li><a href="https://celoscan.io/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" target="_blank" rel="noreferrer">ERC-8004 registry ↗</a></li>
              <li><a href="https://textilecredit.com" target="_blank" rel="noreferrer">Textile FX ↗</a></li>
            </ul>
          </div>
        </div>
        <div className="wrap foot-base mono">
          <span>© 2026 Ikenga</span>
          <span>Settled in USDT on Celo · Attribution celo_5144280c393f</span>
        </div>
      </footer>
    </>
  );
}
