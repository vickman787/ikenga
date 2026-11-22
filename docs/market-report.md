# Market report — how the first real Ikenga job works

The market report is the one job type the team can actually do end to end.
Everything else (website, promo video, flyers) is still a labelled stub:
the money path is real, the creative work is not wired up yet.

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

## The money

The $1 price, the $0.10 bond and the CFO decision flow are unchanged.
The agent steps and their AI cost are written into the money log, so the
CFO can see what a report really cost. No money moves on a market-report
job yet: the escrow is not switched on, and the Self Agent ID check is
recorded honestly — until an agent is registered, the log says the
identity check is still pending and the team can write but cannot be paid.

## The routes

- `POST /api/jobs/[id]/run` — starts the team (market-report only).
  Needs `FORTYTWO_API_KEY` on the server, or it says plainly that the AI
  is not connected yet. A run takes about 90–100 seconds.
- `POST /api/jobs/[id]/decision` — `{ action: "accept" | "reject" }`.
  Accept records the customer is happy; reject records a refund of the
  $1 plus the $0.10 bond.
- `GET /api/jobs/[id]` — now includes the report, its steps, sources
  and cost.
- `/jobs/[id]` — shows "Who did what" (each agent, what it did, its
  model and cost), the report, its sources, and Accept / Ask for one
  free revision / Turn it down.

## Known limits

- A run takes ~100 seconds, longer than the 60-second limit on Vercel's
  free plan — the route asks for 300 seconds, which needs a paid Vercel
  plan to actually run live. Until then a live hire may time out.
- The live site needs `FORTYTWO_API_KEY` set in Vercel Production
  before any hire can run there.
- Prices/fees rarely appear in the free sources Scout can read, so
  reports usually say "price not listed" for fees — provider pricing
  pages or a paid search API would fix that.
- The team works from server memory unless `DATABASE_URL` is set, so
  jobs and reports are lost when the server restarts.
