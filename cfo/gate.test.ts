import { describe, it, expect, vi } from "vitest";
import { evaluateGate, GatePausedError, type GateInput } from "./gate.ts";

const base: GateInput = {
  amountUsdc: 0.015,
  balanceUsdc: 1.0,
  cumulativeTodayUsdc: 0,
  dailyCapUsdc: 1.0,
  runwayFloorUsdc: 0.1,
  approvalThresholdUsdc: 0.5,
};

describe("evaluateGate", () => {
  it("allows a normal small spend within cap and runway", () => {
    const d = evaluateGate(base);
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.reason).toMatch(/within budget/);
  });

  it("denies with daily-cap when cumulative + amount exceeds the cap, pausing the tier", () => {
    const d = evaluateGate({ ...base, cumulativeTodayUsdc: 0.99, amountUsdc: 0.02, dailyCapUsdc: 1.0 });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.code).toBe("daily-cap");
      expect(d.reason).toMatch(/daily cap reached/);
      expect(d.reason).toMatch(/pausing this tier/);
    }
  });

  it("denies with runway-floor when balance - amount would fall below the floor", () => {
    const d = evaluateGate({ ...base, balanceUsdc: 0.11, amountUsdc: 0.05, runwayFloorUsdc: 0.1 });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.code).toBe("runway-floor");
      expect(d.reason).toMatch(/runway floor breached/);
    }
  });

  it("takes the human-prompt path when amount >= approval threshold and denies fail-closed without an approver", () => {
    const d = evaluateGate({ ...base, amountUsdc: 0.6, approvalThresholdUsdc: 0.5 });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.code).toBe("approval-denied");
      expect(d.reason).toMatch(/human approval required/);
    }
  });

  it("allows when amount >= threshold and the approver approves", () => {
    const approve = vi.fn(() => true);
    const d = evaluateGate({ ...base, amountUsdc: 0.6, approvalThresholdUsdc: 0.5, approve });
    expect(approve).toHaveBeenCalledOnce();
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.reason).toMatch(/approved by human/);
  });

  it("denies when amount >= threshold and the approver rejects", () => {
    const approve = vi.fn(() => false);
    const d = evaluateGate({ ...base, amountUsdc: 0.6, approvalThresholdUsdc: 0.5, approve });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("approval-denied");
  });

  it("checks cap before runway before approval (first failing wins)", () => {
    // Over cap AND below runway AND over threshold → daily-cap reported first.
    const d = evaluateGate({
      ...base,
      cumulativeTodayUsdc: 1.0,
      balanceUsdc: 0.05,
      amountUsdc: 0.6,
      dailyCapUsdc: 1.0,
      runwayFloorUsdc: 0.1,
      approvalThresholdUsdc: 0.5,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("daily-cap");
  });
});

describe("GatePausedError", () => {
  it("carries the deny code and reason", () => {
    const e = new GatePausedError("runway-floor", "balance too low");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("runway-floor");
    expect(e.gateReason).toBe("balance too low");
    expect(e.message).toMatch(/spend paused \(runway-floor\)/);
  });
});
