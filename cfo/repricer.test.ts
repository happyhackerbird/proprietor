import { describe, it, expect } from "vitest";
import { reprice, CfoPricingProvider, toPriceChangeRow, type RepriceInput } from "./repricer.ts";
import type { Depth } from "../lib/env.ts";

const floorCeiling = (floor: number, ceiling: number) => ({
  priceFloor: (_d: Depth) => floor,
  priceCeiling: (_d: Depth) => ceiling,
});

describe("reprice", () => {
  it("RAISES retail by a step (bounded by ceiling) when margin < target, with a logged reason", () => {
    // standard: retail 0.03, wholesale 0.025 → margin = 0.005/0.03 ≈ 17% < 40% target.
    const input: RepriceInput = {
      perDepth: { standard: { retail: 0.03, wholesale: 0.025 } },
      targetMargin: 0.4,
      priceStep: 0.02,
      ...floorCeiling(0.005, 0.2),
    };
    const changes = reprice(input);
    expect(changes).toHaveLength(1);
    expect(changes[0].depth).toBe("standard");
    expect(changes[0].old_price_usdc).toBe(0.03);
    expect(changes[0].new_price_usdc).toBe(0.05); // 0.03 + 0.02, under ceiling
    expect(changes[0].reason).toMatch(/margin fell to 17% < 40% target/);
    expect(changes[0].reason).toMatch(/raising retail \$0.03→\$0.05/);
  });

  it("caps a raise at the ceiling", () => {
    const input: RepriceInput = {
      perDepth: { basic: { retail: 0.19, wholesale: 0.18 } }, // margin ~5% < target
      targetMargin: 0.4,
      priceStep: 0.05,
      ...floorCeiling(0.005, 0.2),
    };
    const changes = reprice(input);
    expect(changes[0].new_price_usdc).toBe(0.2); // capped at ceiling, not 0.24
  });

  it("LOWERS retail by a step (bounded by floor) when margin comfortably above target, to drive volume", () => {
    // standard: retail 0.10, wholesale 0.01 → margin 90% ≫ 40% target + headroom.
    const input: RepriceInput = {
      perDepth: { standard: { retail: 0.1, wholesale: 0.01 } },
      targetMargin: 0.4,
      priceStep: 0.01,
      ...floorCeiling(0.02, 0.2),
    };
    const changes = reprice(input);
    expect(changes).toHaveLength(1);
    expect(changes[0].new_price_usdc).toBe(0.09);
    expect(changes[0].reason).toMatch(/comfortably above/);
    expect(changes[0].reason).toMatch(/lowering retail/);
  });

  it("caps a lower at the floor", () => {
    const input: RepriceInput = {
      perDepth: { basic: { retail: 0.025, wholesale: 0.001 } }, // huge margin
      targetMargin: 0.4,
      priceStep: 0.05,
      ...floorCeiling(0.02, 0.2),
    };
    const changes = reprice(input);
    expect(changes[0].new_price_usdc).toBe(0.02); // floored, not negative
  });

  it("makes NO change when margin is within the band around target", () => {
    // retail 0.05, wholesale 0.03 → margin 40% == target, no headroom for a lower.
    const input: RepriceInput = {
      perDepth: { standard: { retail: 0.05, wholesale: 0.03 } },
      targetMargin: 0.4,
      priceStep: 0.01,
      ...floorCeiling(0.005, 0.2),
    };
    expect(reprice(input)).toHaveLength(0);
  });

  it("throws on a floor > ceiling misconfiguration", () => {
    const input: RepriceInput = {
      perDepth: { standard: { retail: 0.03, wholesale: 0.025 } },
      targetMargin: 0.4,
      priceStep: 0.01,
      priceFloor: () => 0.3,
      priceCeiling: () => 0.1,
    };
    expect(() => reprice(input)).toThrow(/PRICE_FLOOR.*> PRICE_CEILING/);
  });
});

describe("CfoPricingProvider", () => {
  it("implements PricingProvider over a live retail table and applies changes in place", () => {
    const p = new CfoPricingProvider({ basic: 0.01, standard: 0.03, comprehensive: 0.08 });
    expect(p.priceFor("standard")).toEqual({ price_usdc: "$0.03", available: true });
    expect(p.priceTable()).toEqual({ basic: "$0.01", standard: "$0.03", comprehensive: "$0.08" });

    p.applyChange({ depth: "standard", old_price_usdc: 0.03, new_price_usdc: 0.05, reason: "r" });
    expect(p.retailFor("standard")).toBe(0.05);
    expect(p.priceFor("standard").price_usdc).toBe("$0.05");
  });

  it("declines unavailable depths (decline-before-charge)", () => {
    const p = new CfoPricingProvider({ basic: 0.01, standard: 0.03, comprehensive: 0.08 }, new Set<Depth>(["comprehensive"]));
    expect(p.priceFor("comprehensive").available).toBe(false);
    expect(p.priceFor("standard").available).toBe(true);
  });

  it("seeds from env price strings", () => {
    const p = CfoPricingProvider.fromStrings({ basic: "$0.01", standard: "$0.03", comprehensive: "$0.08" });
    expect(p.retailFor("basic")).toBe(0.01);
  });
});

describe("toPriceChangeRow", () => {
  it("maps a PriceChange to a ledger row", () => {
    const row = toPriceChangeRow({ depth: "standard", old_price_usdc: 0.03, new_price_usdc: 0.05, reason: "r" }, 123);
    expect(row).toEqual({ depth: "standard", old_price_usdc: 0.03, new_price_usdc: 0.05, reason: "r", ts: 123 });
  });
});
