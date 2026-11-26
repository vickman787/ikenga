# AI delivery upgrade: first milestone

Newly started website, flyer, promo slideshow and market-report deliveries use generator version 2. Saved progress without a version resumes using version 1. Version fields and research state are optional fields in the existing delivery JSON; no database or contract migration is required. Historical delivered content and its fingerprint remain unchanged.

## Changes

- Guided service-specific brief fields collect confirmed business/contact/brand information or research subjects, region and purpose. The complete brief is validated before a job is created and the original payment panel receives that confirmed text. USDT and cNGN pricing/funding flows are unchanged.
- Version 2 creative jobs require validated structured analyst and auditor results. Failed or malformed checks cannot deliver after the correction attempt. A deterministic currency-and-amount check catches unconfirmed prices. Corrected facts are re-extracted for customer-requested revisions. New prompts respect customer branding and add responsive design direction and a trusted viewport tag.
- Research starts with a persisted plan. Searches run one query per stage; reading runs two pages per stage. Sources must mention planned subjects. Relevant passages, retrieval times and a subject-by-question evidence matrix replace reliance on the opening few characters of a page. Every required cell needs valid source references and passing factual and final audits before delivery.
- Chat calls reserve the requested output allowance, reject unpriced models, have a bounded timeout, charge empty/truncated responses and conservatively account for missing usage. The hidden retry that doubled output allowance is removed. Explicit brief-parse retries are budget checked.
- Failed version 2 jobs retain their escrowed state. The owner sees retry/refund controls. Explicit retries carry forward the previous attempt’s recorded model cost. Settled jobs cannot be revised. A stage will not advance a job whose status has changed before the result is saved.

## Compatibility and limits

Only the website application needs the new generator code; the VPS worker continues invoking the same signed API and sealing the same report/HTML/slideshow content representation. No wallet secrets, contract addresses, payment approval code or hash algorithm are changed.

This milestone does not include MP4 encoding, voice/music, PNG/PDF export generation, customer asset uploads, curated layout rendering or screenshot-based visual scoring. The current promo is labelled as an HTML slideshow. Stronger prompts and mocked tests are not a measured real-generation quality benchmark.

Search still uses keyless web result parsing and can be blocked by search providers. Relevance matching is a deterministic first filter; the structured factual audit checks whether evidence supports each claim. A model’s factual assessment is not independent proof of a claim.

A network timeout can occur after a provider has processed a paid request, and concurrent stage calls are not yet protected by a distributed lease. The accounting improvements cover recorded responses and explicit retries; a production hard spending guarantee needs persisted reservations and stage serialization. Do not treat the per-job estimate as a provider-side billing limit.

## Validation and rollout

Use offline fixtures to exercise the complete pipeline, malformed and failed verdicts, irrelevant sources, missing evidence cells, invented prices/currency changes, source extraction after long page prefixes, old saved progress, owner-only routes, refund state changes and both payment currencies. Build all shared packages and the web app. Before enabling this on production, compare representative real outputs and rendered layouts with the current delivery standard under a fixed evaluation budget. Keep old accepted jobs unchanged during evaluation.
