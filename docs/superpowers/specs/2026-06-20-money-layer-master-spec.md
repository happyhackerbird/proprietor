# Money Layer — Clippy Build Spec (START HERE)

**Entry point for a fresh Clippy session building the Proprietor TypeScript money layer.** The Python
fulfilment engine is built by a separate session under `engine/` — you only **call** it. Build under
`money/`, `supplier/`, `storefront/`.

Read the design + component specs in this repo for full detail (this doc sequences them and pins the live
environment):
- `docs/superpowers/specs/2026-06-19-autonomous-enrichment-saas-design.md` — esp. **§3.5 / §3.5.2**
  (Circle ground truth: seller middleware API, buyer CLI shapes, deploy, receipts, spending-policy caveat).
- `docs/superpowers/specs/2026-06-20-money-layer-build-spec.md` — **Phase 1** (treasury + x402 scaffold + echo).
- `docs/superpowers/specs/2026-06-20-storefront-build-spec.md` — **Phase 2** (storefront wrapping `/enrich`).
- `docs/superpowers/specs/2026-06-20-fulfilment-engine-build-spec.md` — the engine's HTTP contract you call.
- `docs/superpowers/specs/2026-06-20-cfo-agent-build-spec.md` — **Phase 4** (the CFO agent: the payment brain + ledger).

---

## The environment is LIVE and ready (verified 2026-06-20)

- **Circle CLI v0.0.5 installed**; testnet **agent session is VALID** (persisted in `~/.circle`, shared
  across shells — your Bash can run `circle …` directly). Terms already accepted.
- **Arc Testnet:** chain id `ARC-TESTNET`, evmChainId `5042002`, CAIP-2 `eip155:5042002`, RPC
  `https://rpc.testnet.arc.network`. On Arc, **USDC is the native gas token** (decimals 18) **and** an
  ERC-20 (decimals 6) — wallets hold both.
- **Facilitator:** `https://gateway-api-testnet.circle.com`
- **Three funded agent wallets** (20 USDC each, native + ERC-20) — also in `.env`:
  - `TREASURY` `0x5d954ade327ff62cf2644899e43fc790fb7ad795` (Proprietor)
  - `SUPPLIER` `0x01602bcd81c540e37c1fa8c7af5a9b6e123b9522`
  - `BUYER`    `0x8584ddb57ebe0e94598c0a26552ce55d13b2f0d6`
- **Secrets/config in `.env`** (gitignored, never commit): `TAVILY_API_KEY`, `NEBIUS_API_KEY`,
  `NEBIUS_BASE_URL` (`https://api.tokenfactory.us-central1.nebius.com/v1/`), `NEBIUS_MODEL`
  (`moonshotai/Kimi-K2.5`), the three wallet addresses, prices, `FACILITATOR_URL`, `CIRCLE_CHAIN`.
- **Anthropic:** the CFO agent uses the **Claude Code subscription session** (no API key);
  `ANTHROPIC_API_KEY` is intentionally blank.

### Circle CLI facts you'll need (verified, some undocumented)
- `circle wallet create --type agent --testnet` — the `--testnet` flag works (NOT in `--help`). Cap: 5.
- `circle wallet fund --testnet --address <a> --chain ARC-TESTNET` — testnet faucet drip (~20 USDC).
- `circle wallet balance --address <a> --chain ARC-TESTNET --output json`.
- `circle wallet transfer <to> --amount <n> --address <from> --chain ARC-TESTNET --output json` — plain
  USDC send; **agent-wallet transfers return a transaction *ID* (async), not a hash** — poll to confirm.
- `circle services inspect <url> --output json` / `circle services pay <url> --address <a> --chain
  ARC-TESTNET -X POST -d '<json>' --max-amount <x> --output json` → `{ response, payment:{ amount,
  receipt } }`; `payment.receipt` is base64 of the `x-payment-response` header decoding to
  `{"transaction":"0x…"}`. Always `--output json`.
- ⚠️ **Wallets are counterfactual SCAs** — each must be **deployed** (one zero-value self-transfer per
  chain: `circle wallet transfer <addr> --amount 0 --address <addr> --chain ARC-TESTNET`) before it can
  sign x402. Receiving funds does NOT deploy it. **This is integration step 0.**
- ⚠️ **Spending Policies are mainnet-only** — don't call `circle wallet limit set` on testnet; enforce
  budget caps in-agent (CFO phase).

---

## Build order — each step: build → offline tests (injected fakes) → commit → then live-verify

**0. Deploy the wallets (one-time):** deploy `TREASURY` and `SUPPLIER` (and `BUYER`) on `ARC-TESTNET` via
the zero-value self-transfer; confirm via balance/`eth_getCode`. (Your `treasury.ts` `deployWallet` does
this; run it once for the three addresses.)

**1. Phase 1 — `money/`** (per the money-layer-build-spec): `treasury.ts` (CLI wrapper incl.
`deployWallet`, `payService` that decodes the tx hash), `x402-seller.ts` (paid-route factory on
`@circle-fin/x402-batching`), `echo-seller.ts`, `smoke.ts`. Offline unit tests with a faked CLI runner.
  - **Live-verify:** run `echo-seller` as `SUPPLIER`; pay it from `BUYER` via `circle services pay`;
    confirm a tx hash (or `pending-batch`). This proves the whole Circle loop before any business logic.

**2. Supplier-agent — `supplier/`:** swap the echo handler for a **per-job research seller** — one
x402-paid route (`POST /research { company, depth }`) that calls the engine (which uses Tavily + Nebius,
keys from `.env`) and returns the profile. Priced at **fixed wholesale prices per depth**; the supplier
absorbs within-tier difficulty variance. This is the service the Proprietor's CFO buys wholesale and
resells. (See the CFO build spec for the money model.)

**3. Storefront — `storefront/`** (per the storefront-build-spec): paid x402 route **per depth tier**
wrapping the engine's `POST /enrich`; builds the `Receipt` (revenue, metered cost, margin, guarded
tx_hash, depth, cache_hit, reasoning); static `PricingProvider`.
  - **Live-verify:** `BUYER` pays `storefront /v1/enrich/standard` → storefront pays `SUPPLIER` → returns
    `{ profile, receipt }` with a tx hash.

**4. CFO agent + ledger** (Claude Agent SDK, `canUseTool` budget gate, per-order pay-the-supplier loop,
dynamic repricing) — see `docs/superpowers/specs/2026-06-20-cfo-agent-build-spec.md`. This is the payment
brain; build it once the supplier + storefront live-verify.

---

## Guardrails

- **Do NOT touch** `engine/`, `.clippy/`, `clippy.config/` (owned by the engine session).
- **Never commit `.env`** (it holds live keys). Clean-repo rule: build fresh, no copying from elsewhere.
- **Decline-before-charge** (x402 has no refunds); **guard `req.payment.transaction === undefined` →
  `pending-batch`**; never blind-retry a failed paid call.
- **Reuse** the Phase-1 `x402-seller` factory + `treasury.ts` in the supplier and storefront — don't
  reimplement x402 or wallet logic.

## Definition of done

- Offline unit tests green for `money/`, `supplier/`, `storefront/`.
- **Live two-sided loop on Arc Testnet:** `BUYER → STOREFRONT → SUPPLIER`, real USDC moves, and the
  returned `Receipt` carries a settlement tx hash (or a `pending-batch` marker under batched settlement).
