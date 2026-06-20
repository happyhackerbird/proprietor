# Proprietor — Hackathon Submission

> Fill the **`⟨FILL⟩`** blanks (team, links) and paste each field into the official submission sheet.
> Everything else is drawn from the working repo.

---

## Project name
**Proprietor**

## One-line description
An AI agent that autonomously owns and operates a profitable micro-SaaS — settling every dollar of
revenue and cost in USDC through a Circle Agent Wallet.

## Full description
Proprietor is a **self-running company**. Its product is a **Company Enrichment API**: send it a
company domain, it returns a structured profile (industry, size, recent news, key people, funding).
The agent is the CEO, the CFO, and the only employee. Its **Circle Agent Wallet is the treasury** —
customers pay it in USDC (via x402), and it pays its own suppliers in USDC to fulfill each order.
Its single standing goal: **stay solvent and grow the treasury.**

You don't watch it send one payment — you watch it **run a business**: quoting jobs, defending its
margin, repricing when costs rise, declining work it would lose money on, escalating spend above a
policy threshold, and printing a per-order P&L with on-chain transaction hashes.

**Why it fits the theme:** the wallet *is* the governance model. A human doesn't approve each action —
the budget defines what the agent may do. Autonomy = solvency: every decision has stakes denominated
in real USDC, and money flows both *in* (customers) and *out* (suppliers) — a market, not a one-shot
transfer.

---

## Team members & contact details
| Name | Role | Email | GitHub / contact |
|------|------|-------|------------------|
| ⟨FILL⟩ | ⟨FILL⟩ | ⟨FILL⟩ | ⟨FILL⟩ |
| ⟨FILL⟩ | ⟨FILL⟩ | ⟨FILL⟩ | ⟨FILL⟩ |

## Code repository
https://github.com/happyhackerbird/proprietor

## Live deployment
⟨FILL — see options discussed; likely one of:⟩
- **On-chain proof (Arc Testnet):** live-verified two-sided USDC loop. Settlement tx hashes from
  `npm run live-verify`: ⟨paste revenue_tx_hash / supplier_tx_hash + block-explorer links⟩
- **Wallet addresses (treasury / supplier / buyer):** ⟨paste the three public addresses⟩
- ⟨or a public hosted storefront URL, if deployed⟩

## Demo video (2–3 min, max 5)
⟨FILL — public link (YouTube/Loom/Drive), set to "anyone with link can view"⟩

---

## Tracks & bounties
- **Primary track:** Agentic Commerce
- **Circle** — Agent Wallet as treasury; x402 nanopayments for per-call billing; two-sided USDC
  settlement on Arc Testnet; policy-governed spend (autonomous below threshold, escalates above).
- **Tavily** — real-time company research powering enrichment.
- **Nebius (TokenFactory)** — inference for structuring the enrichment brief (OpenAI-compatible).
⟨Confirm the exact bounty names/IDs from the sheet.⟩

---

## Tech stack
- **Money layer (TypeScript):** Circle Agent Wallet + x402 (`@circle-fin/x402-batching`, `@x402/core`,
  `@x402/evm`), `viem`, Express. Storefront (seller), supplier-agent (seller), treasury.
- **CFO agent:** Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) driving the runway → inspect →
  budget-gate → pay → receipt loop; deterministic `CfoProcessor` mirror for offline/demo runs.
- **Fulfilment engine (Python / FastAPI):** Tavily search + Nebius inference, served on `:8010`.
- **Spend ledger:** per-order P&L, natural-language reasoning, and tx hashes.
- **Chain:** Arc Testnet (USDC).

---

## How to run (reproducible)
Prereqs: Node 20+, Python 3.11+ with `uv`, Circle CLI logged into a testnet agent session, and
`.env` filled (`TAVILY_API_KEY`, `NEBIUS_*`, wallet addresses). See `README.md` / `SETUP.md`.

```bash
# one command: prove the full two-sided USDC loop settles on-chain
npm run live-verify

# one command: show the CFO's judgment — ALLOW, decline-on-cap, escalate-on-approval, + repricing + ledger
npm run cfo:demo
```

Manual walkthrough and component detail: `README.md`, `engine/README.md`, `money/README.md`.

---

## Demo video script / storyboard (≈ 2.5 min)

**0:00–0:25 — Hook (voiceover over title card or the README loop diagram)**
> "This is Proprietor: an AI agent that *owns a company*. It sells a company-enrichment API, gets paid
> in USDC, and pays its own suppliers in USDC — all through a Circle Agent Wallet. Its only job: stay
> solvent and grow the treasury. Here's a real run on Arc Testnet."

**0:25–1:15 — The money actually moves (`npm run live-verify`)**
- Run it; let the terminal show: unpaid call → `402 Payment Required` → buyer pays → receipt with
  `revenue_usdc`, `wholesale_usdc`, `margin_usdc`, and **two transaction hashes**.
- Voiceover: "Customer pays the storefront, the storefront pays the supplier, the engine does the
  research, and we get a receipt — positive margin, settled on-chain. Both legs, real USDC."
- (Optional) cut to the tx hash on a block explorer.

**1:15–2:05 — The agent's judgment (`npm run cfo:demo`)**
- Order 1 → **ALLOW**, pays supplier, positive margin, with reasoning.
- Order 2 under a tiny daily cap → **DENY (daily-cap)** — declines *before* any charge.
- Order 3 over the approval ceiling with no approver → **DENY (approval-denied)** — fails closed.
- Then the **repricing** lines: supplier raised wholesale → CFO **raises retail** to defend margin.
- Voiceover: "It's not one payment — it's a CFO. It declines unprofitable work before spending a cent,
  escalates large spend for approval, and reprices to defend its margin."

**2:05–2:30 — The ledger (close)**
- Show the ledger read-view: per-order P&L + natural-language reasoning + tx hashes.
- Voiceover: "Every decision is on the books — what it paid, why, and the on-chain proof. The wallet
  isn't a feature. It's the governance model. Take it away and the company halts."

**Recording tips:** large terminal font; pre-run once to warm caches; have the engine + supplier up
before recording the live loop; keep total under 3:00.
