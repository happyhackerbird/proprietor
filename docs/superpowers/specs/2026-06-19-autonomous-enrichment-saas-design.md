# Proprietor — Design

**An AI agent that autonomously owns and operates a profitable Company Enrichment SaaS, settling
revenue and costs in USDC via a Circle Agent Wallet.**

- **Event:** Agents Hackathon @ 42berlin, June 19–20 2026 — Agentic Commerce track.
- **Date:** 2026-06-19
- **Status:** Design — not yet implemented.

---

## 1. Concept

The product (idea #1) is a **Company Enrichment API**: `POST { domain }` → a structured company
profile (industry, size, recent news, key people, funding). It is a recognizable, real SaaS category
(Clearbit, Apollo) whose natural buyer is *another agent* — a sales/CRM/outbound agent enriching a
lead mid-workflow.

The wrapper (idea #2) is that an **AI agent runs this API as an autonomous business**. The agent is
the proprietor: it sets prices, fulfills orders by paying suppliers, manages its treasury, and is
graded by one metric — **does the treasury grow?** All revenue and cost settle in **USDC** through a
**Circle Agent Wallet**.

The two ideas reinforce each other: the enrichment product gives the agent a thing to *sell*, and the
variable cost of fulfilling each lookup gives the agent something real to *decide* (how to price, what
to accept). Without variable cost there is no business; without the business the wallet is just a
transfer.

## 2. Goals & non-goals

**Goals**
- The wallet is load-bearing: remove it and the agent cannot operate.
- A **repeatable loop**: discover → quote → pay → fulfill → receipt → reprice, runnable many times.
- **Autonomous pricing/solvency decisions** that a viewer can see and understand.
- A **receipt + spend ledger** with transaction hashes and per-job P&L.

**Non-goals (explicitly cut)**
- Best-in-class enrichment accuracy. "Good enough to be plausibly useful" is the bar; the margin
  *behavior* is the deliverable, not data quality.
- A polished SaaS product. No auth, accounts, billing portal, or multi-tenant concerns.
- Real production traffic or a real customer base.

## 3. The business model (the numbers that make it real)

Each enrichment has a **variable cost to fulfill** because an obscure company needs more research than
a famous one. That single fact is the engine of the whole demo:

- **Revenue:** a flat (but agent-adjustable) **published price** per enrichment, paid in USDC.
- **Cost of goods sold (COGS):** per request — `(Tavily searches × search price) + (Nebius tokens ×
  token price)`. Tracked per job in USD-equivalent.
- **Gross margin:** `price − COGS`. The agent's job is to keep this positive *on average*.

The autonomous behaviors that fall out of this:

1. **Quote / scope before fulfilling.** Estimate research depth from the request; if expected COGS
   exceeds the price, **scope down** (shallower research) or **decline**.
2. **Dynamic repricing.** When realized margin compresses (costs spike, or a string of losses), the
   agent **raises the public price**; when it's fat and demand is healthy, it can lower it to win volume.
3. **Solvency / throttling.** Track runway from the wallet balance. If runway is short, refuse
   negative-EV work and pause non-essential spend.

## 4. Architecture

A small set of single-purpose units with clear interfaces:

| Unit | Responsibility | Depends on |
|---|---|---|
| **Storefront** | The x402-protected HTTP endpoint. Publishes schema + price, issues `402`, verifies payment, returns brief + receipt. | Treasury, CFO, Fulfilment |
| **CFO (pricing brain)** | Estimates COGS, sets/adjusts public price, enforces accept/decline + solvency policy. | Treasury, Ledger |
| **Fulfilment engine** | Turns `{domain}` into a typed `CompanyProfile`: runs searches, structures with inference, reports actual COGS. | Supplier(s) |
| **Treasury (Circle adapter)** | Wraps the Circle Agent Wallet: balance, receive, send, list transactions. | Circle SDK / starter kit |
| **Ledger** | Append-only record of every job: revenue, itemized COGS, tx hashes, margin, and the agent's reasoning. | — |
| **Dashboard / CLI** | Read-only view of treasury, price history, and the ledger. The demo surface. | Ledger, Treasury |
| **Customer-agent (demo harness)** | A separate agent that discovers the service, inspects price/schema, pays, and consumes the brief — proves the A2A loop. | Storefront, its own wallet |

**Framework:** the autonomous loop is implemented with an agent framework (default: **Claude Agent
SDK**) and the **Circle Agent Stack starter kit** for the wallet. Language default **TypeScript/Node**
(the x402 + Circle + agent-SDK ecosystem is JS-first); Python is an acceptable alternative.

### 4.1 Where USDC actually moves (important design decision)

Tavily and Nebius bill via **API key in fiat/credits**, *not* USDC on-chain. So "the agent pays its
suppliers in USDC" needs a deliberate design. Two options:

- **Baseline (simplest):** treat upstream calls as **metered USD costs** deducted from the P&L. Real
  USDC moves only on the *customer* side (revenue in). Honest, but only one side is on-chain.
- **Recommended:** put a thin **supplier-agent** in front of Tavily/Nebius — its own x402 endpoint with
  its own wallet. Now the proprietor **literally pays USDC per upstream call** to another agent. This
  gives a **two-sided on-chain economy** (customer → proprietor → supplier), which is far stronger on
  the "wallet is meaningfully part of operation" and "agents pay each other" criteria. It is also
  cheap to build (the supplier is ~50 lines: take payment, proxy the real API, return result).

Recommendation: **build the supplier-agent.** It is the single highest-leverage way to make the wallet
load-bearing on *both* sides, and it doubles as a second demonstrable agent in the system.

## 5. Data flow (per request)

1. Buyer-agent GETs the storefront's **schema + current price** (discovery).
2. Buyer POSTs `{ domain }` → storefront returns **`402 Payment Required`** (price, pay-to address, schema).
3. Buyer **pays USDC** → revenue confirmed in the treasury.
4. Storefront verifies payment, hands the job to the **CFO**.
5. CFO estimates COGS vs. price → **accept / scope-down / decline** (decline ⇒ refund or partial).
6. Fulfilment runs research, **paying the supplier-agent in USDC per call**, and returns a `CompanyProfile`.
7. Storefront returns the **brief + receipt** (revenue, itemized COGS, tx hashes, gross margin).
8. Ledger records the job; CFO **updates the public price** if margin has drifted.

## 6. Interfaces (sketch)

```
GET  /v1/enrich/schema   -> { input: {domain}, output: CompanyProfile, price_usdc, terms }
POST /v1/enrich          -> 402 Payment Required { price_usdc, pay_to, nonce }
POST /v1/enrich (paid)   -> 200 { profile: CompanyProfile, receipt: Receipt }

CompanyProfile = { domain, name, industry, size, funding, key_people[], recent_news[], confidence }
Receipt        = { job_id, revenue_usdc, cogs: LineItem[], margin_usdc, tx_hashes[], reasoning }
LineItem       = { supplier, units, unit_price_usdc, amount_usdc, tx_hash }
```

## 7. Pricing & solvency policy (the "mind")

- **Quote rule:** `accept if expected_COGS ≤ price × (1 − target_margin)`, else scope-down, else decline.
- **Reprice rule:** maintain a rolling realized-margin window; if it falls below `target_margin`, raise
  price by a step; if it sits well above and volume is healthy, lower by a step (bounded by floor/ceiling).
- **Solvency rule:** if `balance < runway_floor`, accept only clearly-positive-EV jobs and pause
  discretionary spend.
- Every decision writes a one-line **reason** to the ledger ("declined: obscure domain, est. COGS
  $0.18 > price $0.10"; "raised price $0.10 → $0.14: 3 of last 5 jobs below target margin").

## 8. Receipts, ledger & dashboard

- **Ledger:** append-only (SQLite or JSON). One row per job + one row per price change.
- **Receipt:** returned to the buyer and stored — includes tx hashes so payments are independently
  verifiable.
- **Dashboard:** minimal — treasury balance, price-over-time, and the job ledger. A CLI table is an
  acceptable fallback; a tiny web view is the stretch.

## 9. Judging-criteria mapping

| Criterion | How Proprietor satisfies it |
|---|---|
| Agentic usefulness | Runs a complete, repeatable business workflow, not a one-shot payment. |
| Wallet integration | The wallet is the treasury and the governance model; both revenue and COGS are on-chain (with supplier-agent). |
| Payment design | Per-call x402 billing, explicit quotes, dynamic pricing, solvency throttling — all logged with reasons. |
| Technical execution | One tight loop proves the thesis end-to-end; scope is cut to guarantee it works. |
| User experience | Ledger + dashboard make "what it paid for and why" legible at a glance. |
| Originality | An agent that *runs a company* and defends its margin — a market, not a transfer. |

## 9.1 Compliance with the Circle "Best Agent Wallet Application" brief

**Required Technical Elements — all covered:**

| Requirement | Status | Where |
|---|---|---|
| A Circle Agent Wallet | ✅ | Treasury (§4) |
| ≥1 wallet action (balance / payment / transfer / funding / service payment) | ✅ four of them | balance check, receive, send, list-transactions (§4, §5) |
| Use of the agent framework starter kit | ✅ | Claude Agent SDK + Circle Agent Stack starter kit (§10) |
| A clear agent workflow, not a standalone payment script | ✅ | the business loop (§5) |
| A receipt / tx hash / payment log / spend ledger | ✅ | `Receipt` with `tx_hashes` + append-only `Ledger` (§6, §8) |
| A short explanation of what the agent paid for and why | ✅ | `reasoning` on every ledger row (§7, §8) |

**Circle Agent Stack tool coverage:**

| Tool | Status | Use |
|---|---|---|
| Circle Agent Wallet | ✅ core | the treasury |
| Agent Nanopayments | ✅ | x402 per-call billing on the storefront + supplier |
| Agent Stack starter kits | ✅ | wallet create/list, balances, payments |
| Circle CLI | ✅ | wallet setup |
| Circle Agent Marketplace | ◑ opportunity | could be the **discovery layer** — list the enrichment service and/or discover the supplier-agent here |
| Circle Skills | ❓ verify | adopt if relevant once we read the starter-kit docs |

**"What we're looking for" — bullets hit:** pays for data/inference/services · discovers + inspects
pricing + pays + returns a ledger · budgets/caps/policy-based spend · multi-agent paying each other ·
a marketplace that both **buys and sells** capabilities · pay-per-query data agent · autonomous
business workflow · wallet as payment identity + operating budget. The project spans **two** of
Circle's own suggested ideas at once — _Developer API Monetization Agent_ and _Agent Expense Manager_.

**Optional strengtheners (not required; cheap points):**
1. **Circle Agent Marketplace** as the buyer's discovery surface (instead of a bare `GET /schema`).
2. **Approval threshold:** fully autonomous below $X, escalate for human approval above it — ticks the
   "handle approval before spend" capability *without* breaking the autonomy thesis (autonomous by
   default, supervised only at the tail).
3. Make the buyer-agent's **discover → inspect price → pay → receive** loop explicit and visible in the
   demo — it's exactly the flow the starter kit advertises.

## 10. Tech stack (proposed)

- **Language/runtime:** TypeScript + Node.
- **Agent loop:** Claude Agent SDK (default) — best fit for the autonomous CFO loop.
- **Wallet:** Circle Agent Wallet via the Agent Stack starter kit; Circle CLI for setup.
- **Payments:** x402 for per-call billing on the storefront (and on the supplier-agent).
- **Suppliers:** Tavily (search) + Nebius TokenFactory (inference), wrapped behind the supplier-agent.
- **Storage:** SQLite (or JSON) for the ledger. Minimal web dashboard or CLI.

## 11. Scope & cut-list (decide what dies first when the clock bites)

Build inside-out; the items lower in this list are the first to cut.

1. **Must have (the thesis):** one paid enrichment end-to-end + per-job receipt + the **dynamic
   repricing** behavior + a visible ledger. _If only this works, the project still wins its point._
2. Supplier-agent (two-sided USDC). _Cut to metered-cost baseline if time-poor._
3. Solvency throttling under load.
4. Web dashboard. _Cut to a CLI ledger table._
5. Refunds on decline. _Cut to "decline before payment."_

**Demo fidelity ladder for settlement:** real testnet USDC → testnet with seeded balances → mock
wallet returning tx-shaped receipts. Pick the highest rung that is reliable on the demo machine.

## 12. Open questions (resolve before/at start of build)

1. **Framework:** confirm Claude Agent SDK, or another the team is faster in?
2. **Settlement:** which rung of the fidelity ladder for the live demo — real testnet or mock?
3. **Supplier-agent:** build it (recommended, two-sided on-chain) or start with metered costs?
4. **Enrichment depth:** how many Tavily calls define "shallow" vs "deep" scope (sets the cost spread)?
5. **Language:** TypeScript (recommended) or Python?

## 13. Risks

- **x402 / Circle SDK integration time** is the main unknown — point effort here first; the research
  core is the easy part.
- **Tavily/Nebius latency** could make the live demo sluggish — pre-warm and cache a couple of demo
  domains.
- **Margin demo must be legible** — pre-pick a "cheap" and an "expensive" domain so the price-rise is
  guaranteed to fire on stage.
