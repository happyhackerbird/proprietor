# Build Spec — Proprietor Money Layer, Phase 1: Circle x402 plumbing (TypeScript)

**Self-contained task brief. A fresh agent with no prior context should build this from this file alone.**

## What you are building

**Proprietor** is an AI agent that runs a paid API as a business and settles in USDC on **Circle**. This
task builds **Phase 1 of the TypeScript money layer**: a proven, reusable **x402 payment scaffold** plus a
thin **treasury** wrapper over the Circle CLI, demonstrated as a working **two-sided USDC loop on Arc
Testnet** (a seller charges, a buyer pays, a tx hash comes back).

The goal is to **de-risk the Circle plumbing first**, before any business logic. Once this works, the real
storefront and supplier-agent are just "swap the echo handler for a real one." Build under `money/`.

> ⛔ **Out of scope (later phases):** the enrichment storefront's business logic, the
> Tavily/Nebius-wrapping supplier logic, the CFO pricing/repricing brain, the ledger/dashboard. Build only
> the reusable scaffold + treasury + a trivial paid "echo" route + a buyer smoke test.

## Critical validated facts (do not re-derive — build on these)

- **Network:** **Arc Testnet** — CLI id `ARC-TESTNET`, CAIP-2 `eip155:5042002`. Testnet wallets
  **auto-fund** from the faucet on creation. No real money.
- **Facilitator URL:** `https://gateway-api-testnet.circle.com` (testnet). Mainnet would be
  `https://gateway-api.circle.com`.
- **Seller SDK:** `@circle-fin/x402-batching` (NOT in any starter kit — install it). Server entry:
  `createGatewayMiddleware({ sellerAddress, facilitatorUrl, networks })` from
  `@circle-fin/x402-batching/server`; price a route with `gateway.require("$0.001")`.
- After a paid request succeeds, the verified payment is attached as
  **`req.payment = { verified, payer, amount /* atomic USDC, ÷1e6 */, network, transaction? }`**.
  **`req.payment.transaction` is the settlement tx hash** — but it is **optional** under batched
  settlement; **guard for `undefined`** and fall back to a "pending-batch" marker.
- **Buyer side = the Circle CLI** (`@circle-fin/cli`, install globally), invoked as a subprocess:
  `circle services pay <url> --address <addr> --chain ARC-TESTNET -X POST -d '<json>' --max-amount <x>
  --output json` → `{ response: <upstream body>, payment: { amount, receipt } }`, where `receipt` is
  base64 of the `x-payment-response` header decoding to `{"transaction":"0x…"}`. **Always `--output json`**
  (table mode omits the tx hash).
- **Wallets are counterfactual SCAs:** they can receive USDC but **cannot sign x402 until deployed**, and
  **deployment is per-chain**. Deploy via a zero-value self-transfer:
  `circle wallet transfer <addr> --amount 0 --address <addr> --chain ARC-TESTNET --output json`, then
  confirm with `circle wallet balance`/non-empty `eth_getCode`.
- **Auth is email + OTP** (no API key): `circle wallet login <email> --type agent --testnet` then
  `--request <id> --otp <code>`. A one-time **Terms-of-Use** acceptance is required — **never auto-accept
  it**; surface it to the human.
- **Spending Policies are MAINNET-ONLY** — do **not** call `circle wallet limit set` on testnet (it
  errors). Budget caps are enforced in-agent in a later phase.

## Components to build (`money/`)

1. **`treasury.ts` — a typed wrapper over the `circle` CLI** (via `execFile`, `--output json`, unwrap the
   `{ data: ... }` envelope). Functions:
   - `createWallet(): Promise<{ address }>` → `circle wallet create --type agent --testnet`
   - `listWallets()`, `getBalance(address, chain)`
   - `isDeployed(address, chain): Promise<boolean>` (RPC `eth_getCode` non-empty, or balance-call probe)
   - `deployWallet(address, chain)` (zero-value self-transfer + poll until deployed)
   - `transfer(to, amount, from, chain)` (plain USDC send)
   - `payService({ url, address, chain, method, data, maxAmount }): Promise<{ response, amount, txHash? }>`
     — runs `circle services pay … --output json`, **decodes `payment.receipt` (base64 → JSON) to extract
     `transaction`**, returns it as `txHash` (may be `undefined`).
   - `inspectService(url)` → price + schema.
2. **`x402-seller.ts` — a reusable paid-route factory.** Given `{ sellerAddress, facilitatorUrl, networks,
   price, handler }`, returns an Express app (or router) that mounts `handler` behind
   `gateway.require(price)` and, on success, returns `{ ...handlerResult, receipt: { paidBy, usdc, txHash }
   }` built from `req.payment` (guarding `transaction === undefined`).
3. **`echo-seller.ts` — a trivial seller** using the factory: one route `POST /echo` priced at `$0.001`
   whose handler just echoes the request body. This is the throwaway that proves the loop.
4. **`smoke.ts` — the buyer smoke test:** uses `treasury.payService` to pay the running `echo-seller`,
   prints the `response`, the `amount`, and the `txHash` (or "pending-batch").

## Config (env, via dotenv; `.env` is gitignored)

`SELLER_WALLET_ADDRESS`, `BUYER_WALLET_ADDRESS`, `FACILITATOR_URL`
(=`https://gateway-api-testnet.circle.com`), `CHAIN` (=`ARC-TESTNET`), `NETWORK_CAIP2`
(=`eip155:5042002`), `ECHO_PORT` (=4000).

## Tests

- **Unit (offline, with a faked CLI runner injected into `treasury.ts`):** assert each function builds the
  right `circle …` argv; assert `payService` correctly base64-decodes a sample `payment.receipt` into the
  tx hash; assert the `undefined`-transaction path yields the "pending-batch" fallback.
- **Unit (seller factory):** with a fake `req.payment`, the route returns the receipt shape; a request
  without payment is rejected by the middleware (mock it).
- **Integration (env-gated, manual):** the full checklist below — create+deploy two testnet wallets, run
  `echo-seller`, pay it via `smoke.ts`, observe a tx hash (or pending-batch).

## Acceptance criteria

1. `treasury.ts` wraps every listed CLI command, parses `--output json`, and **extracts the tx hash** from
   a `services pay` result (with the `undefined` guard). Unit tests prove the argv + the receipt decode.
2. `x402-seller.ts` factory mounts a `gateway.require(price)` route and returns a receipt built from
   `req.payment`, guarding a missing `transaction`.
3. `echo-seller.ts` runs; an unpaid `POST /echo` gets `402`; a paid one returns the echo + receipt.
4. `smoke.ts` pays the echo seller end-to-end on Arc Testnet and prints `{ response, amount, txHash }`.
5. A `money/README.md` documents the **setup checklist** (below) and the env vars.
6. No business logic (no enrichment, no Tavily/Nebius, no pricing) — only the scaffold + treasury + echo.

## Setup checklist (put in `money/README.md`)

```
npm i -g @circle-fin/cli
circle wallet status                      # accept Terms of Use when prompted (do NOT auto-accept)
circle wallet login you@example.com --type agent --testnet   # then --request <id> --otp <code>
circle wallet create --type agent --testnet   # SELLER  (auto-funded)
circle wallet create --type agent --testnet   # BUYER   (auto-funded)
circle wallet list --type agent --chain ARC-TESTNET --output json   # copy both addresses into .env
# deploy BOTH SCAs on Arc Testnet (per-chain; required to sign x402):
circle wallet transfer <ADDR> --amount 0 --address <ADDR> --chain ARC-TESTNET --output json
npm i   # installs @circle-fin/x402-batching @x402/core @x402/evm viem express dotenv tsx typescript
npx tsx money/echo-seller.ts            # SELLER_WALLET_ADDRESS=<seller> in env
npx tsx money/smoke.ts                  # pays it as BUYER, prints the tx hash
```

## Notes / gotchas

- The bundled `circle-tools` package hardcodes Base/Polygon **mainnet** — do **not** depend on it; call the
  CLI + `@circle-fin/x402-batching` directly (both support testnet).
- x402 **charges before the upstream resolves** → a failed paid call is **non-refundable**; never
  blind-retry the same URL.
- For batched settlement, `transaction` may be absent at response time — that's expected; surface
  "pending-batch", don't treat it as failure.
