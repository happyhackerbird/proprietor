/**
 * gate.ts (CFO) — the pure budget / approval / runway gate.
 *
 * This is the SINGLE locus of outbound-spend authorization (spec §C — the testnet
 * equivalent of Circle Spending Policies). Both the deterministic processor and the
 * Agent SDK's `canUseTool` callback delegate here, so the policy is enforced once and
 * unit-tested independently of the SDK subprocess.
 *
 * Order of checks (first failing wins):
 *   1. cumulative_today + amount > daily_cap  → deny "daily-cap"   (pause tier)
 *   2. balance - amount < runway_floor         → deny "runway-floor" (pause spend)
 *   3. amount >= approval_threshold            → ask approver; false → deny "approval-denied"
 *   4. else                                    → allow
 *
 * Fail-closed: when the approval threshold is crossed and no approver is supplied,
 * the default approver DENIES (an unattended high-value spend is never auto-approved).
 */

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export interface ApprovalRequest {
  amountUsdc: number;
  approvalThresholdUsdc: number;
  reason: string;
}

export interface GateInput {
  amountUsdc: number;
  balanceUsdc: number;
  cumulativeTodayUsdc: number;
  dailyCapUsdc: number;
  runwayFloorUsdc: number;
  approvalThresholdUsdc: number;
  /** Human-in-the-loop approval channel for amount >= threshold. Default: deny (fail-closed). */
  approve?: (req: ApprovalRequest) => boolean;
}

export type GateDenyCode = "daily-cap" | "runway-floor" | "approval-denied";

export type GateDecision =
  | { allow: true; reason: string }
  | { allow: false; code: GateDenyCode; reason: string };

/** Evaluate the spend gate. Pure and total. */
export function evaluateGate(input: GateInput): GateDecision {
  const {
    amountUsdc,
    balanceUsdc,
    cumulativeTodayUsdc,
    dailyCapUsdc,
    runwayFloorUsdc,
    approvalThresholdUsdc,
    approve,
  } = input;

  const amount = round6(amountUsdc);
  const projectedToday = round6(cumulativeTodayUsdc + amount);
  const projectedBalance = round6(balanceUsdc - amount);

  // 1. Daily cap.
  if (projectedToday > dailyCapUsdc) {
    return {
      allow: false,
      code: "daily-cap",
      reason:
        `daily cap reached: spent $${round6(cumulativeTodayUsdc)} + $${amount} = $${projectedToday} ` +
        `would exceed cap $${dailyCapUsdc}; pausing this tier for today`,
    };
  }

  // 2. Runway floor.
  if (projectedBalance < runwayFloorUsdc) {
    return {
      allow: false,
      code: "runway-floor",
      reason:
        `runway floor breached: balance $${round6(balanceUsdc)} − $${amount} = $${projectedBalance} ` +
        `would fall below floor $${runwayFloorUsdc}; pausing spend to protect runway`,
    };
  }

  // 3. Approval threshold (anomaly escalation).
  if (amount >= approvalThresholdUsdc) {
    const approver = approve ?? (() => false);
    const approved = approver({
      amountUsdc: amount,
      approvalThresholdUsdc,
      reason: `amount $${amount} ≥ approval threshold $${approvalThresholdUsdc}`,
    });
    if (!approved) {
      return {
        allow: false,
        code: "approval-denied",
        reason:
          `human approval required: amount $${amount} ≥ threshold $${approvalThresholdUsdc}; ` +
          `not approved — holding spend`,
      };
    }
    return {
      allow: true,
      reason:
        `approved by human: amount $${amount} ≥ threshold $${approvalThresholdUsdc}; ` +
        `within cap ($${projectedToday}/$${dailyCapUsdc}) and runway ($${projectedBalance} ≥ $${runwayFloorUsdc})`,
    };
  }

  // 4. Allow.
  return {
    allow: true,
    reason:
      `within budget: $${amount} keeps today's spend $${projectedToday} ≤ cap $${dailyCapUsdc} ` +
      `and runway $${projectedBalance} ≥ floor $${runwayFloorUsdc}`,
  };
}

/** Raised when the gate denies an outbound payment (decline-before-charge). */
export class GatePausedError extends Error {
  constructor(
    readonly code: GateDenyCode,
    readonly gateReason: string,
  ) {
    super(`spend paused (${code}): ${gateReason}`);
    this.name = "GatePausedError";
  }
}
