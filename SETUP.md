# Proprietor — one-time manual setup

Run this once (tonight) so the agent can build + live-test overnight. Already present on this machine:
Node 26, npm, Python 3.12, uv, poetry, git, and **Circle CLI v0.0.5 (installed)**.

**Priority:** Step B (Circle login) unblocks the whole USDC payment loop — do that first. Steps A's
Tavily/Nebius keys only affect whether enrichment is *real data* vs *faked* (nice to have, not blocking).

---

## A. Secrets → put in `.env` (never paste into chat; `.env` is gitignored)

```
cp .env.example .env      # then edit .env
```

Fill what you have:
- `ANTHROPIC_API_KEY` — live CFO agent.
- `TAVILY_API_KEY` — real enrichment search (else engine runs on fakes).
- `NEBIUS_API_KEY`, `NEBIUS_BASE_URL`, `NEBIUS_MODEL` — real inference (Nebius AI Studio, OpenAI-compatible).

## B. Circle — accept Terms, then log in to the **testnet** agent session (only you can do this)

1. **Accept Circle's Terms of Use** (your agreement). Either accept interactively on first run, or, if you
   choose to, `export CIRCLE_ACCEPT_TERMS=1` in the shell you'll use.
2. **Log in (testnet, email OTP)** — two-step is the most reliable in a terminal:
   ```
   ! circle wallet login YOUR_EMAIL --type agent --testnet --init        # prints a request id
   #   → check email for a code like "B1X-123456"
   ! circle wallet login YOUR_EMAIL --type agent --testnet --request <REQUEST_ID> --otp <CODE>
   ```
   First login auto-provisions an agent wallet on every chain — **no `create` needed**.
   > Note (v0.0.5): if `--testnet` is rejected on `login`, run `! circle wallet login --help` to find the
   > testnet selector, then re-run. Confirm you're on testnet with `! circle wallet status --output json`
   > (it shows mainnet and testnet as separate sections).
3. **Verify:** `! circle wallet status --output json`

## C. Wallets — create the extra ones + deploy them on testnet

Proprietor needs three agent wallets: **treasury**, **supplier**, **buyer**. Login gives you one; make two
more, then deploy each (a wallet must be deployed before it can sign x402 — a one-time zero-value
self-transfer per chain).

```
! circle wallet create --type agent --output json      # run twice → total 3 agent wallets
! bash scripts/circle-setup.sh                          # discovers the 3 addresses, deploys each, writes them into .env
```
`scripts/circle-setup.sh` is transparent — it prints every `circle` command it runs. Review its output;
re-run with `CIRCLE_CHAIN=<id> bash scripts/circle-setup.sh` if your testnet chain id differs from
`ARC-TESTNET`.

## D. Tell me

Reply **“setup done”** (optionally paste `circle wallet status --output json`). I'll then run the live
integration overnight. Until then I build every offline-verifiable piece + tests with fakes — no waiting.
