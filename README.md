# Student Signal Copilot

**Design philosophy:** AI handles understanding and drafting · humans handle execution
and decision-making · the database keeps the record.

> The student is the first sensor in the building. A work order is only *a record of
> what someone managed to capture* — so we let the person closest to the problem report
> it in one sentence, and use a multi-agent workflow to turn that field truth into an
> auditable, confidence-labeled, actionable work order — then close the loop by asking
> the student whether reality actually changed.

Built on the **CriticalAsset** API for the `40 Irving Place` school portfolio.
Rosemary Li · Nuo Chen · Kimberly Huang — https://github.com/lvelf/Student-Signal-Copilot

---

## The workflow in one line

```
1 · SIGNAL        2 · EVIDENCE         3 · ACTION          4 · VERIFICATION
field observation structure + enrich   next best step      follow up with student
(student in loop) (grounded in truth)  (repair crew acts)  (not fixed → reopen)
```

Each stage is run by specialist agents under a **supervisor**. The agents only *read,
analyze, and draft* — every real-world action (fix, sign-off, close) is taken by a human.

---

## Run

```bash
cp .env.example .env      # fill CA_CLIENT_ID / CA_CLIENT_SECRET (+ ANTHROPIC_API_KEY)
npm install
npm run dev               # http://localhost:3000
```

- `http://localhost:3000/` — **Challenge 01** work-order dashboard
- `http://localhost:3000/copilot` — **Challenge 02** multi-agent Copilot

`.env` is gitignored — credentials never reach the browser, never enter git.

**Stack:** Express + TypeScript backend (run with `tsx`, no build step) · single-page
vanilla-JS frontend (no framework, no bundler). Reasoning runs on **tiered Claude models**
— Sonnet for the cross-signal overview, Haiku for the specialists; with no API key the
pipeline degrades to grounded deterministic stubs so it always runs.

---

## Challenge 01 — Pull the work orders, build the dashboard

Authenticate against CriticalAsset, pull the live work-order feed, and render a
dashboard an operator could use on Monday morning. **Credentials stay server-side:**

```
Browser ──/api/workorders──▶ Express ──GraphQL──▶ CriticalAsset
        ◀──── normalized JSON ───────◀── access token (cached, server-side only)
```

- **Counter row** — Total / Open / Overdue / Critical
- **Work-order table** — title, severity, priority, category, asset, location, due, stage;
  sorted critical-first; search + filter by stage / severity / category
- **Detail drawer** — click a row for the full work order and its linked assets
- **Bonus** — work orders **joined to their assets** (`assets.read`), group-by-category,
  and a "Top buildings" panel

Token handling: OAuth2 client-credentials exchanged once, cached in server memory until
~60 s before expiry, auto-refreshed on `401`. The browser only ever calls our `/api/*`.

---

## Challenge 02 — Turn field truth into an AI workflow  (`/copilot`)

A **supervisor agent** orchestrates seven specialists. The decomposition borrows the AI
co-scientist's *generate → reflect → ground → meta-review* idea, but drops its
tournament/evolution machinery — overkill for a bounded "one building, one work order"
problem. Per signal it is a fixed, predictable set of steps, not an open-ended search.

```
                       Student signal (one sentence + optional photo)
                                       │
                              ┌── Supervisor (orchestrate · assign · sequence) ──┐
                              │   routing logic IS an auditable reasoning trace   │
   1 · Extraction ───────────┘                                                   │
   plain text → structured fields                                                │
        │                                                                        │
   Grounding  +  PublicData            ← deterministic, NO LLM call              │
   match real assets   NYC DOB / 311                                             │
        │                                                                        │
   2 · Enrichment ‖ Compliance ‖ Review        ← run concurrently                │
   operational     obligations   confidence labels + gap flags                   │
   meaning         + escalation                                                  │
        │                                                                        │
   Debate (only if Review flags root cause uncertain) ‖ Recommendation           │
        │                                                                        │
   3 · ACTION — repair crew fixes · EHS signs off · director approves (humans)   │
        │                                                                        │
   4 · Verification — student confirms: fixed / still happening / worse ─────────┘
        └─ not fixed → reopen the work order, back to signal
```

### What each agent does
Models are **tiered**: the narrowly-scoped specialists run on a cheap, fast small model
(Haiku); only the cross-signal **meta-overview** needs big-picture reasoning, so it is the
one agent on the expensive model (Sonnet). Two steps are pure rules — no LLM call at all.

| Agent | Role | Model |
|-------|------|-------|
| **Extraction** | one-sentence observation → structured fields (issue type, category, location, severity, urgency, recurring, affected users) | Haiku |
| **Grounding** | match the issue to **real CriticalAsset assets** by keyword / trade / location | rule |
| **PublicData** | look up NYC **DOB violations** + **311** for the building | rule + API |
| **Enrichment** | translate matched assets (their SOP/troubleshooting) + public data into *operational meaning* — not a link dump | Haiku |
| **Compliance** | surface the **obligations** the issue touches (OSHA / code / inspection / district SOP) and decide escalation | Haiku |
| **Review** | skeptical supervisor: label every claim's **confidence**, flag missing evidence, judge if root cause is uncertain | Haiku |
| **Debate** | *only when Review says root cause is uncertain* — two experts argue competing root causes, exposing the reasoning | Haiku |
| **Recommendation** | compose the cleaned work order: severity, assignment group, next actions, evidence checklist, student message, closure question | Haiku |
| **Meta-overview** | watches across **all** signals for systemic patterns (same location/asset recurring across reports) and guarantees long-running + recurring + urgent issues surface to the top | **Sonnet** |

### Nothing stays buried — the URGENT guarantee
Every signal is graded (severity, urgency, recurring). On top of that, a **deterministic
guarantee** tags any issue that is *high/critical + recurring + still happening* as
**URGENT** and floats it to the top of the inbox — it cannot depend on a model's mood. The
**meta-overview agent** then watches the whole portfolio: if several reports point at the
same place (e.g. one bathroom flooding again and again), it recognises a single systemic
failure instead of N disconnected tickets, so a long-running problem can't sit unseen in
the backlog.

### Why it wins
- **Auditable supervisor** — the supervisor's routing (which agent ran, why, on what
  model, how long) is shown as a trace. The reasoning path is human-reviewable, which
  satisfies the rule that *AI output must be reviewable*. Each step streams live over SSE,
  so the pipeline lights up agent-by-agent in the UI.
- **Grounded confidence** — a complaint is **not trusted on arrival**. Every conclusion is
  anchored to a real asset (verified to exist) or a real public record; the AI never
  invents equipment. Each claim is labeled **Verified / Likely / Inferred / Missing /
  Needs inspection** — and *only the student's direct observation is "Verified."* No
  hallucination laundered as fact.
- **Closed loop, two humans** — the **reporter (student)** verifies the fix; the
  **resolver (repair crew)** executes it. The person who reported it is both the source of
  truth and the verifier, so the loop genuinely closes. Not fixed → auto-reopen.

### Security & cost (by design)
- **AI has no execution power** — agents only read/analyze/draft. Every real action (fix,
  EHS sign-off, closure) is a human step, so adding agents can't cause real-world damage.
- **Least privilege** — our CriticalAsset token is **read-only**; even a fully compromised
  app cannot mutate the database.
- **Cost is bounded** — **only the meta-overview agent uses the expensive model; every
  specialist runs on a cheap small model** (Haiku). Two stages (Grounding, PublicData) are
  rules with **no LLM call**; Debate only runs when the root cause is unclear. Decomposing
  the work into narrow tasks is both cheaper *and* faster than one giant prompt on a large
  model — a full run is a fixed, predictable handful of calls.

### Endpoints
| Route | Purpose |
|-------|---------|
| `POST /api/signal` | run the full pipeline on a signal (blocking) |
| `GET /api/signal/stream` | same, streamed as SSE (per-agent steps) |
| `GET /api/signals` · `/:id` | operator inbox (URGENT-first) + full record |
| `GET /api/overview` | meta-overview agent: cross-signal systemic-pattern watch |
| `POST /api/signals/:id/verify` | closure loop: `fixed` / `still_happening` / `worse` |

---

## How work orders integrate with static asset data

Static asset records and the dynamic events our pipeline produces belong to the **same
data fabric**, attached to the same asset and work order. The Grounding stage joins a live
signal to a static asset (its product type, SOP, and regulatory `obligations`), so the
recommendation stands on the asset's real history rather than guesswork.

**Honest note on write-back:** the architecture is designed to write the structured fields,
confidence labels, compliance flags, and recommended work order *back into CriticalAsset* so
the student signal becomes part of the asset's history. Our hackathon token only carries
`*.read` scopes, so the current build persists that enriched record to an in-memory store
(`server/store.ts`) instead. Writing back ≠ auto-closing — closing and reopening always
require human approval regardless.

---

## Files
| Path | Purpose |
|------|---------|
| `server/criticalasset.ts` | Auth (token cache) + GraphQL queries (work orders, assets) |
| `server/llm.ts` | Pluggable LLM layer (Claude, or grounded deterministic stub) |
| `server/agents.ts` | The specialist agents, the meta-overview agent + asset grounding |
| `server/pipeline.ts` | Supervisor: orchestration, routing logic, auditable trace |
| `server/publicData.ts` | NYC DOB / 311 enrichment |
| `server/store.ts` | In-memory record store (stands in for write-back) |
| `server/index.ts` | Express app: all routes + static hosting |
| `public/index.html` · `app.js` | Challenge 01 dashboard |
| `public/copilot.html` · `copilot.js` | Challenge 02 multi-agent Copilot |
| `public/styles.css` | Shared UI |

## CriticalAsset API notes (verified live)
- Auth is a GraphQL **mutation** `applicationClientCredentialsToken(input: {...})` —
  **not** a REST `/oauth/token`. Single endpoint: `POST {CA_BASE_URL}/api`.
- `workOrders(limit, offset)` returns `WorkOrderConnection { nodes, totalCount }`.
- Field names differ from the public docs: `executionPriority` (not `priority`),
  `workOrderStage.name` (not `status`), `workOrderServiceCategory`, `startDate`/`endDate`.
- Dates are **Unix-millisecond strings** — normalized to ISO server-side.
- Assets carry rich grounding data: `information` (SOP / troubleshooting / safety) and
  `obligations` (OSHA / regulatory cadence). DOB violations key on `house_number`.
- `workOrderAssignments.users` 500s server-side, so assignee names are not queried.
