#!/usr/bin/env bash
#
# live-verify.sh — drive the Proprietor money layer end-to-end on Arc Testnet
# with REAL USDC, and assert the two-sided loop settled on-chain.
#
#   npm run live-verify                 # full loop, depth=basic, company=stripe.com
#   npm run live-verify -- --depth standard --company openai.com
#   npm run live-verify -- --no-echo    # skip the Phase-1 echo sanity loop
#   npm run live-verify -- --keep       # leave the services running afterwards
#
# Stages: 0 deploy SCAs · 1 ensure Gateway balances · 2 echo loop · 3 full loop.
# Spawned services are always cleaned up on exit (trap). Ports are auto-selected
# to dodge conflicts; services are rewired via env overrides (no code/.env edits).
#
# Requires: circle CLI (valid session), jq, uv, curl, lsof, npm. Wallet addresses
# + engine keys come from .env (gitignored).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
CHAIN="${CIRCLE_CHAIN:-ARC-TESTNET}"
LOGDIR="$(mktemp -d)"

# ── options ──────────────────────────────────────────────────────────────────
DEPTH="basic"; COMPANY="stripe.com"; RUN_ECHO=1; KEEP=0
MIN_GATEWAY="0.10"      # top up a payer whose Gateway balance is below this…
TOPUP="1"               # …by depositing this many USDC
while [ $# -gt 0 ]; do
  case "$1" in
    --depth) DEPTH="$2"; shift 2;;
    --company) COMPANY="$2"; shift 2;;
    --no-echo) RUN_ECHO=0; shift;;
    --keep) KEEP=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

# ── pretty logging ───────────────────────────────────────────────────────────
say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

need_tool() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }
# Read a value from .env, stripping inline ` # comments`, surrounding whitespace,
# and surrounding quotes (mirrors how dotenv parses it for the node services).
getenv() {
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
  v="$(printf '%s' "$v" | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//')"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

free_port() { local p="$1"; while lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; do p=$((p+1)); done; echo "$p"; }

wait_health() { # url, name, timeout-seconds
  local url="$1" name="$2" t="${3:-30}" i=0
  while [ "$i" -lt "$t" ]; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)" = "200" ] && { ok "$name up"; return 0; }
    sleep 1; i=$((i+1))
  done
  die "$name did not become healthy at $url (see $LOGDIR)"
}

# ── cleanup (always) ─────────────────────────────────────────────────────────
PIDS=()
cleanup() {
  [ "$KEEP" = "1" ] && { say "--keep: leaving services running. logs: $LOGDIR"; return; }
  [ "${#PIDS[@]}" -gt 0 ] && kill "${PIDS[@]}" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

# ── preflight ────────────────────────────────────────────────────────────────
say "Preflight"
for t in circle jq uv curl lsof npm; do need_tool "$t"; done
[ -f "$ENV_FILE" ] || die "no .env at $ENV_FILE"
TREASURY="$(getenv TREASURY_WALLET_ADDRESS)"; SUPPLIER="$(getenv SUPPLIER_WALLET_ADDRESS)"; BUYER="$(getenv BUYER_WALLET_ADDRESS)"
[ -n "$TREASURY" ] && [ -n "$SUPPLIER" ] && [ -n "$BUYER" ] || die "wallet addresses missing in .env"
ok "tools present; wallets: TREASURY=$TREASURY SUPPLIER=$SUPPLIER BUYER=$BUYER"
ok "depth=$DEPTH company=$COMPANY chain=$CHAIN"

# ── stage 0: deploy SCAs (idempotent) ────────────────────────────────────────
say "Stage 0 — deploy SCA wallets"
npm --prefix "$ROOT" run --silent deploy:wallets || die "wallet deploy failed"

# ── stage 1: ensure Gateway balances for the payers (BUYER, TREASURY) ─────────
say "Stage 1 — ensure Gateway balances (batched-settlement prerequisite)"
ensure_gateway() { # name, address
  local name="$1" addr="$2" bal
  bal="$(circle gateway balance --address "$addr" --chain "$CHAIN" --output json 2>/dev/null | jq -r '.data.total // "0"')"
  info "$name Gateway balance: ${bal} USDC"
  if awk "BEGIN{exit !($bal < $MIN_GATEWAY)}"; then
    info "$name below ${MIN_GATEWAY} → depositing ${TOPUP} USDC (direct, on-chain)…"
    circle gateway deposit --amount "$TOPUP" --address "$addr" --chain "$CHAIN" --method direct --timeout 180 --output json >/dev/null \
      || die "$name gateway deposit failed"
    ok "$name deposited ${TOPUP} USDC"
  else
    ok "$name sufficiently funded"
  fi
}
ensure_gateway BUYER "$BUYER"
ensure_gateway TREASURY "$TREASURY"

# ── stage 2: Phase-1 echo loop (optional sanity) ─────────────────────────────
if [ "$RUN_ECHO" = "1" ]; then
  say "Stage 2 — Phase-1 echo loop (BUYER → echo-seller)"
  EPORT="$(free_port 4000)"
  ECHO_PORT="$EPORT" npm --prefix "$ROOT" run --silent echo-seller > "$LOGDIR/echo.log" 2>&1 & ECHO_PID=$!; PIDS+=("$ECHO_PID")
  wait_health "http://127.0.0.1:$EPORT/healthz" "echo-seller" 20
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$EPORT/echo" -H 'content-type: application/json' -d '{}')"
  [ "$code" = "402" ] && ok "unpaid POST /echo → 402" || die "expected 402 on unpaid /echo, got $code"
  echo_out="$(ECHO_PORT="$EPORT" npm --prefix "$ROOT" run --silent smoke 2>&1)" || { echo "$echo_out"; die "echo smoke pay failed"; }
  echo "$echo_out" | grep -E 'txHash|amount' | sed 's/^/    /'
  echo "$echo_out" | grep -q 'txHash' && ok "echo loop settled" || die "no txHash from echo smoke"
  # free the echo port before the supplier reuses the same slot (cleanup re-kill is harmless)
  kill "$ECHO_PID" 2>/dev/null; sleep 1
fi

# ── stage 3: full two-sided loop ─────────────────────────────────────────────
say "Stage 3 — full loop (BUYER → STOREFRONT → SUPPLIER → ENGINE)"
GPORT="$(free_port 8000)"; SPORT="$(free_port 4000)"; FPORT="$(free_port 3000)"
info "ports: engine=$GPORT supplier=$SPORT storefront=$FPORT"

# engine (real Tavily+Nebius; keys exported into its process env)
( cd "$ROOT/engine"
  export TAVILY_API_KEY="$(getenv TAVILY_API_KEY)" NEBIUS_API_KEY="$(getenv NEBIUS_API_KEY)" \
         NEBIUS_BASE_URL="$(getenv NEBIUS_BASE_URL)" NEBIUS_MODEL="$(getenv NEBIUS_MODEL)" \
         NEBIUS_FAST_MODEL="$(getenv NEBIUS_FAST_MODEL)"
  uv sync --quiet 2>/dev/null
  exec uv run uvicorn app.main:app --host 127.0.0.1 --port "$GPORT"
) > "$LOGDIR/engine.log" 2>&1 & PIDS+=($!)

# supplier (ENGINE_URL → our engine) and storefront (SUPPLIER_URL → our supplier)
ENGINE_URL="http://127.0.0.1:$GPORT" SUPPLIER_URL="http://127.0.0.1:$SPORT" \
  npm --prefix "$ROOT" run --silent supplier > "$LOGDIR/supplier.log" 2>&1 & PIDS+=($!)
SUPPLIER_URL="http://127.0.0.1:$SPORT" STOREFRONT_PORT="$FPORT" \
  npm --prefix "$ROOT" run --silent storefront > "$LOGDIR/storefront.log" 2>&1 & PIDS+=($!)

wait_health "http://127.0.0.1:$GPORT/healthz" "engine" 40
wait_health "http://127.0.0.1:$SPORT/healthz" "supplier" 20
wait_health "http://127.0.0.1:$FPORT/healthz" "storefront" 20

code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$FPORT/v1/enrich/$DEPTH" -H 'content-type: application/json' -d "{\"company\":\"$COMPANY\"}")"
[ "$code" = "402" ] && ok "unpaid POST /v1/enrich/$DEPTH → 402" || die "expected 402 on unpaid enrich, got $code"

say "Customer payment: BUYER pays storefront /v1/enrich/$DEPTH"
pay_json="$(circle services pay "http://127.0.0.1:$FPORT/v1/enrich/$DEPTH" \
  --address "$BUYER" --chain "$CHAIN" -X POST -d "{\"company\":\"$COMPANY\"}" \
  --max-amount 0.2 --timeout 180 --output json 2>&1)" || { echo "$pay_json" | tail -5; die "paid call failed"; }

receipt="$(echo "$pay_json" | jq '.data.response.receipt')"
[ "$receipt" = "null" ] || [ -z "$receipt" ] && { echo "$pay_json" | jq '.' 2>/dev/null | tail -20; die "no receipt in response"; }

say "Receipt"
echo "$receipt" | jq '{revenue_usdc,wholesale_usdc,margin_usdc,revenue_tx_hash,supplier_tx_hash,settlement,depth_served,cache_hit}'

# ── assertions ───────────────────────────────────────────────────────────────
settlement="$(echo "$receipt" | jq -r '.settlement')"
supplier_tx="$(echo "$receipt" | jq -r '.supplier_tx_hash')"
margin="$(echo "$receipt" | jq -r '.margin_usdc')"
profile_company="$(echo "$pay_json" | jq -r '.data.response.profile.company')"

[ -n "$profile_company" ] && [ "$profile_company" != "null" ] || die "no profile returned"
ok "profile returned for: $profile_company"
case "$settlement" in
  settled)       ok "supplier leg settled (tx $supplier_tx)";;
  pending-batch) ok "supplier leg pending-batch (acceptable under batched settlement)";;
  *) die "unexpected settlement: $settlement";;
esac
awk "BEGIN{exit !($margin >= 0)}" && ok "margin = ${margin} USDC (revenue − wholesale)" || die "negative margin: $margin"

say "LIVE VERIFY PASSED — two-sided USDC loop confirmed on $CHAIN"
