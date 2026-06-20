# Proprietor

**An AI agent that autonomously owns and operates a profitable micro-SaaS — settling every dollar of revenue and cost in USDC through a Circle Agent Wallet.**

> Built for the **Agents Hackathon @ 42berlin** (June 19–20, 2026) — _Agentic Commerce_ track.
> Stacks: **Circle Agent Wallet** · **Tavily** · **Nebius TokenFactory**.

---

## The one-liner

Proprietor is a **self-running company**. Its product is a **Company Enrichment API**: send it a
company domain, it returns a structured profile (industry, size, recent news, key people, funding).
The agent is the CEO, the CFO, and the only employee. Its **Circle Agent Wallet is the treasury** —
customers pay it in USDC, and it pays its own suppliers in USDC to fulfill each order. Its single
standing goal: **stay solvent and grow the treasury.**

You don't watch it send one payment. You watch it **run a business**: quoting jobs, defending its
margin, repricing when costs rise, declining work it would lose money on, and printing a P&L.

## Why this is the right shape for the hackathon

The hackathon's own thesis is that agents become *"independent actors with a mind of their own"* and
that money is *"the final tool every economic actor needs."* Proprietor makes that literal:

- **The wallet is the governance model, not a feature.** A human doesn't approve each action — the
  *budget* defines what the agent is allowed to do. Take the wallet away and the company halts.
- **Autonomy = solvency.** Every decision has stakes denominated in real USDC. An unprofitable job it
  accepts is real money lost. That tension is the demo.
- **Two-sided commerce.** Money flows *in* from customers and *out* to suppliers — a market, not a
  one-shot transfer.

## How it works (the loop)

```
                   ┌──────────────────────────────────────────────────┐
   customer-agent  │                  PROPRIETOR                       │
        │          │  ┌────────────┐   ┌───────────┐   ┌────────────┐  │
        │ 1. GET   │  │ Storefront │   │    CFO     │   │ Fulfilment │  │
        │  schema  │  │  (x402     │──▶│  pricing + │──▶│  engine    │  │
        │  + price │  │   API)     │   │  solvency  │   │ (research) │  │
        │◀─────────┼──│            │   └───────────┘   └─────┬──────┘  │
        │ 2. POST  │  └─────┬──────┘                         │         │
        │  {domain}│        │                                │ pays    │
        │◀── 402 ──┼────────┘                                ▼ USDC    │
        │ 3. pay   │  ┌───────────────────┐          ┌───────────────┐ │
        │  USDC ───┼─▶│ Circle Agent      │◀─────────│ Supplier-agent│ │
        │          │  │ Wallet (treasury) │  pays    │ (Tavily +     │ │
        │ 4. brief │  └───────────────────┘  USDC    │  Nebius x402) │ │
        │◀─────────┼──── + receipt (tx hashes, cost breakdown, margin)│ │
        └──────────┤                                 └───────────────┘ │
                   └──────────────────────────────────────────────────┘
```

1. A buyer-agent **discovers** the service on the **Circle Agent Marketplace** and reads its published **schema + current price**.
2. It POSTs a company domain; the API replies **`402 Payment Required`** with the price and pay-to address.
3. The buyer **pays USDC** → revenue lands in the treasury.
4. Proprietor decides the job is worth doing, **pays its own suppliers in USDC**, fulfills, and returns
   the brief **plus a receipt**: revenue, itemized costs, transaction hashes, and gross margin.

Between jobs, the CFO watches the treasury and **adjusts the public price** to defend margin.

## Circle Agent Stack usage

| Capability | How Proprietor uses it |
|---|---|
| **Circle Agent Wallet** | The company treasury — holds USDC, receives revenue, pays suppliers. |
| **Balance check** | The CFO reads runway before every pricing decision. |
| **Receive payment** | Customer revenue per enrichment (via x402). |
| **Send payment** | Pays the supplier-agent in USDC per upstream call. |
| **Agent Nanopayments / x402** | Per-call billing on the storefront endpoint. |
| **Circle Agent Marketplace** | Discovery surface — buyer-agents `inspect` the enrichment service's x402 price + schema by URL, then pay. (Catalog listing is curated/gated; demo uses by-URL inspect.) |
| **Transaction logs / receipts** | Every job's revenue + costs returned as on-chain receipts. |
| **Circle CLI / starter kit** | Creates and manages the wallet at setup. |

Spend is **policy-governed**: payments run autonomously below an approval threshold and escalate for
human approval above it — autonomous by default, supervised only at the tail.

## Run it (live on Arc Testnet — no real money)

**Prerequisites**
- Node 20+, Python 3.11+ with `uv`, and the **Circle CLI** logged in to a testnet agent session:
  `circle wallet login <email> --type agent --testnet`.
- `cp .env.example .env`, then fill `TAVILY_API_KEY`, `NEBIUS_API_KEY` / `NEBIUS_BASE_URL` / `NEBIUS_MODEL`.
  The three agent-wallet addresses (treasury / supplier / buyer), `ENGINE_URL` (→ `:8010`),
  `FACILITATOR_URL`, and `CIRCLE_CHAIN` are already templated. Fund each wallet:
  `circle wallet fund --testnet --address <addr> --chain ARC-TESTNET`.
- Install deps: `npm install` (TypeScript money layer) and `cd engine && uv sync` (Python engine).

**Start the services** (each in its own terminal)
```bash
cd engine && uv run uvicorn app.main:app --port 8010   # fulfilment engine (matches ENGINE_URL in .env)
npm run supplier                                        # supplier-agent — x402 seller (SUPPLIER wallet)
npm run storefront                                      # storefront     — x402 seller (TREASURY wallet)
npm run deploy:wallets                                  # one-time: deploy the SCAs so they can sign x402
```

**Drive the demo**
```bash
# (optional) minimal Circle loop check: buyer pays a throwaway echo seller
npm run echo-seller   # terminal A
npm run smoke         # terminal B → prints amount + settlement tx

# 1. inspect the storefront's price table + schema (free)
curl -s localhost:3000/v1/enrich/schema | jq

# 2. full two-sided loop — BUYER pays storefront → storefront pays SUPPLIER → profile + receipt
circle services pay http://localhost:3000/v1/enrich/basic \
  --address "$BUYER_WALLET_ADDRESS" --chain ARC-TESTNET \
  -X POST -d '{"company":"stripe.com"}' --max-amount 0.02 --output json | jq

# 3. the CFO *agent* processes an order itself (Claude Agent SDK on your subscription —
#    run from a terminal where Claude Code is authenticated)
npm run cfo -- '{"order_id":"o1","company":"stripe.com","depth":"basic","retail_paid_usdc":0.01}'

# 4. read the spend ledger — per-order P&L, reasoning, and tx hashes
npx tsx cfo/ledger-cli.ts
```

Component-level detail: [`engine/README.md`](engine/README.md) · [`money/README.md`](money/README.md).

## The demo narrative (≈ 2–3 min)

1. Show the treasury balance and the current published price (`/v1/enrich/schema`).
2. Enrich a company → storefront collects retail, CFO pays wholesale, **receipt shows a positive margin**; the ledger ticks up.
3. Raise the supplier's wholesale price → the CFO detects it on `inspect` and **raises retail to defend margin**.
4. Force a tiny daily cap → the budget **gate declines the spend before any charge** (decline-before-charge).
5. Open the **ledger**: per-job P&L + natural-language reasoning + tx hashes.

## Status

**Built and live-verified on Arc Testnet.** The fulfilment engine, the money layer (Circle treasury +
supplier-agent + storefront), and the CFO agent + spend ledger are all implemented, unit-tested, and
proven live with real USDC payments — the full two-sided loop (buyer → storefront → supplier → engine)
and the CFO's gated pay/decline both settle on-chain. Use the run steps above.

Design + validated Circle Agent Stack integration:
[`docs/superpowers/specs/2026-06-19-autonomous-enrichment-saas-design.md`](docs/superpowers/specs/2026-06-19-autonomous-enrichment-saas-design.md).
