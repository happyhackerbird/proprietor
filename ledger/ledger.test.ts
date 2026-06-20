import { describe, it, expect } from "vitest";
import { Ledger, type OrderRow, type PaymentRow, type PriceChangeRow } from "./ledger.ts";

const orderRow = (over: Partial<OrderRow> = {}): OrderRow => ({
  order_id: "ord-1",
  company: "stripe.com",
  depth: "standard",
  retail_paid_usdc: 0.03,
  wholesale_cost_usdc: 0.015,
  margin_usdc: 0.015,
  supplier_tx_hash: "0xSUPPLIER",
  settlement: "settled",
  reasoning: "test order",
  ts: Date.now(),
  ...over,
});

describe("Ledger (node:sqlite, append-only)", () => {
  it("round-trips an order receipt with its reasoning", () => {
    const l = new Ledger();
    const r = orderRow();
    l.recordOrder(r);
    const rows = l.orders();
    expect(rows).toHaveLength(1);
    expect(rows[0].order_id).toBe("ord-1");
    expect(rows[0].margin_usdc).toBe(0.015);
    expect(rows[0].supplier_tx_hash).toBe("0xSUPPLIER");
    expect(rows[0].reasoning).toBe("test order");
    l.close();
  });

  it("stores a null supplier_tx_hash (pending-batch) without coercing it", () => {
    const l = new Ledger();
    l.recordOrder(orderRow({ supplier_tx_hash: null, settlement: "pending-batch" }));
    const row = l.orders()[0];
    expect(row.supplier_tx_hash).toBeNull();
    expect(row.settlement).toBe("pending-batch");
    l.close();
  });

  it("records price changes with reasons", () => {
    const l = new Ledger();
    const pc: PriceChangeRow = {
      depth: "standard",
      old_price_usdc: 0.03,
      new_price_usdc: 0.05,
      reason: "supplier raised wholesale; raising retail",
      ts: Date.now(),
    };
    l.recordPriceChange(pc);
    const rows = l.priceChanges();
    expect(rows).toHaveLength(1);
    expect(rows[0].new_price_usdc).toBe(0.05);
    expect(rows[0].reason).toMatch(/raising retail/);
    l.close();
  });

  it("cumulativeSpentToday sums only today's payments", () => {
    const l = new Ledger();
    const now = Date.UTC(2026, 5, 20, 12, 0, 0); // 2026-06-20 noon UTC
    const yesterday = now - 24 * 3600 * 1000;
    const pay = (amount: number, ts: number): PaymentRow => ({
      order_id: "o",
      amount_usdc: amount,
      tx_hash: null,
      settlement: "pending-batch",
      gate_code: null,
      reasoning: "p",
      ts,
    });
    l.recordPayment(pay(0.01, yesterday)); // not today
    l.recordPayment(pay(0.015, now)); // today
    l.recordPayment(pay(0.02, now + 3600 * 1000)); // today, later
    expect(l.cumulativeSpentToday(now)).toBe(0.035);
    l.close();
  });

  it("denied attempts recorded with amount 0 never inflate today's spend", () => {
    const l = new Ledger();
    const now = Date.UTC(2026, 5, 20, 12, 0, 0);
    l.recordPayment({
      order_id: "o",
      amount_usdc: 0,
      tx_hash: null,
      settlement: "pending-batch",
      gate_code: "daily-cap",
      reasoning: "denied",
      ts: now,
    });
    expect(l.cumulativeSpentToday(now)).toBe(0);
    l.close();
  });

  it("summary aggregates revenue/cost/margin and reports latest retail per depth", () => {
    const l = new Ledger();
    const now = Date.UTC(2026, 5, 20, 12, 0, 0);
    l.recordOrder(orderRow({ order_id: "o1", depth: "basic", retail_paid_usdc: 0.01, wholesale_cost_usdc: 0.005, margin_usdc: 0.005, ts: now }));
    l.recordOrder(orderRow({ order_id: "o2", depth: "standard", retail_paid_usdc: 0.03, wholesale_cost_usdc: 0.015, margin_usdc: 0.015, ts: now + 1 }));
    l.recordOrder(orderRow({ order_id: "o3", depth: "standard", retail_paid_usdc: 0.05, wholesale_cost_usdc: 0.02, margin_usdc: 0.03, ts: now + 2 }));
    l.recordPayment({ order_id: "o1", amount_usdc: 0.005, tx_hash: null, settlement: "pending-batch", gate_code: null, reasoning: "p", ts: now });
    const s = l.summary(now + 10);
    expect(s.totals.order_count).toBe(3);
    expect(s.totals.revenue_usdc).toBe(0.09);
    expect(s.totals.wholesale_cost_usdc).toBe(0.04);
    expect(s.totals.margin_usdc).toBe(0.05);
    expect(s.latestRetailByDepth.standard).toBe(0.05); // newest standard wins
    expect(s.latestRetailByDepth.basic).toBe(0.01);
    l.close();
  });
});
