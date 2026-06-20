/**
 * fulfiller.ts (CFO) — CfoFulfiller, the budget-gated DI wrapper around the
 * storefront's SupplierFulfiller.
 *
 * CfoFulfiller implements the storefront's `Fulfiller` interface and wraps an inner
 * Fulfiller (the existing SupplierFulfiller, which does the on-chain x402 pay). It adds
 * the in-agent budget gate (cfo/gate.ts) and reasoning AROUND the existing payment — it
 * does NOT re-plumb x402/wallet logic.
 *
 * The gate runs ON the `Fulfiller.fulfil` interface seam itself: `fulfil(input)` resolves
 * this order's gate context (which CARRIES the spend amount = the supplier's wholesale for
 * the tier) and runs evaluateGate against that amount BEFORE delegating. On deny it throws
 * GatePausedError without calling inner (decline-before-charge: never pay when the gate
 * says no). On allow it delegates to inner.fulfil (the single spend path) and returns the
 * inner result unchanged (preserving wholesale_usdc + supplier_tx_hash).
 *
 * Because the amount is part of the gate context, the bare interface method is the gated
 * seam — there is no ungated path. Anything that wires CfoFulfiller in as a `Fulfiller`
 * (e.g. the storefront via DI) gets the budget gate, not a fail-open.
 */
import type { Fulfiller, FulfilInput, FulfilResult } from "../storefront/fulfiller.ts";
import { evaluateGate, GatePausedError, type ApprovalRequest, type GateDecision } from "./gate.ts";

export interface GateContext {
  /** The USDC amount this fulfilment will spend (the supplier's wholesale for the tier). */
  amountUsdc: number;
  balanceUsdc: number;
  cumulativeTodayUsdc: number;
  dailyCapUsdc: number;
  runwayFloorUsdc: number;
  approvalThresholdUsdc: number;
  /** Human approval channel for amount >= threshold. Default: deny (fail-closed). */
  approve?: (req: ApprovalRequest) => boolean;
}

export interface CfoFulfilResult extends FulfilResult {
  /** The gate decision that authorized this fulfilment (always allow on a returned result). */
  gate: GateDecision;
}

export class CfoFulfiller implements Fulfiller {
  /**
   * @param inner   the wrapped Fulfiller (SupplierFulfiller) — the on-chain pay path
   * @param gateCtx resolves the gate inputs (incl. the spend amount) for this order
   */
  constructor(
    private readonly inner: Fulfiller,
    private readonly gateCtx: (input: FulfilInput) => GateContext,
  ) {}

  /**
   * Fulfiller contract: gates against the order's wholesale amount (from gateCtx), then
   * delegates to the inner pay path on allow. Throws GatePausedError on deny (never pays).
   */
  async fulfil(input: FulfilInput): Promise<FulfilResult> {
    return this.fulfilGated(input);
  }

  /** Like fulfil but also returns the gate decision (used by the processor for narration). */
  async fulfilGated(input: FulfilInput): Promise<CfoFulfilResult> {
    const ctx = this.gateCtx(input);

    const decision = evaluateGate({
      amountUsdc: ctx.amountUsdc,
      balanceUsdc: ctx.balanceUsdc,
      cumulativeTodayUsdc: ctx.cumulativeTodayUsdc,
      dailyCapUsdc: ctx.dailyCapUsdc,
      runwayFloorUsdc: ctx.runwayFloorUsdc,
      approvalThresholdUsdc: ctx.approvalThresholdUsdc,
      approve: ctx.approve,
    });

    if (!decision.allow) {
      // Decline-before-charge: never call inner.fulfil (never pay) when the gate denies.
      throw new GatePausedError(decision.code, decision.reason);
    }

    const result = await this.inner.fulfil(input);
    return { ...result, gate: decision };
  }
}
