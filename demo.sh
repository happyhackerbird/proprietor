#!/usr/bin/env bash
#
# demo.sh — boot every Proprietor service plus the interactive demo console.
#
#   ./demo.sh                # start everything, open the browser
#   ./demo.sh --no-engine    # skip the Python engine (use if uv/keys missing)
#   ./demo.sh --no-open      # don't try to open the browser
#   ./demo.sh --stop         # kill anything started by a previous demo.sh
#
# The demo console runs at http://127.0.0.1:5500 and proxies to:
#   engine     :8000  (FastAPI — real Tavily/Nebius enrichment)
#   supplier   :4000  (x402 research-seller)
#   storefront :3000  (x402 customer-facing API)
#
# Logs are written to ./logs/<service>.log and tailed live in the UI.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/logs"
PID_DIR="$ROOT/.demo-pids"
ENV_FILE="$ROOT/.env"

DEMO_PORT="${DEMO_PORT:-5500}"
ENGINE_PORT="${ENGINE_PORT:-8000}"
SUPPLIER_PORT="${SUPPLIER_PORT:-4000}"
STOREFRONT_PORT="${STOREFRONT_PORT:-3000}"

RUN_ENGINE=1; OPEN_BROWSER=1; STOP_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-engine) RUN_ENGINE=0; shift;;
    --no-open)   OPEN_BROWSER=0; shift;;
    --stop)      STOP_ONLY=1; shift;;
    -h|--help)
      sed -n '2,16p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

free_port() {
  local p="$1"
  while command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; do
    p=$((p+1))
  done
  echo "$p"
}

wait_health() {
  local url="$1" name="$2" t="${3:-30}" i=0
  while [ "$i" -lt "$t" ]; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)" = "200" ] && { ok "$name healthy ($url)"; return 0; }
    sleep 1; i=$((i+1))
  done
  warn "$name didn't respond on $url in ${t}s (check $LOG_DIR/$name.log)"
  return 1
}

stop_pids() {
  [ -d "$PID_DIR" ] || return 0
  for f in "$PID_DIR"/*.pid; do
    [ -e "$f" ] || continue
    local pid; pid=$(cat "$f" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null && ok "stopped $(basename "$f" .pid) (pid $pid)"
    fi
    rm -f "$f"
  done
}

start_bg() {
  # start_bg <name> <command...>
  local name="$1"; shift
  local log="$LOG_DIR/$name.log"
  : > "$log"
  ( "$@" >>"$log" 2>&1 ) & local pid=$!
  echo "$pid" > "$PID_DIR/$name.pid"
  info "$name → pid $pid · log $log"
}

# ─── stop mode ───────────────────────────────────────────────────────────────
if [ "$STOP_ONLY" = "1" ]; then
  say "Stopping demo services"
  stop_pids
  exit 0
fi

# ─── preflight ───────────────────────────────────────────────────────────────
say "Preflight"
need node; need npm; need curl
[ "$RUN_ENGINE" = "1" ] && { command -v uv >/dev/null 2>&1 || { warn "uv not found — engine disabled"; RUN_ENGINE=0; }; }
mkdir -p "$LOG_DIR" "$PID_DIR"

# Allow second run to relaunch cleanly.
if [ -d "$PID_DIR" ] && ls "$PID_DIR"/*.pid >/dev/null 2>&1; then
  warn "found a previous demo session — stopping it first"
  stop_pids
fi

# Pick non-conflicting ports.
DEMO_PORT="$(free_port "$DEMO_PORT")"
STOREFRONT_PORT="$(free_port "$STOREFRONT_PORT")"
SUPPLIER_PORT="$(free_port "$SUPPLIER_PORT")"
ENGINE_PORT="$(free_port "$ENGINE_PORT")"
info "ports: demo=$DEMO_PORT storefront=$STOREFRONT_PORT supplier=$SUPPLIER_PORT engine=$ENGINE_PORT"

# ─── engine (optional) ───────────────────────────────────────────────────────
if [ "$RUN_ENGINE" = "1" ]; then
  say "Stage 1 — engine (FastAPI)"
  ( cd "$ROOT/engine" && uv sync --quiet 2>/dev/null ) || warn "uv sync had issues; continuing"
  start_bg engine bash -c "cd '$ROOT/engine' && exec uv run uvicorn app.main:app --host 127.0.0.1 --port $ENGINE_PORT"
  wait_health "http://127.0.0.1:$ENGINE_PORT/healthz" engine 40 || warn "engine not healthy — preview will fail"
else
  say "Stage 1 — engine SKIPPED (--no-engine or uv missing)"
fi

# ─── supplier ────────────────────────────────────────────────────────────────
say "Stage 2 — supplier (x402 research-seller)"
ENGINE_URL_VAR="http://127.0.0.1:$ENGINE_PORT"
start_bg supplier env ENGINE_URL="$ENGINE_URL_VAR" SUPPLIER_PORT="$SUPPLIER_PORT" \
  bash -c "cd '$ROOT' && npm run --silent supplier"
wait_health "http://127.0.0.1:$SUPPLIER_PORT/healthz" supplier 25 || warn "supplier not healthy"

# ─── storefront ──────────────────────────────────────────────────────────────
say "Stage 3 — storefront (x402 customer API)"
SUPPLIER_URL_VAR="http://127.0.0.1:$SUPPLIER_PORT"
start_bg storefront env SUPPLIER_URL="$SUPPLIER_URL_VAR" STOREFRONT_PORT="$STOREFRONT_PORT" \
  ENGINE_URL="$ENGINE_URL_VAR" \
  bash -c "cd '$ROOT' && npm run --silent storefront"
wait_health "http://127.0.0.1:$STOREFRONT_PORT/healthz" storefront 25 || warn "storefront not healthy"

# ─── demo console ────────────────────────────────────────────────────────────
say "Stage 4 — demo console"
start_bg demo-server env \
  DEMO_PORT="$DEMO_PORT" \
  STOREFRONT_URL="http://127.0.0.1:$STOREFRONT_PORT" \
  ENGINE_URL="$ENGINE_URL_VAR" \
  SUPPLIER_URL="$SUPPLIER_URL_VAR" \
  LOG_DIR="$LOG_DIR" \
  node "$ROOT/scripts/demo-server.mjs"
wait_health "http://127.0.0.1:$DEMO_PORT/api/config" demo-server 10 || warn "demo-server not healthy"

URL="http://127.0.0.1:$DEMO_PORT/"
say "Demo ready"
ok "open:  $URL"
info "logs:  $LOG_DIR/{engine,supplier,storefront,demo-server}.log"
info "stop:  ./demo.sh --stop"

if [ "$OPEN_BROWSER" = "1" ]; then
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 &
  fi
fi

printf '\nServices are running in the background. Run \033[1m./demo.sh --stop\033[0m to shut them down.\n'
