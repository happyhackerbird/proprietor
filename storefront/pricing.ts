/**
 * pricing.ts (D10) — the injected PricingProvider interface + a static,
 * env-backed implementation. The Phase-4 CFO will provide a dynamic impl of the
 * SAME interface; the storefront depends only on the interface.
 *
 * RETAIL prices per depth come from PRICE_BASIC/STANDARD/COMPREHENSIVE. A depth
 * can be marked unavailable → the storefront declines it before any charge.
 */
import { DEPTHS, env, type Depth } from "../lib/env.ts";

export interface PriceInfo {
  price_usdc: string; // "$0.03"
  available: boolean;
}

export interface PriceTable {
  basic: string;
  standard: string;
  comprehensive: string;
}

export interface PricingProvider {
  priceFor(depth: Depth): PriceInfo;
  priceTable(): PriceTable;
}

export class StaticPricingProvider implements PricingProvider {
  /** `unavailable` lists depths to decline before charge (e.g. supplier outage). */
  constructor(private readonly unavailable: ReadonlySet<Depth> = new Set()) {}

  priceFor(depth: Depth): PriceInfo {
    return { price_usdc: env.retailPrice(depth), available: !this.unavailable.has(depth) };
  }

  priceTable(): PriceTable {
    return {
      basic: env.retailPrice("basic"),
      standard: env.retailPrice("standard"),
      comprehensive: env.retailPrice("comprehensive"),
    };
  }
}

export { DEPTHS };
export type { Depth };
