"use client";

import { useState, type ReactNode } from "react";
import { type JobType } from "@ikenga/shared";
import "./workspace.css";

type IconName = "grid" | "work" | "wallet" | "team" | "book" | "plus" | "shield" | "globe" | "play" | "flyer" | "chart" | "search" | "check" | "menu";
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    work: <><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M8 7V4h8v3M3 12a24 24 0 0 0 18 0M10 13h4" /></>,
    wallet: <><path d="M20 8V5H5a2 2 0 0 0 0 4h16v11H5a2 2 0 0 1-2-2V7" /><path d="M21 12h-6v5h6M17 14.5h.01" /></>,
    team: <><circle cx="9" cy="7" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5v2" /></>,
    book: <><path d="M12 5C8 2 4 3 2 4v16c4-2 7-1 10 1 3-2 6-3 10-1V4c-3-1-7-2-10 1ZM12 5v16" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    shield: <><path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z" /><path d="m8 12 3 3 5-6" /></>,
    globe: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M2 9h20M6 6.5h.01M9 6.5h.01M12 13h6M12 16h4M6 13v4" /></>,
    play: <><rect x="2" y="4" width="20" height="16" rx="3" /><path d="m10 8 6 4-6 4Z" /></>,
    flyer: <><path d="M6 2h9l4 4v16H6ZM14 2v5h5M9 11h7M9 15h7M9 18h4" /></>,
    chart: <path d="M3 3v18h18M7 16v-4M12 16V8M17 16V5" />,
    search: <><circle cx="10" cy="10" r="7" /><path d="m15 15 6 6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
const SERVICES: { id: JobType; title: string; detail: string; icon: IconName; tag: string }[] = [
  { id: "website", title: "Business website", detail: "A home for your business. Your services, your story, and a way for customers to reach you.", icon: "globe", tag: "Your business, online" },
  { id: "flyers", title: "Flyers & price list", detail: "Your best offers, beautifully presented. Clear prices and your brand, ready to share.", icon: "flyer", tag: "Make a good impression" },
  { id: "promo-video", title: "Promo slideshow", detail: "Give your next promotion a little motion. Animated slides, not a downloadable video file.", icon: "play", tag: "Give your story motion" },
  { id: "market-report", title: "Market report", detail: "Understand your market with research, useful comparisons, and sources you can check.", icon: "chart", tag: "Make your next move" },
];
export interface TreasuryVault { currency: string; vaultAddress: string | null; tokenAddress: string; tokenSymbol: string; tokenBalance: string; buckets: { operating: string; tools: string; bond: string; reserve: string } }
function formatTokenAmount(atomic: string): string {
  if (!/^\d+$/.test(atomic)) return "—";
  const amount = BigInt(atomic);
  const whole = (amount / 1_000_000n).toLocaleString("en-NG");
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return whole + "." + fraction;
}
interface Live { vaults: TreasuryVault[] | null; jobs: number | null; done: number | null; settled: number | null; customers: number | null; verifyOk: boolean | null; onchainDecisions: number | null; vaultError: boolean; vault: { operating: string; tools: string; bond: string; reserve: string; total: string } | null }

function ServiceArt({ kind }: { kind: JobType }) {
  return <div className={`ws-art ws-art--${kind}`} aria-hidden="true">
    {kind === "website" ? <div className="ws-mini-site"><div className="ws-mini-bar"><b>adé studio</b><span>Work &nbsp; About &nbsp; Contact</span></div><div className="ws-mini-site-body"><div><small>MADE WITH INTENTION</small><strong>Good things.<br />Beautifully made.</strong><i>Explore our work</i></div><div className="ws-sculpture"><span /><span /><span /></div></div></div>
      : kind === "flyers" ? <div className="ws-mini-flyer"><small>THE WEEKEND EDIT</small><strong>A little joy.<br /><em>A lot of flavour.</em></strong><div className="ws-flyer-dish"><i /><i /><i /></div><span>FRESHLY MADE · READY TO SHARE</span></div>
      : kind === "promo-video" ? <div className="ws-mini-video"><small>YOUR NEXT BIG THING</small><strong>Made to<br /><em>stand out.</em></strong><div className="ws-video-play"><Icon name="play" size={24} /></div><div className="ws-video-track"><i /></div><span>ILLUSTRATIVE SLIDESHOW</span></div>
      : <div className="ws-mini-report"><div><b>Market overview</b><span>Research & insights</span></div><div className="ws-report-chart">{[35, 55, 43, 73, 61, 90, 76].map((height, i) => <i key={i} style={{ height: `${height}%` }} />)}</div><div className="ws-report-lines"><i /><i /><i /></div></div>}
    <span className="ws-art-label">Illustrative preview</span>
  </div>;
}
function selectJob(id: JobType) {
  window.dispatchEvent(new CustomEvent("ikenga:select-job", { detail: id }));
  document.getElementById("hire")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
export default function WorkspaceHome({ live, children }: { live: Live; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);
  return <div className="ws-shell" id="top">
    <a className="ws-skip" href="#workspace">Skip to content</a>
    <aside className={`ws-sidebar${menuOpen ? " is-open" : ""}`} id="workspace-navigation" aria-label="Workspace navigation">
      <a className="ws-brand" href="/" aria-label="Ikenga home"><img src="/logo-mark.png" width="44" height="44" alt="" /><span>ikenga<small>YOUR BUSINESS’S AI TEAM</small></span></a>
      <span className="ws-nav-label">WORKSPACE</span>
      <nav onClick={closeMenu} aria-label="Workspace">
        <a className="is-current" href="#workspace"><Icon name="grid" />Overview</a>
        <a href="#services"><Icon name="globe" />Services<span className="ws-nav-count">4</span></a>
        <a href="/jobs"><Icon name="work" />My jobs</a>
        <a href="#work"><Icon name="chart" />Activity totals</a>
        <a href="#pay"><Icon name="wallet" />USDT & cNGN</a>
        <a href="/bills"><Icon name="wallet" />Pay a naira bill</a>
      </nav>
      <span className="ws-nav-label">BEHIND THE WORK</span>
      <nav onClick={closeMenu} aria-label="About Ikenga">
        <a href="#team"><Icon name="team" />Meet your team</a>
        <a href="#cfo"><Icon name="shield" />The AI CFO</a>
        <a href="#money"><Icon name="chart" />Follow the money</a>
        <a href="/activity"><Icon name="shield" />Activity & transparency</a>
        <a href="#office"><Icon name="team" />The office</a>
        <a href="#questions"><Icon name="book" />Questions</a>
        <a href="https://github.com/vickman787/ikenga/tree/main/docs" target="_blank" rel="noreferrer"><Icon name="book" />Documentation</a>
      </nav>
      <div className="ws-sidebar-bottom"><div className="ws-small-promise"><Icon name="shield" /><b>Your money has a waiting room.</b><p>Payments stay in escrow while the team does the work.</p><a href="#how" onClick={closeMenu}>How escrow works</a></div><div className="ws-chain"><span />Built on Celo<small>USDT · cNGN</small></div></div>
    </aside>
    {menuOpen && <button className="ws-backdrop" aria-label="Close navigation" onClick={closeMenu} />}
    <div className="ws-main">
      <header className="ws-topbar"><div><button className="ws-menu-toggle" type="button" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} aria-controls="workspace-navigation" aria-label="Toggle navigation"><Icon name="menu" /></button><span className="ws-breadcrumb">Workspace <span>/</span> <b>Overview</b></span></div><div><a className="ws-text-link ws-my-jobs" href="/jobs">My jobs</a><a className="ws-button ws-button--dark" href="#hire"><Icon name="plus" size={17} />New job</a></div></header>
      <main className="ws-content" id="workspace">
        <div className="ws-page-heading"><div><span className="ws-eyebrow">SMALL BUSINESS. BIG POSSIBILITIES.</span><h1>Good work starts here.</h1><p>Your next website, flyer, or bright idea. A whole AI team to make it happen.</p></div><span className="ws-network-badge"><span />Celo mainnet</span></div>
        <section className="ws-hero" aria-labelledby="hero-title"><div className="ws-hero-copy"><span className="ws-hero-kicker"><span />A LITTLE HELP GOES A LONG WAY</span><h2 id="hero-title">You build the business.<br />We’ll handle <em>the busywork.</em></h2><p>Brief the team. Follow the work. Review the result.<br />Pay in USDT or cNGN. Every job is $1, held in escrow.</p><div className="ws-hero-actions"><a href="#services" className="ws-button ws-button--leaf">Find your next service</a><a href="#how">See how it works</a></div><div className="ws-hero-assurances"><span><Icon name="check" size={15} />One free revision</span><span><Icon name="shield" size={15} />Escrow on Celo</span></div></div><div className="ws-hero-visual" aria-label="Every job costs one US dollar"><div className="ws-price-orbit" /><div className="ws-price-card"><span>BIG IDEAS. SMALL PRICE.</span><strong><sup>$</sup>1</strong><div>per job. that’s it.</div><hr /><span>WEBSITE · FLYER · SLIDESHOW · REPORT</span></div><div className="ws-float-note"><span><Icon name="shield" size={18} /></span><div><b>Your call, always.</b><small>Review before you accept.</small></div></div></div></section>
        <section className="ws-metrics" aria-label="Recorded customer activity">{([{ value: live.done, label: "Jobs delivered", icon: "work" }, { value: live.customers, label: "Paying customer wallets", icon: "team" }, { value: live.settled, label: "Jobs accepted", icon: "check" }, { value: "$1", label: "Every job", icon: "wallet" }] as const).map(({ value, label, icon }) => <div className="ws-metric" key={label}><span className="ws-metric-icon"><Icon name={icon} /></span><div><strong>{value === null ? "—" : value}</strong><span>{label}</span></div></div>)}</section>
        <section id="pay" className="ws-section ws-currencies" aria-labelledby="payment-title">
          <div className="ws-section-heading"><div><span className="ws-eyebrow">YOUR BUSINESS. YOUR CURRENCY.</span><h2 id="payment-title">Pay in dollars. Or pay in naira.</h2><p>The same $1 job. The same escrow protection. Choose USDT or cNGN on Celo.</p></div></div>
          <div className="ws-currency-grid">
            <article className="ws-currency-card"><span className="ws-token ws-token--usdt">$</span><div><span className="ws-currency-name">USDT</span><h3>One dollar. Simple.</h3><p>Pay 1 USDT from your Celo wallet. The job’s escrow holds it while the team works.</p><a className="ws-text-link" href="#hire">Start a $1 job</a></div></article>
            <article className="ws-currency-card ws-currency-card--cngn"><span className="ws-token ws-token--cngn">₦</span><div><span className="ws-currency-name">cNGN <small>NAIRA ON CELO</small></span><h3>The naira way to pay.</h3><p>Pay the $1 equivalent in cNGN at the live Textile FX rate. See the exact amount in the hire form; it is fixed when you create the job.</p><a className="ws-text-link" href="#hire">Choose cNGN in the hire form</a></div></article>
          </div>
          <p className="ws-currency-note"><Icon name="shield" size={16} />Both currencies use your job’s escrow contract. cNGN is an onchain token; bank transfers are not available.</p>
        </section>
        <section id="services" className="ws-section"><div className="ws-section-heading"><div><h2>What can we take off your plate?</h2><p>Pick a service. Your team takes it from there.</p></div><span className="ws-subtle">Four services. One simple price.</span></div><div className="ws-service-grid">{SERVICES.map(service => <article className="ws-service" key={service.id}><ServiceArt kind={service.id} /><div className="ws-service-body"><span className="ws-service-tag">{service.tag}</span><h3><Icon name={service.icon} />{service.title}</h3><p>{service.detail}</p><div className="ws-service-bottom"><span><b>$1</b><small> / job</small></span><button type="button" onClick={() => selectJob(service.id)}>Create job<Icon name="plus" size={16} /></button></div></div></article>)}</div></section>
        <section id="work" className="ws-section ws-activity" aria-labelledby="activity-title">
          <div className="ws-section-heading"><div><h2 id="activity-title">A little proof of progress.</h2><p>Customer activity at a glance. Individual briefs and finished work are not listed here.</p></div></div>
          <div className="ws-metrics" aria-label="Customer activity summary">{([{ value: live.done, label: "Jobs delivered", icon: "work" }, { value: live.settled, label: "Jobs accepted", icon: "check" }, { value: live.customers, label: "Paying customer wallets", icon: "team" }] as const).map(({ value, label, icon }) => <div className="ws-metric" key={label}><span className="ws-metric-icon"><Icon name={icon} /></span><div><strong>{value ?? "—"}</strong><span>{label}</span></div></div>)}</div>
          <p className="ws-activity-note">Totals cover real customer activity and exclude test runs. This public summary contains no job links, wallet addresses, or customer briefs.</p>
        </section>
        <section id="how" className="ws-section"><div className="ws-section-heading"><div><span className="ws-eyebrow">FROM BRIEF TO BETTER BUSINESS</span><h2>A small job. A straightforward process.</h2></div></div><div className="ws-how-grid">{([{ icon: "book", title: "Tell us what you need", text: "Choose a service and write a short brief. See the price before you pay." }, { icon: "shield", title: "Fund your job securely", text: "Use your Celo wallet. Your payment goes into the job’s escrow contract." }, { icon: "team", title: "Let the team get to work", text: "Follow the research, creation, and quality checks from your job page." }, { icon: "check", title: "Review. Then decide.", text: "Accept the result, request one revision, or reject for a refund. The escrow has a 48-hour release deadline from funding." }] as const).map(step => <div className="ws-how-card" key={step.title}><Icon name={step.icon} size={23} /><h3>{step.title}</h3><p>{step.text}</p></div>)}</div></section>
        <div className="ws-bottom-grid"><section id="cfo" className="ws-cfo"><span className="ws-eyebrow">THE AI CFO</span><h2>Creative minds.<br />Accountable money.</h2><p>The team creates. Code sets the price and controls the money. Decision records are hash-chained. Each job includes its own activity trail.</p><div className="ws-cfo-value"><span>Jobs accepted</span><b>{live.settled ?? "—"}</b></div><div className="ws-cfo-value"><span>Audit chain</span><b>{live.verifyOk === null ? "Awaiting data" : live.verifyOk ? "Verified" : "Check required"}</b></div><a className="ws-text-link" href="/activity#audit">View audit summary</a></section><section id="ikenga-pay" className="ws-pay"><span className="ws-pay-symbol"><Icon name="wallet" size={28} /></span><span className="ws-eyebrow">IKENGA PAY</span><h2>Your bill is in naira.<br />Your wallet is in USDT.</h2><p>Set up a naira bill and a target exchange rate. Ikenga converts USDT to cNGN through Textile FX and pays your supplier’s Celo wallet.</p><a className="ws-button ws-button--dark" href="/bills">Pay a naira bill</a><small>On Celo · no bank transfer option</small></section></div>
        <section className="ws-section" id="team"><div className="ws-section-heading"><div><h2>A team behind every task.</h2><p>Different roles. One shared brief. Follow their steps on your job page.</p></div></div><div className="ws-team">{[["S", "Scout", "Finds the sources"], ["R", "Researcher", "Builds the plan"], ["R", "Reader", "Reads the sources"], ["W", "Writer", "Finds the words"], ["D", "Designer", "Brings it to life"], ["P", "Producer", "Creates the motion"], ["I", "Investigator", "Checks the escrow"], ["A", "Analyst", "Checks the details"], ["A", "Auditor", "Reviews the result"], ["M", "Messenger", "Delivers your work"]].map(([initial, name, role], i) => <div key={name}><span className={`ws-avatar ws-avatar--${i}`}>{initial}</span><div><b>{name}</b><small>{role}</small></div></div>)}</div></section>
        <section className="ws-section" id="money">
          <div className="ws-section-heading"><div><span className="ws-eyebrow">FOLLOW THE MONEY</span><h2>From your payment to the audit trail.</h2><p>Escrow, treasury, agent allowances, tool payments, and a record of the decisions.</p></div></div>
          <div className="ws-treasury"><div className="ws-treasury-heading"><div><h3>Treasury buckets</h3><p>Each currency has its own vault. Balances below come from the existing onchain vault API.</p></div><span className="ws-network-badge"><span />Celo</span></div>
            {live.vaults?.map(vault => <section className="ws-vault-currency" key={vault.currency} aria-label={vault.currency + " treasury"}>
              <div className="ws-vault-heading"><div><span className={"ws-token " + (vault.currency === "cNGN" ? "ws-token--cngn" : "ws-token--usdt")}>{vault.currency === "cNGN" ? "₦" : "$"}</span><div><h4>{vault.currency} vault</h4><span>{vault.currency === "cNGN" ? "Naira on Celo" : "Dollar stablecoin on Celo"}</span></div></div>
                {vault.vaultAddress ? <a className="ws-text-link" href={"https://celoscan.io/address/" + vault.vaultAddress} target="_blank" rel="noreferrer">View {vault.currency} contract</a> : <span className="ws-subtle">Vault not deployed</span>}
              </div>
              {vault.vaultAddress ? <><div className="ws-buckets">{(["operating", "tools", "bond", "reserve"] as const).map(bucket => <div key={bucket}><span>{bucket}</span><strong>{formatTokenAmount(vault.buckets[bucket])}</strong><small>{vault.tokenSymbol}</small></div>)}</div><p className="ws-vault-balance">Token balance: <b>{formatTokenAmount(vault.tokenBalance)} {vault.tokenSymbol}</b></p></> : <p className="ws-treasury-note">No deployed vault is configured for this currency.</p>}
            </section>)}
            {live.vaults === null && <p className="ws-treasury-note" role="status">{live.vaultError ? "The vault balances could not be read right now. No estimated balances are shown." : "Loading USDT and cNGN vault balances…"}</p>}
            <p className="ws-treasury-note">USDT and cNGN stay separate. Each vault has operating, tools, bond, and reserve buckets.</p>
          </div>
          <div className="ws-money-grid">{[["Customer escrow", "Your payment goes into your job’s contract. Acceptance, rejection, and deadline release follow its existing rules."], ["Treasury", "Released payments reach the appropriate vault. The contract controls bucket movements and per-call limits."], ["Agent allowances", "The vault tracks hired agents and limits their tool allowances within its weekly budget."], ["Tool payments", "The payment package supports x402 and approved sellers. Model usage is paid through the configured OpenAI account."], ["Audit trail", "Every recorded decision is hash-chained. Onchain receipts link back to their transactions; cryptographic signing is not yet enabled."]].map(([title, text]) => <article key={title}><h3>{title}</h3><p>{text}</p></article>)}</div>
          <div className="ws-proof-links"><a href="/activity#audit">Audit summary</a><a href="/activity">Live activity numbers</a><span>{live.onchainDecisions ?? "—"} recorded onchain receipts</span><a href="https://github.com/vickman787/ikenga/blob/main/docs/spec.md" target="_blank" rel="noreferrer">CFO rules</a></div>
        </section>
        <section className="ws-section ws-office" id="office"><div><span className="ws-eyebrow">THE OFFICE</span><h2>One brief. Ten roles. Work you can follow.</h2><p>Your job page keeps the team’s actual progress: sources gathered, work created, quality checks, and the delivery receipt.</p><a href="#work" className="ws-text-link">See activity totals</a></div><div className="ws-office-board">{["Scout", "Researcher", "Reader", "Writer", "Designer", "Producer", "Investigator", "Analyst", "Auditor", "Messenger"].map(name => <span key={name}><Icon name="team" size={17} />{name}</span>)}<small>Team overview · live progress appears on each job page</small></div></section>
        <section className="ws-section" id="questions"><div className="ws-section-heading"><div><span className="ws-eyebrow">BEFORE YOU ORDER</span><h2>A few useful answers.</h2></div></div><div className="ws-faq">{[
          ["Do I need crypto?", "Yes. Connect a Celo wallet and pay in USDT or cNGN. You also need CELO for network fees. Bank transfer is not available."],
          ["What if I don’t like the work?", "You can request one free revision or reject the work for a refund through the existing escrow flow. New job escrows currently use a zero bond; there is no extra bond payout."],
          ["How fast is it?", "Jobs run in stages over a few minutes, depending on the service and model availability. Follow the actual steps on your job page."],
          ["Is it really $1?", "Each job costs 1 USDT or the equivalent cNGN amount at the live rate. The cNGN price is fixed when you create the job. Blockchain network fees are separate."],
          ["Who does the work?", "Ten AI roles handle research, reading, writing, design, production, investigation, analysis, auditing, and delivery. The roles used depend on the service you choose."],
          ["What is Self Agent ID?", "Self Agent ID is the agent identity verification integration. The app records the outcome of its checks in the existing ledger."],
          ["Is Ikenga live on Celo mainnet?", "Yes. The original escrow and vault configuration uses Celo mainnet. Existing jobs retain their original records and contract addresses."],
          ["Is my information private?", "Your job history, briefs, and delivered work require a verified wallet sign-in. Public activity shows totals only. Blockchain transactions and any content you choose to publish remain public."]
        ].map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</div></section>
        <div className="ws-proof-links ws-chain-links"><a href="https://celoscan.io/token/0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" target="_blank" rel="noreferrer">USDT on Celo</a><a href="https://celoscan.io/token/0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f" target="_blank" rel="noreferrer">cNGN on Celo</a><a href="https://celoscan.io/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" target="_blank" rel="noreferrer">Agent identity registry</a><a href="https://textilecredit.com" target="_blank" rel="noreferrer">Textile FX</a><a href="/agent.json">Agent registration</a></div>
        <section id="hire" className="ws-section ws-hire"><div className="ws-hire-intro"><span className="ws-eyebrow">YOUR NEXT GOOD IDEA STARTS HERE</span><h2>What’s on your<br />to-do list?</h2><p>Give the team a clear brief. Connect your wallet. Follow every step, all the way to the finished work.</p><div><Icon name="shield" size={22} /><span><b>Your wallet. Your decision.</b><small>Your payment stays in the job’s escrow contract until acceptance, rejection, or deadline release.</small></span></div></div><div className="ws-hire-form">{children}</div></section>
        <footer className="ws-footer"><a className="ws-footer-brand" href="#top"><img src="/logo-mark.png" alt="" width="28" height="28" />ikenga</a><span>Built for the business you’re building.</span><div><a href="https://github.com/vickman787/ikenga" target="_blank" rel="noreferrer">Source code</a><a href="/activity">Live numbers</a><span>© {new Date().getFullYear()} Ikenga</span></div></footer>
      </main>
    </div>
  </div>;
}
