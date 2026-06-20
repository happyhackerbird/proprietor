/**
 * read-view.ts (CFO) — the spend-ledger read view (spec §D).
 *
 * Renders a plain-text table from the append-only ledger: treasury balance, per-order
 * P&L, price-change history, and the totals line (cumulative revenue / cost / margin /
 * today's-spend-vs-cap). This is the "what it paid for and why" surface Circle asks for
 * and the demo surface. Pure string builder — no I/O beyond reading the ledger.
 */
import type { Ledger } from "../ledger/ledger.ts";
import type { CfoConfig } from "./config.ts";

function fmt(n: number): string {
  return `$${(Math.round(n * 1e6) / 1e6).toFixed(4)}`;
}

export function renderReadView(
  ledger: Ledger,
  treasuryBalanceUsdc: number | null,
  config: Pick<CfoConfig, "dailyCapUsdc">,
  now: number = Date.now(),
): string {
  const s = ledger.summary(now);
  const lines: string[] = [];

  lines.push("=== Proprietor CFO — spend ledger ===");
  lines.push(
    `treasury balance: ${treasuryBalanceUsdc == null || !Number.isFinite(treasuryBalanceUsdc) ? "n/a (offline)" : fmt(treasuryBalanceUsdc)}`,
  );
  lines.push("");

  // Per-order P&L.
  lines.push("-- orders (P&L) --");
  if (s.orders.length === 0) {
    lines.push("no orders yet");
  } else {
    lines.push("order_id              depth          retail   wholesale  margin    settlement");
    for (const o of s.orders) {
      lines.push(
        `${o.order_id.padEnd(20).slice(0, 20)}  ${o.depth.padEnd(13)}  ${fmt(o.retail_paid_usdc).padStart(7)}  ` +
          `${fmt(o.wholesale_cost_usdc).padStart(8)}  ${fmt(o.margin_usdc).padStart(7)}  ${o.settlement}`,
      );
    }
  }
  lines.push("");

  // Price history.
  lines.push("-- price changes --");
  if (s.priceChanges.length === 0) {
    lines.push("no price changes yet");
  } else {
    for (const p of s.priceChanges) {
      lines.push(`${p.depth.padEnd(13)}  ${fmt(p.old_price_usdc)} → ${fmt(p.new_price_usdc)}  — ${p.reason}`);
    }
  }
  lines.push("");

  // Totals + spend-vs-cap.
  const cap = config.dailyCapUsdc;
  lines.push("-- totals --");
  lines.push(`orders:            ${s.totals.order_count}`);
  lines.push(`revenue (retail):  ${fmt(s.totals.revenue_usdc)}`);
  lines.push(`cost (wholesale):  ${fmt(s.totals.wholesale_cost_usdc)}`);
  lines.push(`margin:            ${fmt(s.totals.margin_usdc)}`);
  lines.push(`today's spend:     ${fmt(s.totals.today_spent_usdc)} / cap ${fmt(cap)}`);

  return lines.join("\n");
}
