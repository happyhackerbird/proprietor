# Build Spec — Proprietor Money Layer, Phase 2: Storefront (TypeScript)

**Self-contained task brief. Builds on Phase 1 (the x402 scaffold + treasury) and the Python engine's
`/enrich` contract. A fresh agent should be able to build this from this file + those two artifacts.**

## What you are building

**Proprietor** runs a paid Company Enrichment API as a business and settles in USDC on Circle. This task
builds the **storefront** — the customer-facing **x402-paid** HTTP service that buyers pay USDC to for an
enrichment. It takes payment, calls the enrichment **engine** to fulfil, and returns the profile **plus a
receipt** (revenue, cost, margin, tx hash). Build under `storefront/` (TypeScript, Express).

## Depends on (reuse — do NOT reinvent)

- **Phase 1 money layer** (`money/x402-seller.ts` factory + `money/treasury.ts`). Import the seller
  factory for the paid routes; do not re-implement x402.
- **The engine's HTTP contract** (already specified/being built):
  - `POST /enrich { company, depth, force_refresh } -> { profile: CompanyProfile, cost: { tavily_searches,
    nebius_calls, nebius_tokens, est_usd }, cache_hit, depth_served }`
  - `POST /preview { company } -> { disambiguation_choices: [...] }`
  Treat the engine as an internal HTTP service at `ENGINE_URL`.

> ⛔ **Out of scope (later phases):** the CFO **dynamic repricing** brain (Phase 3) and the **ledger /
> dashboard** (Phase 4). This phase uses a **static `PricingProvider`** (fixed price per depth) behind an
> interface the CFO will later implement. Also out of scope: the **supplier-agent** — until it lands, the
> engine's reported COGS is recorded as a **metered** cost on the receipt (revenue is real on-chain x402;
> COGS becomes on-chain when the supplier-agent is wired in).

## Pricing model (operative — refines design §3/§5)

**Tiered by depth.** Each depth (`basic|standard|comprehensive`) has a current published USDC price from
the `PricingProvider`. The buyer chooses a depth and pays that tier's price. Per-request margin still
varies (an obscure company costs more *within* a tier); the CFO reprices tiers over time (Phase 3). A tier
may be marked **unavailable** → the storefront refuses with 4xx and **no payable `402`** (this is
"decline-before-charge"; x402 has no refunds).

## HTTP interface

```
GET  /v1/enrich/schema     -> 200 (free) { input:{company,depth}, output: <CompanyProfile schema>,
                                           price_table: { basic, standard, comprehensive }, terms }
POST /v1/preview           -> 200 (free) proxies engine /preview  { disambiguation_choices:[...] }

POST /v1/enrich/:depth      (PAID via x402 at the tier's published price)
   depth ∈ {basic,standard,comprehensive}; body { company, force_refresh? }
   unpaid     -> 402 (challenge at that tier's price)
   tier off   -> 409/4xx (no payable 402)  # decline-before-charge
   paid       -> 200 { profile: CompanyProfile, receipt: Receipt }

GET  /healthz              -> 200 { ok: true }
```

**Why one route per depth:** the x402 middleware fixes a route's price at mount time and issues the `402`
before the handler runs, so price cannot depend on the request body. Mount one paid route per tier, each
with `gateway.require(price[tier])`. *(If — and only if — `@circle-fin/x402-batching`'s `gateway.require`
accepts a resolver `(req)=>price`, a single `/v1/enrich` route reading `:depth` is acceptable instead.
Check the SDK; default to per-tier routes.)*

## Receipt

```
Receipt = {
  job_id, company, depth_served, cache_hit,
  revenue_usdc,            // from req.payment.amount (atomic ÷ 1e6)
  cost: { source:"metered", tavily_searches, nebius_calls, nebius_tokens, est_usd },
  margin_usdc,             // revenue_usdc - cost.est_usd
  tx_hash,                 // req.payment.transaction — may be null under batched settlement
  settlement: "settled" | "pending-batch",
  reasoning                // e.g. "standard tier $0.03; cache_hit=false; 3 Tavily + 5 Nebius calls"
}
```

Persistence is Phase 4 — but emit one **structured JSON log line per completed job** (the receipt) so the
ledger can ingest it later. Return the receipt in the response body too.

## PricingProvider (injected interface)

```
interface PricingProvider {
  priceFor(depth): { price_usdc: string /* "$0.03" */, available: boolean };
  priceTable(): { basic, standard, comprehensive };  // for /schema
}
```
Phase-2 implementation: **static**, reads `PRICE_BASIC/STANDARD/COMPREHENSIVE` from env (placeholders, e.g.
`$0.01 / $0.03 / $0.08`). The Phase-3 CFO will provide a dynamic implementation of this same interface —
keep the storefront depending only on the interface.

## Flow (POST /v1/enrich/:depth, paid)

1. x402 middleware verifies payment at the tier price (Phase-1 factory) → `req.payment` available.
2. Call engine `POST /enrich { company, depth, force_refresh }`.
3. Build the `Receipt`: `revenue = req.payment.amount/1e6`, `cost = engine.cost.est_usd`,
   `margin = revenue - cost`, `tx_hash = req.payment.transaction ?? null`
   (`settlement = tx_hash ? "settled" : "pending-batch"`), plus `depth_served`, `cache_hit`, `reasoning`.
4. Emit the receipt as a JSON log line; return `{ profile, receipt }`.

## Config (env; `.env` gitignored)

`ENGINE_URL`, `SELLER_WALLET_ADDRESS`, `FACILITATOR_URL` (=`https://gateway-api-testnet.circle.com`),
`CHAIN` (=`ARC-TESTNET`), `NETWORK_CAIP2` (=`eip155:5042002`),
`PRICE_BASIC`, `PRICE_STANDARD`, `PRICE_COMPREHENSIVE`, `STOREFRONT_PORT` (=3000).

## Tests (offline, with fakes)

- **Fake engine client + fake `req.payment`:** `POST /v1/enrich/standard` returns `{profile, receipt}`;
  `margin_usdc === revenue_usdc - engine.cost.est_usd`.
- **tx-hash guard:** `req.payment.transaction === undefined` → `tx_hash:null`, `settlement:"pending-batch"`.
- **Free routes:** `/v1/preview` proxies the engine and requires no payment; `/v1/enrich/schema` returns
  the price table from the `PricingProvider`.
- **Decline-before-charge:** a tier with `available:false` returns 4xx and does **not** expose a payable
  `402` route.
- **Reuse:** the paid routes are built via the Phase-1 `x402-seller` factory (assert no duplicated x402
  logic).

## Acceptance criteria

1. `GET /healthz` → 200; `GET /v1/enrich/schema` returns the tier price table.
2. `POST /v1/preview` is free and proxies the engine's disambiguation.
3. Each depth is a paid x402 route at its published price: unpaid → `402`, paid → `{profile, receipt}`.
4. `Receipt` carries revenue, metered cost, `margin = revenue − est_usd`, guarded `tx_hash`/`settlement`,
   `depth_served`, `cache_hit`, and a human `reasoning` string; one JSON log line is emitted per job.
5. `PricingProvider` is an injected interface with a static env-backed impl; an unavailable tier is
   declined before any charge.
6. Offline tests pass with fakes; the storefront reuses the Phase-1 scaffold; **no CFO repricing and no
   ledger/dashboard logic** in this phase.

## Integration (env-gated, manual)

With the engine running, a deployed seller wallet, and the Phase-1 loop working: pay
`POST /v1/enrich/standard` for a known company via the buyer CLI and confirm a real `CompanyProfile` plus a
`Receipt` with a tx hash (or `pending-batch`).

## Notes / gotchas

- **Decline-before-charge** and **no refunds** — never issue a payable `402` for a tier you won't serve;
  never blind-retry a failed paid call.
- **Guard `req.payment.transaction`** (`undefined` under batched settlement → `pending-batch`).
- COGS is **metered** this phase (from the engine's `cost`); it becomes on-chain when the supplier-agent
  lands — keep `cost.source` a field so that swap is a one-liner.
- Don't reimplement x402 or wallet logic — import from `money/`.
