# Student Signal Copilot — Challenge 01

Connects to the **CriticalAsset** GraphQL API, pulls live work orders from the
`40 Irving Place` portfolio, and renders an operator dashboard.

The browser never sees CriticalAsset credentials — it only talks to our own
Express backend, which authenticates server-side and caches the access token.

```
Browser ──/api/workorders──▶ Express (Node) ──GraphQL──▶ CriticalAsset
        ◀──── normalized JSON ──────────────◀── access token (cached)
```

## Stack
- **Backend** — Express + TypeScript (run directly with `tsx`, no build step)
- **Frontend** — single-page vanilla JS dashboard in `public/` (no framework, no bundler)

## Run

```bash
cp .env.example .env      # then fill in CA_CLIENT_ID / CA_CLIENT_SECRET
npm install
npm run dev               # http://localhost:3000
```

`.env` is gitignored — never commit real credentials.

## Features
- **Counter row** — Total / Open / Overdue / Critical
- **Work-order table** — title, severity, priority, category, asset, location, due date, stage
  (sorted critical-first), with search + filters by stage / severity / category
- **Detail drawer** — click any row for the full work order and its linked assets
- **Bonus** — work orders joined to their assets (`assets.read`), "Group by category",
  and a "Top buildings" panel

## Challenge 02 — the multi-agent Copilot  (`/copilot`)

Turns a student's one-line field observation into an auditable, confidence-labeled
work order, then closes the loop by asking the student if reality changed.

A **supervisor agent** (simple, auditable if-logic) orchestrates specialist agents.
Inspired by the AI co-scientist's generate / reflect / ground / meta-review
decomposition — minus the tournament/evolution machinery, which is overkill for a
bounded one-building problem.

```
Student signal
   ↓
Extraction  →  Grounding (real CriticalAsset assets)  +  PublicData (NYC DOB/311)
   ↓
Enrichment ‖ Compliance ‖ Review        (run concurrently)
   ↓
Debate (only if Review flags root cause uncertain) ‖ Recommendation
   ↓
Verification loop  →  student confirms: fixed / still happening / worse → reopen
```

- **Pluggable LLM** (`server/llm.ts`) — uses real Claude when `ANTHROPIC_API_KEY` is
  set; otherwise a deterministic stub grounded in real asset data so it still runs.
- **Grounding** — every conclusion is anchored to real assets (their SOP /
  troubleshooting / `obligations`) and real NYC DOB violations, not invented.
- **Confidence ledger** — each claim labeled Verified / Likely / Inferred / Missing /
  Needs inspection. Only the student's observation is "Verified".
- **Live trace** — the pipeline streams over SSE so the UI lights up each agent as it
  finishes; the supervisor's routing is shown as an auditable trace.
- **Read-only note** — our token has no write scope, so the "CriticalAsset update" step
  persists to an in-memory store (`server/store.ts`) instead of writing back.

### Challenge 02 endpoints
| Route | Purpose |
|-------|---------|
| `POST /api/signal` | Run the full pipeline on a signal (blocking) |
| `GET /api/signal/stream` | Same, streamed as SSE (per-agent steps) |
| `GET /api/signals` · `/:id` | Operator inbox + full record |
| `POST /api/signals/:id/verify` | Closure loop: fixed / still_happening / worse |

## Files
| Path | Purpose |
|------|---------|
| `server/criticalasset.ts` | Auth (token cache) + GraphQL queries (work orders, assets) |
| `server/llm.ts` | Pluggable LLM layer (Claude or grounded stub) |
| `server/agents.ts` | The 7 specialist agents + asset grounding |
| `server/pipeline.ts` | Supervisor: orchestration + auditable trace |
| `server/publicData.ts` | NYC DOB / 311 enrichment |
| `server/store.ts` | In-memory record store (simulated write-back) |
| `server/index.ts` | Express app + all routes + static hosting |
| `public/index.html` · `app.js` | Challenge 01 dashboard |
| `public/copilot.html` · `copilot.js` | Challenge 02 multi-agent Copilot |
| `public/styles.css` | Shared UI |

## CriticalAsset API notes (verified live)
- Auth is a GraphQL **mutation** `applicationClientCredentialsToken(input: {...})`,
  **not** a REST `/oauth/token` endpoint. Single endpoint: `POST {CA_BASE_URL}/api`.
- `workOrders(limit, offset)` returns `WorkOrderConnection { nodes, totalCount }`.
- Fields differ from the public docs: use `executionPriority` (not `priority`),
  `workOrderStage.name` (not `status`), `workOrderServiceCategory`, `startDate`/`endDate`.
- Dates are **Unix-millisecond strings** — normalized to ISO in `server/index.ts`.
- `workOrderAssignments.users` currently 500s server-side, so assignee names are not queried.
