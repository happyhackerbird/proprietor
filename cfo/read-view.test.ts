import { describe, it, expect } from "vitest";
import { renderReadView } from "./read-view.ts";
import { Ledger } from "../ledger/ledger.ts";

const now = Date.UTC(2026, 5, 20, 12, 0, 0);

describe("renderReadView", () => {
  it("renders treasury, per-order P&L, price history, and today's-spend-vs-cap", () => {
    const l = new Ledger();
    l.recordOrder({
      order_id: "ord-1",
      company: "stripe.com",
      depth: "standard",
      retail_paid_usdc: 0.03,
      wholesale_cost_usdc: 0.015,
      margin_usdc: 0.015,
      supplier_tx_hash: "0xSUP",
      settlement: "settled",
      reasoning: "r",
      ts: now,
    });
    l.recordPayment({ order_id: "ord-1", amount_usdc: 0.015, tx_hash: "0xSUP", settlement: "settled", gate_code: null, reasoning: "p", ts: now });
    l.recordPriceChange({ depth: "standard", old_price_usdc: 0.03, new_price_usdc: 0.05, reason: "supplier raised wholesale", ts: now });

    const out = renderReadView(l, 1.2345, { dailyCapUsdc: 1.0 }, now + 10);
    expect(out).toMatch(/treasury balance: \$1.2345/);
    expect(out).toMatch(/ord-1/);
    expect(out).toMatch(/standard/);
    expect(out).toMatch(/0.03 → \$0.05|\$0.0300 → \$0.0500/);
    expect(out).toMatch(/supplier raised wholesale/);
    expect(out).toMatch(/today's spend:\s+\$0.0150 \/ cap \$1.0000/);
    expect(out).toMatch(/margin:\s+\$0.0150/);
    l.close();
  });

  it("renders 'n/a (offline)' for a null treasury balance and 'no orders yet' when empty", () => {
    const l = new Ledger();
    const out = renderReadView(l, null, { dailyCapUsdc: 1.0 }, now);
    expect(out).toMatch(/treasury balance: n\/a \(offline\)/);
    expect(out).toMatch(/no orders yet/);
    expect(out).toMatch(/no price changes yet/);
    l.close();
  });
});
