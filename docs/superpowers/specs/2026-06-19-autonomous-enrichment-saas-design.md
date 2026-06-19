# Proprietor — Design

**An AI agent that autonomously owns and operates a profitable Company Enrichment SaaS, settling
revenue and costs in USDC via a Circle Agent Wallet.**

- **Event:** Agents Hackathon @ 42berlin, June 19–20 2026 — Agentic Commerce track.
- **Date:** 2026-06-19
- **Status:** Design — validated against the Circle Agent Stack (2026-06-20, see §3.5) — not yet implemented.

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

**Pricing is tiered by depth (operative model).** Because the x402 middleware fixes a route's price before
the handler sees the request, the buyer picks a depth tier and pays that tier's published price (not a
per-company quote). Per-request margin still varies within a tier (an obscure company costs more); the CFO
reprices tiers over time, and "decline" = marking a tier unavailable (4xx, no payable `402`). See the
storefront build spec.

## 3.5 Circle Agent Stack — validated integration (ground truth, checked 2026-06-20)

Validated against the live docs (`developers.circle.com/agent-stack`) and the cloned
`agent-stack-ecosystem-kits` repo. Facts that shape the build:

**Wallet & network**
- Agent Wallets are **2-of-2 MPC, user-custody Smart Contract Accounts (SCAs)**, operated via the
  **Circle CLI** (`@circle-fin/cli`). Auth is **email + OTP** (no API key); a one-time **Terms-of-Use**
  acceptance is a manual human step.
- A wallet is **counterfactual** — it must be **deployed** (one outbound tx, per chain) before it can
  sign x402 payments (EIP-1271). Receiving USDC does *not* deploy it. → setup needs an explicit deploy step.
- Use **Arc Testnet (`ARC-TESTNET`)** for the demo: testnet wallets are **auto-funded ~20 USDC** on
  creation — zero faucet friction, no real money. (The ecosystem kit hardcodes Base **mainnet**; we
  drive the CLI on testnet instead.)
- CLI actions we use: `wallet create --type agent --testnet`, `wallet list`, `wallet balance`,
  `wallet transfer` (plain USDC send), `services search/inspect/pay` (x402 buyer).

**x402 / nanopayments**
- **Buyer side** is fully supported (`circle services pay` / kit `circle_pay_service`). Nanopayments =
  **gas-free, batched x402 micropayments** via **Circle Gateway**, sub-cent (to $0.000001) — ideal for
  per-call supplier billing.
- ⚠️ x402 **charges before the upstream resolves** → a failed paid call is **non-refundable**; never
  blind-retry. → the CFO must **decline before paying**, not refund after.
- Some sellers require **Gateway batched** payments (`GatewayWalletBatched`) → a prior `gateway deposit`.

**Seller side (critical correction)**
- The **ecosystem kit is buyer-only** — no seller code, no `services register`. **BUT** Circle ships a
  seller SDK: **`@circle-fin/x402-batching`** with **Express middleware**
  (`createGatewayMiddleware({ sellerAddress, facilitatorUrl })` + `gateway.require("$0.01")`) that
  auto-returns 402 and verifies payment. → our **storefront and supplier-agent are built on this
  middleware** (Node/Express), not hand-rolled and not from the kit.

**Marketplace**
- Real product at `agents.circle.com/services` — a **curated** catalog. Discovery (search + price/schema
  **inspect**) is **programmatic and real**. **Listing your own service is gated/manual** (no self-serve
  submit) → for the demo, our service is discoverable/inspectable **as an x402 endpoint by URL**; an
  actual catalog listing is out of scope.

**Skills & language**
- **Circle Skills** = build-time, LLM-optimized **docs** for the coding assistant (`circle skill
  install`) — they improve *how we build*, **not a runtime capability**. Install `use-circle-wallets` /
  `use-gateway` while building.
- **Language:** the money layer (CLI + `@circle-fin/x402-batching`) is **TypeScript/Node only**. No
  first-class Python for Agent Wallets / x402; Python can only shell out to the `circle` CLI.

**Spend controls**
- Circle **Spending Policies** (native): transfer limits, recipient allowlists, contract blocklists,
  daily/monthly USDC caps — **and they apply to x402 payments**; sanctions screening runs on every
  transfer. **BUT policies are MAINNET-ONLY (§3.5.2)** → on the testnet demo the budget cap is enforced
  **in the CFO's `canUseTool` gate**; real Circle policies attach on mainnet promotion.

### 3.5.1 Architecture decision forced by the above

The money layer is TypeScript; our fulfilment engine is Python. **Recommended — Option B (polyglot):**
- **Node/TS money+web layer:** the x402 storefront + supplier-agent (`@circle-fin/x402-batching` Express
  middleware), treasury ops (Circle CLI), the CFO loop (Claude Agent SDK in TS).
- **Python fulfilment service:** the enrichment engine (§4.2) runs as a plain internal HTTP service the
  Node storefront calls. No crypto in Python.
- Alternatives: **A)** all-TypeScript (port the engine to TS — clean single stack, more porting work);
  **C)** all-Python shelling out to the `circle` CLI for buyer ops and **hand-rolling** seller-side x402
  verification (riskiest — re-implements SCA/EIP-1271 verification). **Adopted: Option B** — the Python
  fulfilment engine is being built as a standalone `/enrich` service (see the engine build spec); the
  money layer is TypeScript.

### 3.5.2 Money-layer implementation specifics (validated 2026-06-20)

- **Testnet IS fully viable (the key result).** The complete seller+buyer x402/Gateway **nanopayment**
  loop — including **batched** nanopayments — runs on **Arc Testnet** (`ARC-TESTNET`, CAIP-2
  `eip155:5042002`). Facilitator: **`https://gateway-api-testnet.circle.com`** (mainnet:
  `https://gateway-api.circle.com`). No real money. Base Sepolia (`eip155:84532`) is an equal alternative.
- **Caveat — the bundled kit is mainnet-only.** `circle-tools/chains.ts` hardcodes BASE/POLYGON mainnet;
  we drive the **CLI** (`--testnet`) and the **`@circle-fin/x402-batching`** middleware (any
  `facilitatorUrl` + CAIP-2 `networks`) directly, or extend `chains.ts`.
- **Seller middleware:** `createGatewayMiddleware({ sellerAddress, facilitatorUrl, networks })` from
  `@circle-fin/x402-batching/server`; price a route with `gateway.require("$0.001")`. After a 200 the
  verified payment is on **`req.payment = { verified, payer, amount (atomic, ÷1e6), network,
  transaction? }`**. **`req.payment.transaction` is the receipt tx hash** — *optional* under batched
  settlement (may settle later), so guard for `undefined`.
- **Buyer (CLI):** `circle services pay <url> --address <a> --chain ARC-TESTNET -X POST -d '<json>'
  --max-amount <x> --output json` → `{ response: <upstream body>, payment: { amount, receipt } }`, where
  `receipt` is base64 of the `x-payment-response` header decoding to `{"transaction":"0x…"}`. Always use
  `--output json` (table mode hides the tx hash).
- **Wallet deploy:** a wallet deploys via a **zero-value self-transfer** (`circle wallet transfer <addr>
  --amount 0 --address <addr> --chain ARC-TESTNET`), **per chain**, then `eth_getCode` is non-empty.
- **⚠️ Spending Policies are MAINNET-ONLY** (`circle wallet limit set …`; testnet errors "Spending
  policies are mainnet-only"). → on the testnet demo, enforce the daily/per-tx **cap inside the CFO
  agent's `canUseTool` gate** (track cumulative spend, deny over budget); attach real Circle policies on
  mainnet promotion.
- **CFO agent:** reuse the `claude-agent-sdk` kit pattern — `createSdkMcpServer({ name, tools })`, tools
  via `tool(name, desc, zodSchema, handler)`, spend tools gated by `canUseTool`; reuse `circle_pay_service`
  pointed at the supplier-agent's URL.

## 4. Architecture

A small set of single-purpose units with clear interfaces:

| Unit | Responsibility | Depends on |
|---|---|---|
| **Storefront** | The x402-paid HTTP endpoint, built on Circle's **`@circle-fin/x402-batching` Express middleware** (`gateway.require(...)`) — auto-issues `402`, verifies payment, returns brief + receipt. Discoverable/inspectable as an x402 service by URL (see §3.5: real Marketplace *listing* is gated). | Treasury, CFO, Fulfilment |
| **CFO (pricing brain)** | Estimates COGS, sets/adjusts public price, enforces accept/decline + solvency policy. | Treasury, Ledger |
| **Fulfilment engine** | Turns a `company` into a typed `CompanyProfile`: disambiguation → depth-tiered research (Tavily search + Nebius synthesis) → cached result, reporting actual COGS. See §4.2. | Supplier(s) |
| **Treasury (Circle adapter)** | Drives the Circle Agent Wallet via the **Circle CLI**: create/deploy, balance, transfer, `services pay`. SCA must be deployed before paying (§3.5). | Circle CLI |
| **Ledger** | Append-only record of every job: revenue, itemized COGS, tx hashes, margin, and the agent's reasoning. | — |
| **Dashboard / CLI** | Read-only view of treasury, price history, and the ledger. The demo surface. | Ledger, Treasury |
| **Customer-agent (demo harness)** | A separate agent that discovers the service, inspects price/schema, pays, and consumes the brief — proves the A2A loop. | Storefront, its own wallet |

**Framework & language:** see §3.5.1 for the validated decision. Recommended split: a **Node/TS**
money+web layer (Claude Agent SDK loop, `@circle-fin/x402-batching` storefront/supplier, Circle CLI
treasury) with the **Python** fulfilment engine (§4.2) behind it as an internal HTTP service. The money
layer is TS-only; Python touches no crypto.

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
**Validated (§3.5):** both the storefront and the supplier-agent are Express services using Circle's
**`@circle-fin/x402-batching`** seller middleware — `gateway.require("$0.0xx")` per route — so payment
verification is Circle's code, not ours. Each agent's SCA wallet must be **deployed once** before it can
receive/sign (§3.5).

**Operative money model (refined — see the CFO build spec):** the supplier sells **per-job research at
fixed wholesale prices per depth** (it wraps the engine + Tavily/Nebius and absorbs within-tier difficulty
variance). The Proprietor's **CFO buys wholesale and resells retail**; margin = retail − wholesale, and the
CFO defends margin by repricing retail when it detects wholesale drift via `circle services inspect`. The
sub-cent/few-cent payments are **nanopayments**. (Per-call nanopayments are a possible stretch, not the
baseline.)

### 4.2 Fulfilment engine (the enrichment pipeline)

The engine turns a `company` (name or domain) into a typed `CompanyProfile`. It is **tiered by depth**,
because depth is what makes cost variable — and variable cost is what the CFO prices against.

- **Disambiguation (free pre-step).** An ambiguous input ("Acme") resolves to a short list of candidate
  companies the buyer can choose from *before paying*. This doubles as the discovery/preview beat.
- **Depth tiers** — `basic | standard | comprehensive`:
  - `basic` — a single pass over the core dimensions (company, product, funding, team). No web search. Cheapest.
  - `standard` — adds live web search, a gap-identification step, and targeted follow-up queries.
  - `comprehensive` — adds a final validation/correction pass over the assembled profile.
- **Pipeline:** parallel domain researchers (funding · product · market · team) → web **search** (Tavily)
  → **gap identification** → targeted follow-ups → an LLM **synthesiser** (Nebius) that extracts the
  typed fields. Deterministic fields are pulled with cheap regex extraction; fuzzy fields go to the LLM.
- **Caching:** every completed profile is cached. A repeat (or recently-cached) company is served from
  cache at **~zero COGS** — the single biggest margin lever and the cleanest demo swing.
- **Confidence:** each profile carries a `research_confidence` score, returned on the receipt.

**Cost model:** `COGS ≈ Σ(Tavily searches) + Σ(Nebius calls)`, where both scale with depth and collapse
to ~0 on a cache hit. The CFO's quote maps an offered price to the **deepest tier it can afford** at the
target margin; an obscure company (more searches, more follow-ups) genuinely costs more, so the agent
must price or scope to protect its margin.

## 5. Data flow (per request)

0. **(Setup, once)** Treasury + supplier-agent wallets are created on **Arc Testnet** (auto-funded ~20
   USDC) and **deployed** (one outbound tx each) so they can sign x402 (§3.5).
1. Buyer-agent discovers the service and **inspects** its x402 price + schema by URL (`circle services
   inspect`).
2. Buyer requests enrichment; the storefront **quotes** via `402` at the CFO's current price for the
   requested depth. *Decline-before-charge:* if the CFO judges the job unprofitable even at the ceiling
   price, it refuses **without** issuing a payable `402` — the buyer is never charged for a job we'd lose
   on (x402 has **no refunds**).
3. Buyer **pays USDC** (gas-free batched **nanopayment**); the `x402-batching` middleware verifies →
   revenue lands in the treasury.
4. Storefront runs fulfilment, **paying the supplier-agent per Tavily/Nebius call** in USDC.
5. Storefront returns the **brief + receipt** (revenue, itemized COGS, tx hashes, margin, `depth_served`,
   `cache_hit`). If a paid upstream call fails it is **non-refundable** — the agent absorbs the loss and
   logs it; it never blind-retries (§3.5).
6. Ledger records the job; the CFO **reprices** if realized margin has drifted.

## 6. Interfaces (sketch)

```
GET  /v1/enrich/schema    -> { input: {company, depth}, output: CompanyProfile, price_table, terms }
POST /v1/preview          -> 200 { disambiguation_choices[] }          # free pre-purchase step
POST /v1/enrich           -> 402 Payment Required { price_usdc, pay_to, nonce }
POST /v1/enrich (paid)    -> 200 { profile: CompanyProfile, receipt: Receipt }

ResearchRequest = { company, depth: basic|standard|comprehensive, force_refresh }
CompanyProfile  = {
  company, confidence,
  basics:  { stage, team_size, location, mission, culture_keywords[] },
  product: { description, tech_stack[], target_market, recent_updates[] },
  funding: { stage, latest_round, total_funding, investors[], runway_estimate },
  hiring:  { open_roles[], departments_hiring[], engineering_culture, remote_policy },
  news:    { summary, product_launches[], partnerships[], press_mentions[] }
}
Receipt  = { job_id, revenue_usdc, cogs: LineItem[], margin_usdc, depth_served, cache_hit, tx_hashes[], reasoning }
LineItem = { supplier, units, unit_price_usdc, amount_usdc, tx_hash }
```

## 7. Pricing & solvency policy (the "mind")

- **Quote rule:** `accept if expected_COGS ≤ price × (1 − target_margin)`, else scope-down, else decline.
- **Reprice rule:** maintain a rolling realized-margin window; if it falls below `target_margin`, raise
  price by a step; if it sits well above and volume is healthy, lower by a step (bounded by floor/ceiling).
- **Solvency rule:** if `balance < runway_floor`, accept only clearly-positive-EV jobs and pause
  discretionary spend.
- **Spend controls — two layers (validated §3.5):**
  - *Hard caps via **Circle Spending Policies*** (native): daily/monthly USDC limits + a recipient
    allowlist (supplier-agent only) — enforced on x402 payments by Circle itself. **Mainnet-only
    (§3.5.2)**; on the testnet demo this cap is enforced in the `canUseTool` gate below and the Circle
    policy attaches on mainnet promotion.
  - *Soft **approval gate** (app-level):* spends below `approval_threshold` execute autonomously; at or
    above it the agent **pauses for human approval** (an app-level `y/N` gate, like the kit's
    `canUseTool`). The threshold sits above ordinary per-call COGS, so the agent is autonomous in steady
    state and only escalates anomalies. Autonomous by default, supervised only at the tail.
- Every decision writes a one-line **reason** to the ledger ("declined: obscure domain, est. COGS
  $0.18 > price $0.10"; "raised price $0.10 → $0.14: 3 of last 5 jobs below target margin").

## 8. Receipts, ledger & dashboard

- **Ledger:** append-only (SQLite or JSON). One row per job + one row per price change.
- **Receipt:** returned to the buyer and stored — includes tx hashes so payments are independently
  verifiable. Tx-hash source: seller-side `req.payment.transaction`; buyer-side the decoded
  `payment.receipt` (`{"transaction":"0x…"}`). Both are **optional under batched settlement** — guard for
  `undefined` and fall back to the payment proof / a "pending-batch" marker (§3.5.2).
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
| Use of the agent framework starter kit | ✅ | follows the **Claude Agent SDK kit** pattern (Circle tools as an in-process MCP server) + Circle CLI; buyer ops from the kit (§3.5, §10) |
| A clear agent workflow, not a standalone payment script | ✅ | the business loop (§5) |
| A receipt / tx hash / payment log / spend ledger | ✅ | `Receipt` with `tx_hashes` + append-only `Ledger` (§6, §8) |
| A short explanation of what the agent paid for and why | ✅ | `reasoning` on every ledger row (§7, §8) |

**Circle Agent Stack tool coverage:**

| Tool | Status | Use |
|---|---|---|
| Circle Agent Wallet | ✅ core | the treasury |
| Agent Nanopayments | ✅ | x402 per-call billing on the storefront + supplier |
| Agent Stack starter kits | ✅ | Claude Agent SDK kit pattern (buyer: wallet create/list, balance, `services pay`) |
| Circle CLI | ✅ | the treasury + buyer path: wallet create/deploy/balance/transfer + `services pay` |
| Circle Agent Marketplace | ◑ partial | discovery via `services search`/`inspect` is real & programmatic; **self-serve listing is gated/curated** (§3.5) → for the demo our service is inspectable **by URL**, not catalog-listed |
| Circle Skills | ✅ build-time | install `use-circle-wallets` / `use-gateway` to guide the build — docs, not a runtime capability (§3.5) |

**"What we're looking for" — bullets hit:** pays for data/inference/services · discovers + inspects
pricing + pays + returns a ledger · budgets/caps/policy-based spend · multi-agent paying each other ·
a marketplace that both **buys and sells** capabilities · pay-per-query data agent · autonomous
business workflow · wallet as payment identity + operating budget. The project spans **two** of
Circle's own suggested ideas at once — _Developer API Monetization Agent_ and _Agent Expense Manager_.

**Committed enhancements (folded into the design above):**
1. **Circle Agent Marketplace** discovery (`services inspect`) is the buyer's discovery surface (§4, §5).
   Note: real catalog *listing* is gated/curated (§3.5), so for the demo discovery is by-URL inspect.
2. **Approval threshold** (§7) — autonomous below `approval_threshold`, escalate above it; satisfies
   "handle approval before spend" without breaking autonomy.

**Still optional (nice-to-have):**
3. Make the buyer-agent's **discover → inspect price → pay → receive** loop a visible beat in the live
   demo — it's exactly the flow the starter kit advertises.

## 10. Tech stack (validated — Option B, polyglot)

**Node/TypeScript — money + web layer** (Bun or Node 22+):
- **Agent loop:** Claude Agent SDK (TS), Circle tools exposed as an in-process MCP server (the
  `claude-agent-sdk` kit pattern).
- **Storefront + supplier-agent:** Express + **`@circle-fin/x402-batching`** seller middleware
  (`gateway.require(...)`) — auto-`402` + payment verification.
- **Treasury / buyer:** **Circle CLI** (`@circle-fin/cli`) as a subprocess — `wallet create/deploy/
  balance/transfer`, `services search/inspect/pay`. Email+OTP auth; **Arc Testnet** (auto-funded).
- **Spend caps:** Circle **Spending Policies** (daily/monthly limits + supplier allowlist).

**Python — fulfilment engine** (internal service the storefront calls, no crypto):
- FastAPI + httpx + Pydantic; **Tavily** (search) + **Nebius TokenFactory** (OpenAI-compatible inference);
  SQLite cache. Exposes a plain `POST /enrich` consumed by the Node storefront.

**Shared:** SQLite (or JSON) ledger; minimal web dashboard (or CLI table) for treasury + P&L.

**Build-time:** install Circle Skills `use-circle-wallets` / `use-gateway` to guide the integration.

## 11. Scope & cut-list (decide what dies first when the clock bites)

Build inside-out; the items lower in this list are the first to cut.

1. **Must have (the thesis):** one paid enrichment end-to-end (deployed SCA wallets → x402 pay → fulfil
   → receipt with tx hash) + the **dynamic repricing** behavior + a visible ledger. _If only this works,
   the project still wins its point._
2. Supplier-agent (two-sided USDC). _Cut to metered-cost baseline if time-poor._
3. Solvency throttling + Circle Spending Policies under load.
4. Web dashboard. _Cut to a CLI ledger table._
5. The app-level approval gate. _Cut to Spending-Policy caps only._

**Not optional (validated §3.5):** **decline-before-charge** (x402 has no refunds) and **deploying each
SCA wallet** before its first payment. Build these in from the start.

**Demo fidelity ladder for settlement:** **Arc Testnet auto-funded USDC** (top rung — real x402, no real
money, no faucet step) → mock wallet returning tx-shaped receipts (fallback if the network/CLI is flaky
on the demo machine). Pick the highest rung that is reliable on stage.

## 12. Open questions (resolve before/at start of build)

**Resolved by validation (§3.5):**
- *Settlement* → **Arc Testnet**, auto-funded USDC.
- *Wallet* → Circle CLI; SCA must be deployed before paying.
- *Seller side* → Circle `@circle-fin/x402-batching` Express middleware.
- *Spend caps* → Circle Spending Policies + app-level approval gate.

**Still open:**
1. **THE decision — architecture:** confirm **Option B (polyglot: TS money layer + Python engine)**, or
   pick **A** (all-TS, port the engine) or **C** (all-Python, hand-rolled seller x402). *Blocks the plan.*
2. **Supplier-agent:** build it (two-sided on-chain, recommended) or start at the metered-cost baseline?
3. **Enrichment depth:** how many Tavily calls define `basic`/`standard`/`comprehensive` (sets the cost
   spread)? — instrument the real numbers on day 1.
4. **ToU + OTP setup:** the Circle email+OTP login and Terms acceptance are manual one-time steps — do
   them at build start so the demo runs headless.

## 13. Risks

- **x402 / Circle SDK integration time** is the main unknown — point effort here first; the research
  core is the easy part.
- **Tavily/Nebius latency** could make the live demo sluggish — pre-warm and cache a couple of demo
  domains.
- **Margin demo must be legible** — pre-pick a "cheap" and an "expensive" domain so the price-rise is
  guaranteed to fire on stage.
- **Forgetting to deploy the SCA wallets** → x402 signing fails (EIP-1271). Deploy both wallets in setup
  and assert deployed-state before the demo (§3.5).
- **Circle login is manual (email+OTP) + a one-time ToU acceptance** — not headless. Do it at build start;
  the session lives in `~/.circle`. Don't let the agent auto-accept the Terms.
- **No refunds + charge-before-resolve** — a flaky supplier call burns USDC. Mitigate: decline-before-
  charge, pre-warm the suppliers, and never blind-retry a paid call.
- **The Node↔Python seam** is an extra moving part — keep the Python engine to one dead-simple internal
  endpoint so the boundary can't wobble during the demo.
- **Don't over-promise the Marketplace** — listing is gated; demo discovery as `services inspect` by URL.
