# Money layer — Phase 1 (Circle x402 plumbing)

The reusable USDC payment scaffold for Proprietor: a typed treasury wrapper over the Circle CLI
(`treasury.ts`), a reusable x402 paid-route factory (`x402-seller.ts`), a throwaway echo seller, a
buyer smoke test, and the step-0 wallet-deploy script. The supplier-agent (`supplier/`) and the
storefront (`storefront/`) reuse this scaffold — do not re-implement x402 or wallet logic.

## Components

| File | Role |
|------|------|
| `treasury.ts` | Typed wrapper over `circle …` (CLI runner injected for offline tests). `createWallet`, `listWallets`, `getBalance`, `isDeployed`, `deployWallet`, `transfer`, `payService` (decodes the settlement tx hash, guarded), `inspectService`. |
| `x402-seller.ts` | `createPaidApp({ sellerAddress, facilitatorUrl, networks, routes })` → Express app mounting each handler behind `gateway.require(price)`; appends a `receipt` built from `req.payment` (guards `transaction === undefined` → `pending-batch`). |
| `echo-seller.ts` | One paid route `POST /echo` @ `$0.001` (seller = SUPPLIER wallet). Proves the loop. |
| `smoke.ts` | Buyer smoke test: pays the echo seller from BUYER, prints `{ response, amount, txHash }`. |
| `deploy.ts` | Step 0: deploys TREASURY/SUPPLIER/BUYER SCAs (zero-value self-transfer), confirms `eth_getCode`. |

## Critical facts

- **Network:** Arc Testnet — CLI id `ARC-TESTNET`, CAIP-2 `eip155:5042002`. No real money.
- **Facilitator:** `https://gateway-api-testnet.circle.com` (testnet).
- **Wallets are counterfactual SCAs** — must be **deployed per chain** before they can sign x402.
  Receiving USDC does not deploy them. This is step 0 (`deploy.ts`).
- **`req.payment.transaction`** (the settlement tx hash) is **optional** under batched settlement —
  always guard for `undefined` → `pending-batch`. x402 **charges before** the upstream resolves, so a
  failed paid call is **non-refundable**: never blind-retry.
- **Spending Policies are mainnet-only** — budget caps are enforced in-agent (CFO phase), not here.

## Setup checklist

```bash
npm i -g @circle-fin/cli
circle wallet status                      # accept Terms of Use when prompted (do NOT auto-accept)
circle wallet login you@example.com --type agent --testnet   # then --request <id> --otp <code>
# (this repo's three wallets already exist & are funded — addresses are in .env)

npm install                               # installs @circle-fin/x402-batching @x402/core @x402/evm viem express dotenv tsx vitest typescript

# Step 0 — deploy the SCAs on Arc Testnet (per-chain; required to sign x402):
npm run deploy:wallets

# Prove the loop:
npm run echo-seller                       # terminal A — seller = SUPPLIER
npm run smoke                             # terminal B — pays it as BUYER, prints the tx hash
```

## Env vars (`.env`, gitignored — see `.env.example`)

`TREASURY_WALLET_ADDRESS`, `SUPPLIER_WALLET_ADDRESS`, `BUYER_WALLET_ADDRESS`, `FACILITATOR_URL`,
`CIRCLE_CHAIN` (`ARC-TESTNET`), `NETWORK_CAIP2` (`eip155:5042002`), `ARC_RPC_URL`, `ECHO_PORT` (4000).

## Tests

`npm test` — offline unit tests (faked CLI runner + faked `req.payment`); zero real CLI/RPC calls.
Asserts each `circle …` argv, the base64 receipt → tx-hash decode, the `undefined`-transaction →
`pending-batch` fallback, and the seller factory's receipt shape.
