# Build Spec — CFO Agent + Ledger (Phase 4, TypeScript)

**Self-contained task brief.** The CFO is **the agent payment brain**: the autonomous agent that holds the
treasury wallet and *decides + executes* the outbound USDC payments that run the business. Build under
`cfo/` and `ledger/`. Depends on Phase-1 (`money/treasury.ts`), the supplier-agent (`supplier/`), and the
storefront (`storefront/`).

## Why this component matters (read first)

Revenue (customer → storefront) is collected automatically by the x402 middleware — passive. The
**agentic** payment is the **outbound** one: the CFO spends USDC to *buy the research it resells*. The CFO
holding the wallet and calling the pay tool — with a logged justification — is what makes the wallet
"meaningfully part of the agent's operation" (Circle's hardest criterion). Keep that property: **all
outbound spend goes through the CFO agent's tool calls and its budget gate.**

## Framework & auth

- **Claude Agent SDK (TypeScript)**, following the `claude-agent-sdk` kit pattern: Circle capabilities as
  an **in-process MCP server** (`createSdkMcpServer({ name:'cfo', tools:[…] })`, tools via `tool(...)`).
- **Auth: the Claude Code subscription session** — `ANTHROPIC_API_KEY` is intentionally blank; the SDK uses
  the logged-in Claude Code credentials. (If a headless run can't pick those up, fall back to a key.)
- Circle tools the CFO uses: `circle_get_balance`, `circle_inspect_service`, `circle_pay_service`
  (reuse the kit's tool handlers / the Phase-1 `treasury.ts`). `circle_pay_service` is the **only** spend
  path and is gated by `canUseTool`.

## Money model (this CLARIFIES design §4.1 — operative)

- **Supplier-agent** sells per-job company research at **fixed WHOLESALE prices per depth**
  (`basic/standard/comprehensive`). It internally runs the engine (Tavily + Nebius) and **absorbs
  within-tier difficulty variance** — that's the supplier's business.
- **Storefront** sells the same research at **RETAIL prices per depth**, set by the CFO.
- **CFO margin/order = retail_paid − wholesale_paid**, both USDC, both on-chain. The CFO defends margin by
  **repricing retail** when it detects wholesale drift via `circle_inspect_service`.
- *(Stretch, not required: per-call nanopayments instead of per-job wholesale. Skip unless time allows.)*

## A. Per-order processing (the agentic payment loop)

Input from the storefront after it collects x402 revenue: `{ order_id, company, depth, retail_paid_usdc }`.

The CFO agent, per order:
1. `circle_get_balance(treasury)` → runway.
2. `circle_inspect_service(SUPPLIER_URL)` → current wholesale price for `depth`.
3. **Decide** (and write the reason): proceed if within the daily budget and runway floor. By construction
   retail ≥ wholesale (the reprice loop keeps it so), so a paid order is profitable; the CFO still checks
   budget/runway and narrates.
4. `circle_pay_service(SUPPLIER_URL, { company, depth })` → research result + supplier tx hash.
   **Gated by `canUseTool`** (see C).
5. Build `Receipt { order_id, company, depth, retail_paid_usdc, wholesale_cost_usdc, margin_usdc,
   supplier_tx_hash (guarded → "pending-batch"), reasoning, ts }`.
6. Append to the ledger; return `{ profile, receipt }` to the storefront.

> Latency: the LLM-per-order is the "agent thinking" showcase and is acceptable at demo scale; cache makes
> repeats instant. **Fallback if too slow/flaky:** a deterministic executor runs steps 1–6 under the CFO's
> current policy while the LLM handles only repricing + narration (B). Primary path = LLM-as-processor.

## B. Repricing loop (between orders or on a timer)

Periodically the CFO: `circle_inspect_service` the supplier's wholesale per depth → compute rolling
realized margin per tier → if a tier's margin < `target_margin`, **raise** its retail price by `price_step`
(bounded by floor/ceiling); if comfortably above and to drive volume, **lower** a step. It updates the
`PricingProvider` the storefront reads, and **logs every price change with a natural-language reason**
("supplier raised `standard` wholesale $0.015→$0.025; my margin fell to 17% < 40% target; raising retail
$0.03→$0.05").

## C. Budget / approval / solvency (enforced in `canUseTool`, testnet)

Config: `DAILY_CAP_USDC`, `APPROVAL_THRESHOLD_USDC`, `RUNWAY_FLOOR_USDC`, `TARGET_MARGIN`, `PRICE_STEP`,
`PRICE_FLOOR`, `PRICE_CEILING`. Track `cumulative_spent_today` in the ledger.

`canUseTool(circle_pay_service, { amount })`:
- **deny** if `cumulative_today + amount > DAILY_CAP_USDC` → CFO pauses that tier, logs it.
- **deny** if `balance − amount < RUNWAY_FLOOR_USDC` → CFO pauses spend, logs low-runway.
- **prompt human y/N** if `amount ≥ APPROVAL_THRESHOLD_USDC` (anomaly escalation).
- else **allow**.

> Circle **Spending Policies are mainnet-only** — this gate is the testnet equivalent. On mainnet, ALSO
> attach a real Circle policy (daily limit + supplier-only recipient allowlist) mirroring these values.

## D. Ledger + read view

- Append-only SQLite: `orders` (receipts), `price_changes`, `payments` — each row carries `reasoning`.
- A read view (CLI table or tiny web page): treasury balance over time, per-order P&L, price history,
  cumulative revenue / cost / margin / today's spend vs cap. This is the **spend ledger + "what it paid for
  and why"** that Circle asks for, and the demo surface.

## Circle "Best Agent Wallet Application" — how the CFO satisfies it

| Criterion / requirement | CFO behavior |
|---|---|
| Wallet action(s) | balance check + USDC payment (+ price inspection) per order |
| Discover → inspect price → pay → receipt | `inspect` supplier → `pay` → `Receipt` w/ tx hash, every order |
| Budgets / spend caps / approvals / policy | daily cap + approval threshold + runway floor in the gate (mainnet: Circle Spending Policy) |
| Multi-agent paying each other | CFO (Proprietor) pays the supplier-agent in USDC |
| Pay for API/data/inference/services | buys research (inference + data) from the supplier |
| Receipt / tx / spend ledger | per-order receipt + append-only ledger w/ tx hashes |
| Explain what it paid for & why | natural-language `reasoning` on every payment + price change |
| Wallet meaningfully part of operation | remove the wallet and the CFO cannot buy research → business halts |
| Agent Nanopayments | sub-cent / few-cent wholesale payments via x402/Gateway |

## Tests (offline, with faked Circle tools + faked supplier)

- **Order:** given an order + fakes, the CFO inspects → pays supplier → returns a receipt;
  `margin == retail_paid − wholesale`.
- **Budget gate:** a pay exceeding `DAILY_CAP_USDC` is denied + tier paused; `≥ APPROVAL_THRESHOLD_USDC`
  takes the human-prompt path; balance below `RUNWAY_FLOOR_USDC` pauses spend.
- **Reprice:** when faked wholesale rises so margin < `target_margin`, retail is raised (bounded), with a
  logged reason; when low, it lowers.
- **Tx-hash guard:** undefined supplier tx → receipt `settlement:"pending-batch"`.

## Acceptance criteria

1. The CFO agent processes an order end-to-end with fakes: inspect → pay supplier → justified receipt;
   margin correct; ledger row written with `reasoning`.
2. Daily cap, approval threshold, and runway floor are all enforced in `canUseTool` (tested).
3. Repricing fires on margin compression and is bounded + logged with a human-readable reason.
4. The read view shows treasury, per-order P&L, price history, and today's-spend-vs-cap.
5. **Live** (deployed wallets + supplier running on Arc Testnet): a real order moves real USDC
   treasury→supplier, the receipt carries a tx hash (or `pending-batch`), and the ledger shows the P&L.
6. Uses the Claude Code subscription session (no `ANTHROPIC_API_KEY`).

## Guardrails

- Do NOT touch `engine/`, `.clippy/`, `clippy.config/`. Never commit `.env`. Clean-repo: build fresh.
- `circle_pay_service` is the ONLY outbound spend path; everything routes through the `canUseTool` gate.
- Decline-before-charge upstream; never blind-retry a failed paid call; guard the tx hash.
