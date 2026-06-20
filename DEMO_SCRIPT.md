# Proprietor — Demo Recording Script (~2:45)

Two hero commands carry the whole demo: **`npm run live-verify`** (the money loop) and
**`npm run cfo:demo`** (the decisions). Everything below is staging around those two.

Legend for "where I run it":
- **[BROWSER]** — a browser tab (the Vercel site, or `web/index.html` opened locally)
- **[MAIN]** — your big, on-camera terminal
- **[ENGINE]** — a side terminal running the fulfilment engine
- **[SUPPLIER]** — a side terminal running the supplier-agent

---

## ⏱ Before you hit record (5-min setup)
1. **Terminal looks**: font 18–20pt, dark theme, wide window, clear scrollback (`clear`).
2. **Circle session live**: `circle wallet status --output json` → testnet section present, wallets funded.
3. **Warm run once** (caches + on-chain confirmations make take 2 much smoother):
   ```bash
   npm run live-verify          # let it fully pass once
   # then, with engine+supplier up (see Beat 2), run:
   npm run cfo:demo
   ```
4. **Open the site** in [BROWSER]: your Vercel URL (if Deployment Protection is OFF), **or** just
   open `web/index.html` locally — the price table renders from a built-in fallback even offline.
5. **Timing note**: `live-verify` has ~10–30s of real on-chain/research waits. Either keep it (authentic)
   or trim the dead air in editing. Don't fake it.

---

## 🎬 Shot list

### 0:00 – 0:20 · Cold open  → **[BROWSER]**
- **SCREEN**: the landing page hero — *"Proprietor — an AI agent that owns a company"*. Slowly scroll to the **live price table**.
- **SAY**: *"This is Proprietor — an AI agent that doesn't just take payments, it runs a company. It sells a company-enrichment API, and it has a treasury."*

### 0:20 – 0:35 · The thesis  → **[BROWSER]**
- **SCREEN**: scroll to the **loop diagram** on the page.
- **SAY**: *"Customers pay it in USDC. It pays its own suppliers in USDC. One wallet, both sides of a market. Its only job: stay solvent and grow the treasury. Here's a real run on Arc Testnet."*

### 0:35 – 1:25 · BEAT 1 — the two-sided money loop  → **[MAIN]**
- **RUN [MAIN]**:
  ```bash
  npm run live-verify
  ```
- **SCREEN** — point at each as it scrolls:
  1. `unpaid POST /v1/enrich/basic → 402` — *the x402 challenge*
  2. `Customer payment: BUYER pays storefront` — *revenue leg*
  3. the **Receipt** block: `revenue_usdc`, `wholesale_usdc`, **`margin_usdc`**, `revenue_tx_hash`, `supplier_tx_hash`, `settlement`
  4. `LIVE VERIFY PASSED — two-sided USDC loop confirmed`
- **SAY**: *"An unpaid call gets four-oh-two, Payment Required. The buyer pays USDC — revenue lands in the treasury. Then the storefront turns around and pays its supplier in USDC for the research. Both legs settle on-chain — these two transaction hashes — and the margin is positive. That's the whole thesis: it earned, it spent, it came out ahead."*

### 1:25 – 1:35 · Bring up the brain  → **[ENGINE]** + **[SUPPLIER]**
> Start these BEFORE recording this beat so they're healthy; show them briefly, don't wait on logs.
- **RUN [ENGINE]**:
  ```bash
  cd engine && uv run uvicorn app.main:app --port 8010
  ```
- **RUN [SUPPLIER]**:
  ```bash
  npm run supplier
  ```
- **SAY**: *"That was the plumbing. Now the brain — the CFO."*

### 1:35 – 2:30 · BEAT 2 — the CFO decides  → **[MAIN]**
- **RUN [MAIN]**:
  ```bash
  npm run cfo:demo
  ```
- **SCREEN** — point at each block:
  1. `▶ Order 1 — normal` → **`ALLOW → paid`** + `margin` + `reasoning`
  2. `▶ Order 2 — daily cap hit` → **`DENY (daily-cap)`** — *decline-before-charge*
  3. `▶ Order 3 — approval required` → **`DENY (approval-denied)`** — *fail-closed*
  4. the **ledger read-view** — per-order P&L + reasoning + tx hashes
  5. the **Repricing decisions** — `standard: $0.03→… RAISE` to defend margin
- **SAY**: *"Before every job the CFO checks its runway and inspects the supplier's live price. Order one is profitable — it pays, on-chain, with a stated reason. Order two would blow a daily spend cap — declined before a cent moves. Order three needs human approval and has none — it fails closed. Then, between jobs, it reprices: the supplier raised wholesale, so the CFO raises retail to defend its margin. Every decision is on the ledger — what it paid, why, and the transaction hash."*

> **Optional — show the real LLM reasoning** (the inspect fix is now on `main`, so this works):
> **RUN [MAIN]**: `npm run cfo -- '{"order_id":"o1","company":"stripe.com","depth":"basic","retail_paid_usdc":0.01}'`
> The live Agent-SDK CFO inspects the **verified** price and prints natural-language reasoning citing
> *"wholesale $0.005 (inspect)"*, gate cleared, supplier paid → `settlement: settled`. Use this if you want
> a human-readable "why" on screen; skip it if you want a tighter, deterministic take.

### 2:30 – 2:45 · Close  → **[BROWSER]**
- **SCREEN**: back to the site's **on-chain proof** section (the tx hashes), or the ledger output.
- **SAY**: *"Revenue in, cost out, positive margin — all settled on-chain. The wallet isn't a feature here; it's the governance model. Take it away and the company halts. That's Proprietor — an agent that runs a business."*

---

## 🚦 Honesty guardrails (do NOT overclaim)
- It's **Arc Testnet / test USDC** — say "settles on-chain, no real funds." Reproducibility is a strength.
- `cfo:demo` is the **deterministic** CFO processor (same runway→inspect→gate→pay→receipt loop, no LLM
  subprocess). `npm run cfo` is the live-LLM version. Don't imply the recorded run is the LLM unless you ran that.
- The **supplier models a third-party vendor**; in this build both sides are your own funded wallets. Say
  *"it buys its inputs from a separate priced agent over x402,"* not *"from a real external company."*
- The **settlement IDs are Circle Gateway batched-nanopayment UUIDs**, not `0x` on-chain hashes — they're
  *settled*, but say *"settled via Circle's batched gateway"* and prove it on-chain by pointing at the
  **wallet addresses** on the Arc explorer (`testnet.arcscan.app/address/…`), which is how the site does it.

---

## 🧾 Command cheat-sheet (in record order)
```text
[BROWSER]   open the Vercel site (or web/index.html locally)
[MAIN]      npm run live-verify
[ENGINE]    cd engine && uv run uvicorn app.main:app --port 8010
[SUPPLIER]  npm run supplier
[MAIN]      npm run cfo:demo
```
Minimum viable demo = the two `[MAIN]` commands. The browser bookends and the side terminals are polish.
