/**
 * fulfiller.ts (CFO) — CfoFulfiller, the budget-gated DI wrapper around the
 * storefront's SupplierFulfiller.
 *
 * CfoFulfiller implements the storefront's `Fulfiller` interface and wraps an inner
 * Fulfiller (the existing SupplierFulfiller, which does the on-chain x402 pay). It adds
 * the in-agent budget gate (cfo/gate.ts) and reasoning AROUND the existing payment — it
 * does NOT re-plumb x402/wallet logic. On a gate deny it throws GatePausedError BEFORE
 * delegating (decline-before-charge: never pay when the gate says no). On allow it
 * delegates to inner.fulfil (the single spend path) and returns the inner result
 * unchanged (preserving wholesale_usdc + supplier_tx_hash).
 *
 * The gate context (balance, cumulative-today, the config thresholds, optional approver)
 * is supplied per call via `gateCtx()` so the wrapper stays free of treasury/ledger
 * coupling — the processor wires those in.
 */
import type { Fulfiller, FulfilInput, FulfilResult } from "../storefront/fulfiller.ts";
import { evaluateGate, GatePausedError, type ApprovalRequest, type GateDecision } from "./gate.ts";

export interface GateContext {
  balanceUsdc: number;
  cumulativeTodayUsdc: number;
  dailyCapUsdc: number;
  runwayFloorUsdc: number;
  approvalThresholdUsdc: number;
  approve?: (req: ApprovalRequest) => boolean;
}

export interface CfoFulfilResult extends FulfilResult {
  /** The gate decision that authorized this fulfilment (always allow on a returned result). */
  gate: GateDecision;
}

export class CfoFulfiller implements Fulfiller {
  /**
   * @param inner   the wrapped Fulfiller (SupplierFulfiller) — the on-chain pay path
   * @param gateCtx supplies the gate inputs for the wholesale amount being spent
   */
  constructor(
    private readonly inner: Fulfiller,
    private readonly gateCtx: (amountUsdc: number, input: FulfilInput) => GateContext,
  ) {}

  /** Fulfiller contract: returns FulfilResult on allow; throws GatePausedError on deny. */
  async fulfil(input: FulfilInput): Promise<FulfilResult> {
    return this.fulfilGated(input);
  }

  /** Like fulfil but returns the gate decision alongside the result (for the processor). */
  async fulfilGated(input: FulfilInput, amountUsdcOverride?: number): Promise<CfoFulfilResult> {
    // The amount being spent is the supplier's wholesale price for the tier. Callers that
    // already inspected the price pass it; otherwise the gate context resolves it.
    const ctx = this.gateCtx(amountUsdcOverride ?? 0, input);
    const amountUsdc = amountUsdcOverride ?? 0;

    const decision = evaluateGate({
      amountUsdc,
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
