/**
 * processor.ts (CFO) — the deterministic per-order executor (the agentic payment loop's
 * core, spec §A).
 *
 * Per order { order_id, company, depth, retail_paid_usdc } it:
 *   1. circle_get_balance(treasury)   → runway (USDC)
 *   2. circle_inspect_service(SUPPLIER_URL) → current wholesale price for `depth`
 *   3. evaluate the budget/approval/runway gate (cfo/gate.ts) against the wholesale amount
 *      using ledger.cumulativeSpentToday() — on deny, record a payments row (amount 0, with
 *      gate_code + reasoning) and throw GatePausedError (decline-before-charge: never pay)
 *   4. on allow → CfoFulfiller.fulfilGated(...) pays the supplier (the ONE spend path,
 *      x402 via the reused treasury); the gate is re-checked there as the authorization seam
 *   5. build the Receipt — margin = retail_paid − wholesale_cost; supplier_tx_hash guarded
 *      → settlement "pending-batch" when null/undefined; reasoning narrates the decision
 *   6. record orders + payments rows; return { receipt }
 *
 * The treasury/balance/inspect parsing tolerates Circle CLI JSON shapes and surfaces (never
 * silently substitutes) when the wholesale price cannot be read from inspect.
 */
import { env, parseUsd, type Depth } from "../lib/env.ts";
import { Treasury } from "../money/treasury.ts";
import type { Fulfiller, FulfilResult } from "../storefront/fulfiller.ts";
import { CfoFulfiller, type GateContext } from "./fulfiller.ts";
import { GatePausedError, type ApprovalRequest } from "./gate.ts";
import { Ledger, type OrderRow, type Settlement } from "../ledger/ledger.ts";
import type { CfoConfig } from "./config.ts";

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export interface Order {
  order_id: string;
  company: string;
  depth: Depth;
  retail_paid_usdc: number;
}

/** The CFO receipt (spec §A.5) — a sibling of the storefront receipt, CFO-scoped. */
export interface Receipt {
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

export interface CfoProcessorDeps {
  treasury: Treasury;
  /**
   * The INNER fulfiller (SupplierFulfiller) — the on-chain x402 pay path. The processor
   * wraps it per order in a CfoFulfiller carrying that order's gate context, so the budget
   * gate authorizes the single spend path. (The same CfoFulfiller is what the storefront
   * injects on its own side.)
   */
  innerFulfiller: Fulfiller;
  ledger: Ledger;
  config: CfoConfig;
  treasuryAddress?: string;
  supplierUrl?: string;
  /** Human approval channel for amount ≥ APPROVAL_THRESHOLD_USDC. Default: deny (fail-closed). */
  approve?: (req: ApprovalRequest) => boolean;
  now?: () => number;
}

/** Best-effort parse of a USDC balance from the Circle balance JSON (various shapes). */
export function parseBalanceUsdc(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return parseUsd(raw);
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    // Common shapes: { usdc: "1.23" } | { balance: 1.23 } | { amount: "1.23" } | { balances: [{ amount }] }
    for (const k of ["usdc", "balance", "amount", "available"]) {
      const v = o[k];
      if (typeof v === "number") return v;
      if (typeof v === "string") return parseUsd(v);
    }
    if (Array.isArray(o.balances) && o.balances.length > 0) {
      return parseBalanceUsdc(o.balances[0]);
    }
  }
  return NaN;
}

/** Parse the wholesale price for `depth` from the Circle inspect JSON; NaN if absent. */
export function parseWholesaleUsdc(raw: unknown, depth: Depth): number {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    // Shapes: { price: "$0.015" } | { prices: { standard: "$0.015" } } | { accepts: [{ price }] }
    const prices = o.prices as Record<string, unknown> | undefined;
    if (prices && (typeof prices[depth] === "string" || typeof prices[depth] === "number")) {
      return parseUsd(String(prices[depth]));
    }
    for (const k of ["price", "maxAmountRequired", "amount"]) {
      const v = o[k];
      if (typeof v === "number") return v;
      if (typeof v === "string") return parseUsd(v);
      // x402 inspect shape: { price: { amount: "5000", formatted: "$0.005 USDC" } } —
      // `amount` is atomic USDC (6 decimals). Falls through if no numeric amount.
      if (v && typeof v === "object") {
        const amt = (v as Record<string, unknown>).amount;
        if (typeof amt === "string" || typeof amt === "number") {
          const n = Number(amt) / 1e6;
          if (Number.isFinite(n)) return n;
        }
      }
    }
    if (Array.isArray(o.accepts) && o.accepts.length > 0) {
      return parseWholesaleUsdc(o.accepts[0], depth);
    }
  }
  return NaN;
}

export class CfoProcessor {
  private readonly treasury: Treasury;
  private readonly innerFulfiller: Fulfiller;
  private readonly ledger: Ledger;
  private readonly config: CfoConfig;
  private readonly treasuryAddress: string;
  private readonly supplierUrl: string;
  private readonly approve?: (req: ApprovalRequest) => boolean;
  private readonly now: () => number;

  constructor(deps: CfoProcessorDeps) {
    this.treasury = deps.treasury;
    this.innerFulfiller = deps.innerFulfiller;
    this.ledger = deps.ledger;
    this.config = deps.config;
    this.treasuryAddress = deps.treasuryAddress ?? env.treasuryAddress();
    this.supplierUrl = deps.supplierUrl ?? env.supplierUrl();
    this.approve = deps.approve;
    this.now = deps.now ?? (() => Date.now());
  }

  async processOrder(order: Order): Promise<{ receipt: Receipt }> {
    // 1. Runway.
    const balanceRaw = await this.treasury.getBalance(this.treasuryAddress);
    const balanceUsdc = parseBalanceUsdc(balanceRaw);

    // 2. Wholesale price for this tier (inspect; surface, don't silently substitute).
    const inspectRaw = await this.treasury.inspectService(
      `${this.supplierUrl}/research/${order.depth}`,
      { method: "POST", data: { company: order.company } },
    );
    let wholesaleUsdc = parseWholesaleUsdc(inspectRaw, order.depth);
    let priceSource = "inspect";
    if (!Number.isFinite(wholesaleUsdc)) {
      // Inspect omitted a readable price — fall back to the published wholesale, RECORDED
      // in the reasoning (never silently treated as authoritative).
      wholesaleUsdc = parseUsd(env.wholesalePrice(order.depth));
      priceSource = "published-fallback";
    }
    wholesaleUsdc = round6(wholesaleUsdc);

    // 3+4. Gate + pay through the single CfoFulfiller spend path. The wrapper gates ON the
    // interface seam: its gate context carries amountUsdc = this order's wholesale, so
    // evaluateGate runs against the real spend before delegating to the inner
    // SupplierFulfiller (the on-chain pay) only on allow (decline-before-charge).
    const gateCtx = (): GateContext => ({
      amountUsdc: wholesaleUsdc,
      balanceUsdc,
      cumulativeTodayUsdc: this.ledger.cumulativeSpentToday(this.now()),
      dailyCapUsdc: this.config.dailyCapUsdc,
      runwayFloorUsdc: this.config.runwayFloorUsdc,
      approvalThresholdUsdc: this.config.approvalThresholdUsdc,
      approve: this.approve,
    });
    const gatedFulfiller = new CfoFulfiller(this.innerFulfiller, () => gateCtx());

    let fulfilment: FulfilResult;
    try {
      fulfilment = await gatedFulfiller.fulfilGated({ company: order.company, depth: order.depth });
    } catch (err) {
      if (err instanceof GatePausedError) {
        // Decline-before-charge: record the denied attempt (amount 0 so it never inflates
        // today's spend) with its gate_code + reasoning, then surface.
        const ts = this.now();
        this.ledger.recordPayment({
          order_id: order.order_id,
          amount_usdc: 0,
          tx_hash: null,
          settlement: "pending-batch",
          gate_code: err.code,
          reasoning:
            `order ${order.order_id} (${order.company}/${order.depth}): wholesale $${wholesaleUsdc} ` +
            `(${priceSource}); ${err.gateReason}`,
          ts,
        });
      }
      throw err;
    }

    // 5. Receipt.
    const ts = this.now();
    const retail = round6(order.retail_paid_usdc);
    const wholesale = round6(fulfilment.wholesale_usdc);
    const margin = round6(retail - wholesale);
    const supplierTx = fulfilment.supplier_tx_hash ?? null;
    const settlement: Settlement = supplierTx ? "settled" : "pending-batch";

    const reasoning =
      `order ${order.order_id} (${order.company}/${order.depth}): runway $${Number.isFinite(balanceUsdc) ? balanceUsdc : "n/a"}; ` +
      `wholesale $${wholesale} (${priceSource}); retail $${retail} − wholesale $${wholesale} = margin $${margin}; ` +
      `paid supplier (tx=${supplierTx ?? "pending-batch"}); cache_hit=${fulfilment.cache_hit}`;

    const receipt: Receipt = {
      order_id: order.order_id,
      company: order.company,
      depth: order.depth,
      retail_paid_usdc: retail,
      wholesale_cost_usdc: wholesale,
      margin_usdc: margin,
      supplier_tx_hash: supplierTx,
      settlement,
      reasoning,
      ts,
    };

    // 6. Ledger: orders + payments.
    const orderRow: OrderRow = { ...receipt };
    this.ledger.recordOrder(orderRow);
    this.ledger.recordPayment({
      order_id: order.order_id,
      amount_usdc: wholesale,
      tx_hash: supplierTx,
      settlement,
      gate_code: null,
      reasoning: `paid supplier $${wholesale} for ${order.company}/${order.depth} (tx=${supplierTx ?? "pending-batch"})`,
      ts,
    });

    return { receipt };
  }
}
