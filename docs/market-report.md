# Market report — how the first real Ikenga job works

The market report was the first job the team could do end to end. The
other three jobs are real now too — the website, the flyers, and the
promo video (see "The creative jobs" below). All four run through the
same loop: hire → the team works in short stages → delivered → accept,
one free revision, or turn it down.

## The team

| Agent | Job | Model | Cost |
| --- | --- | --- | --- |
| Scout | Finds businesses on the web and reads their pages | — (web search, free) | $0 |
| Researcher | Turns the brief into a short plan | Nemotron 3.5 Super VL | ~$0.001 |
| Writer | Writes the report in plain words, under 800 words | Nemotron 3.5 Super VL | ~$0.001 |
| Analyst | Checks every number, price and date against the sources | Nemotron 3.5 Super VL | ~$0.001 |
| Auditor | Reads the whole thing on a different model and passes it or sends it back | Qwen3.8-27B | ~$0.007 |

A full report costs about **$0.01** in model calls (sample run:
16,696 tokens, $0.0097, 0 revisions, Auditor passed first time).
The CFO budget is $0.50 per report, inside the weekly tool budget of
30 USDT and the per-move max of 5 USDT — a run refuses rather than
overspends. One free revision is allowed; after that the report ships
with a plain note.

## Scout — the search

FortyTwo is chat-only, it cannot search the web, so Scout has its own
search: **Bing** first (free, no key — result pages are parsed from
`bing.com/search`), **Wikipedia API** as a reliable backup for facts
about a named business, **DuckDuckGo Lite** as a second backup (it is
flaky: it sometimes answers with a bot-check page). Mojeek and Brave
were tried and blocked from this machine. Scout reads the actual pages
it finds, keeps only pages that mention a named business or a word from
the brief, and drops the rest. Every fact in a report comes from a page
Scout actually read, and the report lists its sources. If a price is not
in the sources, the report says "price not listed" — it never invents one.

## The creative jobs — website, flyers, promo video

Same loop, different hands (`apps/agent/src/creative.ts`, same $0.50
model cap per job, same one-free-revision rule):

| Agent | Job | Model |
| --- | --- | --- |
| Designer | Reads the brief, pulls out the facts (business, services, prices, contact), then builds the one-page website or the printable flyer | Nemotron 3.5 Super VL |
| Producer | Reads the brief and puts the promo slideshow together — 5 slides of the business's own words | Nemotron 3.5 Super VL |
| Analyst | Checks every word, price and phone number against the brief | Nemotron 3.5 Super VL |
| Auditor | Reads the work on a different model and passes it or sends it back once | Qwen3.8-27B |

A creative job costs a few cents (a website is roughly $0.01–0.02).
Prices come from the brief or are shown as "price not listed" — never
invented. The website and flyer are model-written HTML: `sanitizeHtml`
strips scripts, frames, forms, pictures and event handlers before
anything is stored, and the job page still shows the page in a
sandboxed frame with scripts switched off. The promo is honestly a
**motion slideshow** — moving slides with play/pause — not a video
file: no video file is made, and none is pretended. The full page lives
at `/jobs/[id]/site`.

## The money

The $1 price, the $0.10 bond and the CFO decision flow are unchanged.
The agent steps and their AI cost are written into the money log, so the
CFO can see what a report really cost. No money moves on a market-report
job yet: the escrow is not switched on, and the Self Agent ID check is
recorded honestly — until an agent is registered, the log says the
identity check is still pending and the team can write but cannot be paid.

## The routes

- `POST /api/jobs/[id]/run` — starts the team (all four job types).
  Needs `FORTYTWO_API_KEY` on the server, or it says plainly that the AI
  is not connected yet. Answers straight away (202) with the next stage.
- `POST /api/jobs/[id]/run/step` — runs ONE stage (under 60s). The job
  page calls it until the work is delivered. A whole job takes about
  90–150 seconds across 4–5 stages.
- `POST /api/jobs/[id]/decision` — `{ action: "accept" | "reject" }`.
  Accept records the customer is happy; reject records a refund of the
  $1 plus the $0.10 bond.
- `GET /api/jobs/[id]` — now includes the delivery, its steps, sources
  and cost.
- `/jobs/[id]` — shows "Who did what" (each agent, what it did, its
  model and cost), the delivered work, and Accept / Ask for one
  free revision / Turn it down.
- `/jobs/[id]/site` — the delivered website or flyer on its own page.

## Known limits

- The live site needs `FORTYTWO_API_KEY` set in Vercel Production
  before any hire can run there.
- Prices/fees rarely appear in the free sources Scout can read, so
  reports usually say "price not listed" for fees — provider pricing
  pages or a paid search API would fix that.
- Jobs and deliveries live in Postgres when `DATABASE_URL` is set, in
  memory otherwise — on the live site today, a job made before the
  database is connected may be gone after a restart.
- The promo is a motion slideshow, not a video file.
