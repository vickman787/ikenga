import type { Metadata } from "next";
import "./docs.css";

export const metadata: Metadata = {
  title: "Documentation | Ikenga",
  description: "Learn how to order work, review deliveries, use USDT or cNGN, pay a supplier bill, and find your history in Ikenga.",
};
const contents = [["start", "Start here"], ["services", "What you can order"], ["jobs", "Your first job"], ["escrow", "Payments & escrow"], ["pay", "Ikenga Pay"], ["history", "History & privacy"], ["technology", "Under the hood"], ["help", "Troubleshooting"]] as const;
const services = [
  { tag: "WEB", name: "Business website", text: "A responsive single-page site with an in-app preview and downloadable HTML. Provide your services, prices, audience, preferred style, and contact.", note: "A domain and separate website hosting are not included automatically." },
  { tag: "PRINT", name: "Flyers & price lists", text: "Branded artwork for an offer, menu, or price list. New-format deliveries include PNG and PDF exports using the same artwork as the preview.", note: "Check every price, contact detail, and offer before publishing." },
  { tag: "MOTION", name: "Promo video", text: "Designed, animated slides with your message and call to action. New-format deliveries support silent video export: MP4 where supported, otherwise WebM.", note: "Voiceover is not included. Keep the export tab open and visible." },
  { tag: "RESEARCH", name: "Market report", text: "A structured report with findings, source links, comparisons where relevant, evidence limits, and suggested next steps.", note: "Provide the question, market, location, and decision you need help with." },
];
const technology = [
  ["Celo & escrow", "Celo mainnet (chain ID 42220) records job payments and settlements. Every job has its own escrow address; there is no universal job-payment address."],
  ["Textile FX", "Provides exchange previews and executable quotes for the USDT-to-cNGN supplier-payment flow."],
  ["x402", "Supports approved agent tool payments with payee checks and spending caps. It does not mean every model request is paid through x402: OpenAI calls are billed to the configured provider account."],
  ["Self Agent ID", "Integrates human-backed agent verification. Verification outcomes are recorded; an agent registration alone does not prove a current successful Self verification."],
  ["ERC-8004", "Ikenga’s public agent identity is registration 10106 on Celo. This registration is separate from Self verification."],
  ["The AI CFO", "Applies coded pricing, budgets, FX decisions, and transaction checks. Decision records form a hash chain for consistency checks; a matching chain does not prove a model’s factual claims are correct."],
];
const questions = [
  ["I cannot find my previous work.", "Open My jobs and sign in with the wallet that created the job. If you used another wallet, sign out and reconnect it. For bills, history appears after verified funding ties the bill to that wallet."],
  ["The cNGN quote is still loading.", "A valid exchange quote is needed to set the cNGN job price. Wait and retry if the rate service is unavailable. Do not send an estimated cNGN amount manually."],
  ["My bill is watching. Has the supplier been paid?", "No. The worker is watching the rate or waiting for the conditions to convert. Look for the supplier payout receipt to confirm payment. Funding the bill and paying the supplier are different events."],
  ["Why does my bill need more USDT?", "The executable quote can change before conversion. Review the current shortfall and funding already recorded before sending a top-up. Do not repeat a payment merely because a page has not refreshed."],
  ["How long will a job or bill take?", "Model calls, quality checks, worker scheduling, exchange quotes, and chain confirmations affect timing. Use the detail page for the actual state. Review creative work before the 48-hour escrow deadline measured from funding."],
  ["Can I download the finished work?", "Use the delivery page’s controls. New-format websites export HTML, flyers export PNG/PDF, and promos export silent MP4 or WebM where supported. Older deliveries retain their available controls."],
  ["Does connecting my wallet let the site spend my money?", "Connecting identifies your wallet. Signing in proves ownership. Token approvals and transfers are separate wallet transactions: review the token, amount, network, and recipient before confirming."],
];

export default function DocumentationPage() {
  return <div className="ik-docs">
    <a className="docs-skip" href="#docs-content">Skip to documentation</a>
    <header className="docs-header">
      <a className="docs-brand" href="/" aria-label="Ikenga home"><img src="/logo-mark.png" alt="" width="34" height="34" /><strong>ikenga</strong><span>/ Documentation</span></a>
      <nav aria-label="Documentation shortcuts"><a href="/jobs">My jobs</a><a className="docs-button" href="/#hire">Create a job ↗</a></nav>
    </header>
    <div className="docs-layout">
      <aside className="docs-sidebar">
        <span className="docs-eyebrow">THE IKENGA GUIDE</span>
        <nav aria-label="Documentation contents">{contents.map(([id, label], i) => <a key={id} href={`#${id}`}><span>{String(i + 1).padStart(2, "0")}</span>{label}</a>)}</nav>
        <div className="docs-sidebar-note"><strong>A little clarity goes a long way.</strong><p>Learn the flow before you connect your wallet.</p><a href="/">← Back to workspace</a></div>
      </aside>
      <main id="docs-content" className="docs-content">
        <section id="start" className="docs-intro">
          <span className="docs-eyebrow">YOUR BUSINESS. YOUR TEAM. YOUR CALL.</span>
          <h1>Good work.<br /><em>Clearly explained.</em></h1>
          <p className="docs-lead">Everything you need to use Ikenga, from your first brief to your final receipt.</p>
          <p>Ikenga is an AI team for small businesses. Order a website, flyer, promo video, or market report for $1 per job. The separate Ikenga Pay service lets you fund a supplier bill in USDT and pay it in cNGN on Celo.</p>
          <div className="docs-quick-links"><a href="#jobs"><span>01 / CREATE</span><strong>Order your first job →</strong></a><a href="#pay"><span>02 / PAY</span><strong>Pay a supplier bill →</strong></a><a href="#history"><span>03 / RETURN</span><strong>Find previous work →</strong></a></div>
          <div className="docs-callout"><strong>Before you begin</strong><p>Use a wallet that supports Celo mainnet. Keep your chosen payment token in the wallet and a little CELO for network fees. Signing in proves wallet ownership; a payment requires a separate wallet confirmation.</p></div>
        </section>
        <section id="services" className="docs-section">
          <span className="docs-eyebrow">01 / THE SERVICES</span><h2>What can the team make?</h2><p>Provide confirmed business details, prices, contact information, and a clear goal. More specific briefs give the team a better foundation.</p>
          <div className="docs-service-grid">{services.map(service => <article key={service.tag}><span>{service.tag}</span><h3>{service.name}</h3><p>{service.text}</p><small>{service.note}</small></article>)}</div><p className="docs-caption">Older jobs keep their saved content and original available download controls.</p>
        </section>
        <section id="jobs" className="docs-section">
          <span className="docs-eyebrow">02 / FROM BRIEF TO DELIVERY</span><h2>Your first job, step by step.</h2>
          <ol className="docs-steps">
            <li><h3>Choose a service and write your brief</h3><p>Open <a href="/#hire">Create a job</a>. Add your business name, contact, audience, brand direction, and the facts the finished work must contain. Avoid passwords, wallet keys, or confidential customer data.</p></li>
            <li><h3>Choose USDT or cNGN</h3><p>A job costs 1 USDT or the quoted cNGN equivalent. The cNGN price is fixed when the job is created. Network fees are separate. Review the quote before continuing.</p></li>
            <li><h3>Connect your wallet and fund escrow</h3><p>Use the Celo wallet that will own the job. Confirm deployment, token approval, and funding steps when prompted. The team starts after funding is confirmed.</p></li>
            <li><h3>Follow the work</h3><p>The job page shows progress and quality checks. The scheduled worker can continue processing while you are away. Return through <a href="/jobs">My jobs</a> with the same wallet.</p></li>
            <li><h3>Review, then decide</h3><p>Inspect and download the deliverable. Request one free revision while the job is eligible. Accept to release payment, or reject to invoke the escrow refund. These actions require the paying wallet.</p></li>
          </ol>
          <div className="docs-example"><span className="docs-eyebrow">AN EXAMPLE BRIEF</span><h3>Give facts, not just “make it nice.”</h3><p>“Create a one-page website for Nkem’s Kitchen in Lekki. Jollof bowl: ₦3,500. Chicken: ₦2,500. Use burgundy and cream, include a menu and opening hours, and send enquiries to orders@example.test. Do not invent reviews or delivery promises.”</p><small>Fictional business details, for illustration.</small></div>
        </section>
        <section id="escrow" className="docs-section">
          <span className="docs-eyebrow">03 / THE MONEY RULES</span><h2>Your payment has a waiting room.</h2><p>You fund the job’s escrow <strong>before</strong> work starts. Acceptance or rejection happens <strong>after</strong> you review the result.</p>
          <div className="docs-flow" aria-label="Job payment flow"><span>Fund escrow</span><b aria-hidden="true">→</b><span>Team creates</span><b aria-hidden="true">→</b><span>You review</span><b aria-hidden="true">→</b><span>Accept / reject</span></div>
          <dl className="docs-definitions">
            <div><dt>If you accept</dt><dd>The escrow releases the job price to the matching currency vault after a deliverable fingerprint has been submitted.</dd></div>
            <div><dt>If you reject</dt><dd>The escrow returns the job price to the customer wallet. Network fees already spent are separate. New jobs currently use a zero bond.</dd></div>
            <div><dt>If the deadline passes</dt><dd>After 48 hours from funding, anyone may call the contract’s deadline-release function to release payment to the vault. This clock starts at funding, not delivery. Time passing alone does not send a transaction.</dd></div>
            <div><dt>USDT and cNGN</dt><dd>Each has a separate treasury vault. A cNGN job settles in cNGN; acceptance does not convert it into USDT.</dd></div>
          </dl>
          <div className="docs-callout docs-callout--warm"><strong>Review before the escrow deadline.</strong><p>Acceptance is not the only settlement path. Check your job page and contract receipts, and make your decision in time.</p></div>
        </section>
        <section id="pay" className="docs-section">
          <span className="docs-eyebrow">04 / IKENGA PAY</span><h2>Owe naira. Fund in USDT.</h2><p>Ikenga Pay exchanges funded USDT into cNGN through Textile FX, then pays the supplier’s Celo wallet. It is separate from creative jobs.</p>
          <ol className="docs-steps">
            <li><h3>Create a bill</h3><p>Open <a href="/bills">Pay a naira bill</a>. Enter the payer name, purpose, naira amount, supplier’s Celo address, due date, and the lowest naira-per-dollar rate you will accept. Creating a bill spends nothing.</p></li>
            <li><h3>Review and fund</h3><p>Wait for the worker’s quote, review the required USDT amount, and confirm the transfer from your wallet to the displayed agent wallet. A manually supplied funding transaction hash must be verified on-chain before it counts.</p></li>
            <li><h3>Watch the rate</h3><p>Before the due date, the worker waits below your minimum rate. At or above it, a valid executable quote and sufficient funding allow conversion. At the deadline, it can proceed below your minimum, subject to funding, liquidity, gas, and a valid quote.</p></li>
            <li><h3>Follow conversion and payout</h3><p>The bill page records funding, rate checks, conversion, and the supplier transfer as they happen. Conversion and payout are separate steps. The worker checks periodically; completion is not guaranteed at a fixed time.</p></li>
          </ol>
          <div className="docs-callout docs-callout--warm"><strong>Understand where bill funding goes.</strong><p>USDT is held in the operator-controlled agent wallet, not a creative-job escrow. A bill does not have the same rejection/refund protection. The supplier receives cNGN on Celo, not a bank transfer.</p><p>If required USDT rises, the bill may need a top-up. Unused USDT is not automatically refunded.</p></div>
          <a className="docs-text-link" href="/bills">Set up a supplier bill →</a>
        </section>
        <section id="history" className="docs-section">
          <span className="docs-eyebrow">05 / COME BACK TO YOUR WORK</span><h2>Your history follows your wallet.</h2>
          <div className="docs-two-col"><article><h3>My jobs</h3><p>Sign in with the wallet used to order. <a href="/jobs">My jobs</a> includes its USDT and cNGN orders, progress, briefs, and finished work. Search by service, status, currency, or job ID.</p></article><article><h3>My bill history</h3><p><a href="/bills/history">My bill history</a> lists bills linked to verified funding from the connected wallet. An unfunded bill may not appear yet. Keep its detail link so you can return.</p></article></div>
          <h3>What is public?</h3><p>The <a href="/activity">activity page</a> shows aggregates. Job briefs and deliverables require authorized access. Blockchain transfers, addresses, and hashes remain public. Bill detail links currently allow access by bill ID: treat them as shareable receipt links and avoid publishing sensitive bill information.</p><p>Never share your seed phrase or private key. Wallet sign-in requests a message signature; funding and settlement request separate transactions.</p>
        </section>
        <section id="technology" className="docs-section">
          <span className="docs-eyebrow">06 / UNDER THE HOOD</span><h2>AI creates. Rules move the money.</h2><p>The team presents ten workflow roles: Scout, Researcher, Reader, Writer, Designer, Producer, Investigator, Analyst, Auditor, and Messenger. The service determines which stages run. Models produce and check content; deterministic code and contracts enforce payment rules.</p>
          <dl className="docs-definitions">{technology.map(([name, text]) => <div key={name}><dt>{name}</dt><dd>{text}</dd></div>)}</dl>
          <div className="docs-resource-links"><a href="/agent.json">Agent registration data ↗</a><a href="/activity">Public activity →</a><a href="https://github.com/vickman787/ikenga" target="_blank" rel="noreferrer">Developer source ↗</a></div>
        </section>
        <section id="help" className="docs-section">
          <span className="docs-eyebrow">07 / WHEN SOMETHING NEEDS A CHECK</span><h2>A few useful answers.</h2>
          <div className="docs-faq">{questions.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</div>
        </section>
        <footer className="docs-footer"><div><strong>Ready when you are.</strong><p>Start with a clear brief. Keep the final say.</p></div><a className="docs-button" href="/#hire">Create your first job ↗</a><small>Product guide · Updated 26 November 2026 · <a href="#start">Back to top ↑</a></small></footer>
      </main>
    </div>
  </div>;
}
