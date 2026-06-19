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

## The live demo (≈ 2–3 min)

1. Show the treasury balance and the current published price.
2. Enrich a **well-known** company → cheap to fulfill, healthy margin, treasury ticks **up**.
3. Enrich an **obscure** company → many searches, **thin/negative** margin; the agent flags the loss.
4. The agent **autonomously raises its price** in response.
5. Enrich again → margin restored. Open the **ledger**: per-job P&L + reasoning + tx hashes.
6. (Stretch) Flood it → it **throttles / declines** jobs it can't fulfill profitably.

## Status

Greenfield. This repo currently contains the **design** only — see
[`docs/superpowers/specs/2026-06-19-autonomous-enrichment-saas-design.md`](docs/superpowers/specs/2026-06-19-autonomous-enrichment-saas-design.md)
for the full architecture, data flow, pricing policy, scope/cut-list, and open questions.
