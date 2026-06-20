/**
 * cfo-demo.ts — show the CFO's decision loop end-to-end without the LLM subprocess.
 *
 * Runs the deterministic CfoProcessor (the exact runway → inspect → GATE → pay → receipt
 * loop the Agent SDK drives) over three orders so every gate branch is visible:
 *   1. a normal order        → ALLOW  → pays the supplier on-chain, justified receipt
 *   2. a tiny daily cap      → DENY "daily-cap"        (budget gate, decline-before-charge)
 *   3. a low approval ceiling→ DENY "approval-denied"  (anomaly escalation, fail-closed)
 * then renders the spend-ledger read view.
 *
 *   npx tsx scripts/cfo-demo.ts        (needs engine + supplier running; CFO pays from TREASURY)
 */
import { CfoProcessor, parseBalanceUsdc, type Order } from "../cfo/processor.ts";
import { reprice } from "../cfo/repricer.ts";
import { GatePausedError } from "../cfo/gate.ts";
import { resolveConfig, type CfoConfig } from "../cfo/config.ts";
import { renderReadView } from "../cfo/read-view.ts";
import { Treasury } from "../money/treasury.ts";
import { Ledger } from "../ledger/ledger.ts";
import { SupplierFulfiller } from "../storefront/fulfiller.ts";
import { env } from "../lib/env.ts";

const treasury = new Treasury();
const ledger = new Ledger(process.env.CFO_LEDGER_PATH ?? "data/cfo-demo.db");
const inner = new SupplierFulfiller(treasury);
const base = resolveConfig();

// Preflight: the CFO inspects & pays the supplier (which calls the engine).
const supplierUrl = env.supplierUrl();
const reachable = await fetch(`${supplierUrl}/healthz`).then((r) => r.ok).catch(() => false);
if (!reachable) {
  console.error(`[cfo:demo] supplier not reachable at ${supplierUrl}. Start the engine + supplier first:`);
  console.error("  (A)  cd engine && uv run uvicorn app.main:app --port 8000");
  console.error("  (B)  ENGINE_URL=http://127.0.0.1:8000 npm run supplier");
  process.exit(1);
}

async function run(label: string, order: Order, config: CfoConfig, approve?: () => boolean) {
  console.log(`\n\x1b[1;36m▶ ${label}\x1b[0m  ${order.company}/${order.depth} retail $${order.retail_paid_usdc}`);
  const proc = new CfoProcessor({ treasury, innerFulfiller: inner, ledger, config, approve });
  try {
    const { receipt } = await proc.processOrder(order);
    console.log(`  \x1b[1;32mALLOW → paid\x1b[0m  margin $${receipt.margin_usdc}  settlement=${receipt.settlement}`);
    console.log(`  reasoning: ${receipt.reasoning}`);
  } catch (err) {
    if (err instanceof GatePausedError) {
      console.log(`  \x1b[1;33mDENY (${err.code})\x1b[0m — decline-before-charge`);
      console.log(`  reasoning: ${err.gateReason}`);
    } else {
      console.log(`  \x1b[1;31mERROR\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// 1. normal order — gate allows, pays the supplier on-chain
await run("Order 1 — normal", { order_id: "demo-1", company: "stripe.com", depth: "standard", retail_paid_usdc: 0.03 }, base);

// 2. same order under a tiny daily cap — budget gate denies
await run("Order 2 — daily cap hit", { order_id: "demo-2", company: "openai.com", depth: "standard", retail_paid_usdc: 0.03 },
  { ...base, dailyCapUsdc: 0.02 });

// 3. comprehensive order under a low approval ceiling, no approver — escalation denies (fail-closed)
await run("Order 3 — approval required", { order_id: "demo-3", company: "anthropic.com", depth: "comprehensive", retail_paid_usdc: 0.08 },
  { ...base, approvalThresholdUsdc: 0.01 });

// ledger read view — the "what it paid for and why" surface
let balance: number | null = null;
try { balance = parseBalanceUsdc(await treasury.getBalance(env.treasuryAddress())); } catch { balance = null; }
console.log("\n" + renderReadView(ledger, balance, base));
ledger.close();

// ── repricing decisions (margin defense, spec §B) ────────────────────────────
console.log(`\n\x1b[1;36m▶ Repricing decisions (target margin ${Math.round(base.targetMargin * 100)}%)\x1b[0m`);
const changes = reprice({
  // standard: supplier raised wholesale $0.015→$0.025 (margin compressed) → expect RAISE
  // comprehensive: fat margin → expect LOWER to drive volume; basic: within band → no change
  perDepth: {
    basic: { retail: 0.01, wholesale: 0.005 },
    standard: { retail: 0.03, wholesale: 0.025 },
    comprehensive: { retail: 0.08, wholesale: 0.04 },
  },
  targetMargin: base.targetMargin,
  priceStep: base.priceStep,
  priceFloor: () => 0.01,
  priceCeiling: () => 0.1,
});
if (changes.length === 0) console.log("  (no changes — all tiers within the target band)");
for (const c of changes) console.log(`  \x1b[1;35m${c.depth}: $${c.old_price_usdc}→$${c.new_price_usdc}\x1b[0m — ${c.reason}`);
