import { describe, it, expect, vi } from "vitest";
import { CfoFulfiller, type GateContext } from "./fulfiller.ts";
import { GatePausedError } from "./gate.ts";
import type { Fulfiller, FulfilInput, FulfilResult } from "../storefront/fulfiller.ts";

function inner(over: Partial<FulfilResult> = {}): Fulfiller & { fulfil: ReturnType<typeof vi.fn> } {
  const result: FulfilResult = {
    profile: { company: "x", confidence: 1, basics: {}, product: {}, funding: {}, hiring: {}, news: {} },
    cost: { tavily_searches: 1, nebius_calls: 1, nebius_tokens: 10, est_usd: 0.001 },
    cache_hit: false,
    depth_served: "standard",
    wholesale_usdc: 0.015,
    supplier_tx_hash: "0xSUP",
    ...over,
  };
  return { fulfil: vi.fn(async (_i: FulfilInput) => result) };
}

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  amountUsdc: 0.015,
  balanceUsdc: 1.0,
  cumulativeTodayUsdc: 0,
  dailyCapUsdc: 1.0,
  runwayFloorUsdc: 0.1,
  approvalThresholdUsdc: 0.5,
  ...over,
});

const input: FulfilInput = { company: "x", depth: "standard" };

describe("CfoFulfiller (gated DI wrapper around SupplierFulfiller)", () => {
  it("gates ON the Fulfiller.fulfil interface seam: on allow it delegates to inner.fulfil", async () => {
    const i = inner();
    const f = new CfoFulfiller(i, () => ctx());
    const result = await f.fulfil(input);
    expect(i.fulfil).toHaveBeenCalledWith(input);
    expect(result.supplier_tx_hash).toBe("0xSUP");
  });

  it("fulfilGated returns the gate decision alongside the result on allow", async () => {
    const i = inner();
    const f = new CfoFulfiller(i, () => ctx());
    const result = await f.fulfilGated(input);
    expect(result.wholesale_usdc).toBe(0.015);
    expect(result.gate.allow).toBe(true);
  });

  it("the bare Fulfiller.fulfil seam DENIES when the gate denies — it does NOT fail open", async () => {
    const i = inner();
    // amount 0.6 ≥ threshold 0.5 in the context, no approver → deny. The fix: fulfil() itself gates.
    const f = new CfoFulfiller(i, () => ctx({ amountUsdc: 0.6, approvalThresholdUsdc: 0.5 }));
    await expect(f.fulfil(input)).rejects.toThrowError(GatePausedError);
    expect(i.fulfil).not.toHaveBeenCalled();
  });

  it("denies via fulfilGated too, and does NOT call inner (decline-before-charge)", async () => {
    const i = inner();
    const f = new CfoFulfiller(i, () => ctx({ amountUsdc: 0.6, approvalThresholdUsdc: 0.5 }));
    await expect(f.fulfilGated(input)).rejects.toThrowError(GatePausedError);
    expect(i.fulfil).not.toHaveBeenCalled();
  });

  it("denies on daily-cap from the gate context (cap enforced on the interface seam)", async () => {
    const i = inner();
    const f = new CfoFulfiller(i, () => ctx({ amountUsdc: 0.02, cumulativeTodayUsdc: 0.99, dailyCapUsdc: 1.0 }));
    await expect(f.fulfil(input)).rejects.toThrowError(GatePausedError);
    expect(i.fulfil).not.toHaveBeenCalled();
  });

  it("propagates an inner error after allow (no blind retry)", async () => {
    const boom: Fulfiller = { fulfil: vi.fn(async () => { throw new Error("502"); }) };
    const f = new CfoFulfiller(boom, () => ctx());
    await expect(f.fulfilGated(input)).rejects.toThrow(/502/);
    expect((boom.fulfil as any)).toHaveBeenCalledOnce();
  });
});
