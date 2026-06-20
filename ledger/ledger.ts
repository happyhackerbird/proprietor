/**
 * ledger.ts — the CFO's append-only spend ledger (spec §D).
 *
 * Backed by node:sqlite (Node ≥ 22 built-in — no native dependency, offline-testable
 * with a ":memory:" DB). Three tables — `orders` (per-order receipts/P&L),
 * `price_changes` (repricing history), `payments` (outbound USDC) — each row carries
 * `reasoning`. Writes are INSERT-only (append-only — no UPDATE/DELETE), which is the
 * "what it paid for and why" audit surface Circle asks for.
 *
 * `cumulativeSpentToday` sums payments since the start of the current UTC day; the gate
 * (cfo/gate.ts) reads it to enforce DAILY_CAP_USDC.
 */
import { DatabaseSync } from "node:sqlite";
import type { Depth } from "../lib/env.ts";

export type Settlement = "settled" | "pending-batch";

/** A per-order receipt row (the CFO's receipt shape — spec §A.5). */
export interface OrderRow {
  order_id: string;
  company: string;
  depth: Depth;
  retail_paid_usdc: number;
  wholesale_cost_usdc: number;
  margin_usdc: number;
  supplier_tx_hash: string | null;
  settlement: Settlement;
  reasoning: string;
  ts: number;
}

/** A retail price change row. */
export interface PriceChangeRow {
  depth: Depth;
  old_price_usdc: number;
  new_price_usdc: number;
  reason: string;
  ts: number;
}

/** An outbound payment row (the agentic spend; gate_code set only on a deny). */
export interface PaymentRow {
  order_id: string;
  amount_usdc: number;
  tx_hash: string | null;
  settlement: Settlement;
  gate_code: string | null;
  reasoning: string;
  ts: number;
}

export interface LedgerSummary {
  orders: OrderRow[];
  priceChanges: PriceChangeRow[];
  totals: {
    revenue_usdc: number;
    wholesale_cost_usdc: number;
    margin_usdc: number;
    today_spent_usdc: number;
    order_count: number;
  };
  /** Latest retail price seen per depth (from order rows), newest wins. */
  latestRetailByDepth: Partial<Record<Depth, number>>;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Start-of-UTC-day epoch ms for the day containing `now`. */
function startOfUtcDay(now: number): number {
  return Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
}

export class Ledger {
  private readonly db: DatabaseSync;

  constructor(path: string = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        order_id            TEXT NOT NULL,
        company             TEXT NOT NULL,
        depth               TEXT NOT NULL,
        retail_paid_usdc    REAL NOT NULL,
        wholesale_cost_usdc REAL NOT NULL,
        margin_usdc         REAL NOT NULL,
        supplier_tx_hash    TEXT,
        settlement          TEXT NOT NULL,
        reasoning           TEXT NOT NULL,
        ts                  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS price_changes (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        depth          TEXT NOT NULL,
        old_price_usdc REAL NOT NULL,
        new_price_usdc REAL NOT NULL,
        reason         TEXT NOT NULL,
        ts             INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payments (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id    TEXT NOT NULL,
        amount_usdc REAL NOT NULL,
        tx_hash     TEXT,
        settlement  TEXT NOT NULL,
        gate_code   TEXT,
        reasoning   TEXT NOT NULL,
        ts          INTEGER NOT NULL
      );
    `);
  }

  recordOrder(r: OrderRow): void {
    this.db
      .prepare(
        `INSERT INTO orders
          (order_id, company, depth, retail_paid_usdc, wholesale_cost_usdc, margin_usdc, supplier_tx_hash, settlement, reasoning, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.order_id,
        r.company,
        r.depth,
        r.retail_paid_usdc,
        r.wholesale_cost_usdc,
        r.margin_usdc,
        r.supplier_tx_hash,
        r.settlement,
        r.reasoning,
        r.ts,
      );
  }

  recordPriceChange(r: PriceChangeRow): void {
    this.db
      .prepare(
        `INSERT INTO price_changes (depth, old_price_usdc, new_price_usdc, reason, ts) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(r.depth, r.old_price_usdc, r.new_price_usdc, r.reason, r.ts);
  }

  recordPayment(r: PaymentRow): void {
    this.db
      .prepare(
        `INSERT INTO payments (order_id, amount_usdc, tx_hash, settlement, gate_code, reasoning, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.order_id, r.amount_usdc, r.tx_hash, r.settlement, r.gate_code, r.reasoning, r.ts);
  }

  /**
   * Sum of payment amounts since the start of the current UTC day. Only allowed
   * spend (paid) should be recorded with a real amount; a denied attempt may also be
   * recorded for the audit trail but with amount 0 so it never inflates today's spend.
   */
  cumulativeSpentToday(now: number = Date.now()): number {
    const since = startOfUtcDay(now);
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(amount_usdc), 0) AS s FROM payments WHERE ts >= ?`)
      .get(since) as { s: number };
    return round6(row.s ?? 0);
  }

  orders(): OrderRow[] {
    return this.db
      .prepare(`SELECT * FROM orders ORDER BY ts ASC`)
      .all() as unknown as OrderRow[];
  }

  priceChanges(): PriceChangeRow[] {
    return this.db
      .prepare(`SELECT depth, old_price_usdc, new_price_usdc, reason, ts FROM price_changes ORDER BY ts ASC, id ASC`)
      .all() as unknown as PriceChangeRow[];
  }

  payments(): PaymentRow[] {
    return this.db
      .prepare(`SELECT order_id, amount_usdc, tx_hash, settlement, gate_code, reasoning, ts FROM payments ORDER BY ts ASC, id ASC`)
      .all() as unknown as PaymentRow[];
  }

  summary(now: number = Date.now()): LedgerSummary {
    const orders = this.orders();
    const priceChanges = this.priceChanges();
    const totals = orders.reduce(
      (acc, o) => {
        acc.revenue_usdc = round6(acc.revenue_usdc + o.retail_paid_usdc);
        acc.wholesale_cost_usdc = round6(acc.wholesale_cost_usdc + o.wholesale_cost_usdc);
        acc.margin_usdc = round6(acc.margin_usdc + o.margin_usdc);
        return acc;
      },
      { revenue_usdc: 0, wholesale_cost_usdc: 0, margin_usdc: 0, today_spent_usdc: 0, order_count: orders.length },
    );
    totals.today_spent_usdc = this.cumulativeSpentToday(now);

    const latestRetailByDepth: Partial<Record<Depth, number>> = {};
    for (const o of orders) latestRetailByDepth[o.depth] = o.retail_paid_usdc; // ASC → last wins

    return { orders, priceChanges, totals, latestRetailByDepth };
  }

  close(): void {
    this.db.close();
  }
}
