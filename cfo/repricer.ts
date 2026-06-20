/**
 * repricer.ts (CFO) — margin-defending repricing loop + the dynamic PricingProvider
 * the storefront reads (spec §B).
 *
 * Between orders the CFO inspects the supplier's wholesale price per depth, computes the
 * realized retail margin, and adjusts retail to defend a TARGET_MARGIN:
 *   - margin < target            → RAISE retail by price_step (bounded by ceiling)
 *   - margin comfortably above   → LOWER retail by price_step (bounded by floor) to drive volume
 *   - within band                → no change
 * Every change is emitted as a PriceChange with a natural-language reason naming the
 * wholesale move, realized-vs-target margin, and the retail delta — logged to the ledger.
 *
 * `CfoPricingProvider` implements the storefront's PricingProvider so the storefront reads
 * the live retail table with zero storefront source change (DI).
 */
import { DEPTHS, parseUsd, type Depth } from "../lib/env.ts";
import type { PriceInfo, PriceTable, PricingProvider } from "../storefront/pricing.ts";
import type { CfoConfig } from "./config.ts";
import type { PriceChangeRow } from "../ledger/ledger.ts";

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** A computed retail price change (before it is applied / logged). */
export interface PriceChange {
  depth: Depth;
  old_price_usdc: number;
  new_price_usdc: number;
  reason: string;
}

export interface RepriceTier {
  retail: number;
  wholesale: number;
}

export interface RepriceInput {
  perDepth: Partial<Record<Depth, RepriceTier>>;
  targetMargin: number;
  priceStep: number;
  priceFloor: (d: Depth) => number;
  priceCeiling: (d: Depth) => number;
}

/** Realized margin as a fraction of retail. Returns 0 for a non-positive retail. */
function marginFraction(tier: RepriceTier): number {
  if (tier.retail <= 0) return 0;
  return (tier.retail - tier.wholesale) / tier.retail;
}

/**
 * Compute retail price changes to defend the target margin. Pure: returns the changes,
 * applies nothing. A depth whose configured floor > ceiling is a misconfig and throws.
 */
export function reprice(input: RepriceInput): PriceChange[] {
  const { perDepth, targetMargin, priceStep, priceFloor, priceCeiling } = input;
  const changes: PriceChange[] = [];

  for (const depth of DEPTHS) {
    const tier = perDepth[depth];
    if (!tier) continue;

    const floor = priceFloor(depth);
    const ceiling = priceCeiling(depth);
    if (floor > ceiling) {
      throw new Error(`[reprice] ${depth}: PRICE_FLOOR ($${floor}) > PRICE_CEILING ($${ceiling})`);
    }

    const margin = marginFraction(tier);
    const pct = (m: number) => `${Math.round(m * 100)}%`;

    if (margin < targetMargin) {
      // Margin compressed — raise retail a step, bounded by the ceiling.
      const raised = round6(Math.min(tier.retail + priceStep, ceiling));
      if (raised > tier.retail) {
        changes.push({
          depth,
          old_price_usdc: tier.retail,
          new_price_usdc: raised,
          reason:
            `${depth}: wholesale $${tier.wholesale}; my margin fell to ${pct(margin)} < ${pct(targetMargin)} target; ` +
            `raising retail $${tier.retail}→$${raised} (ceiling $${ceiling})`,
        });
      }
      continue;
    }

    // Comfortably above target — lower a step to drive volume, but ONLY if the lowered
    // price still clears the target margin (never undershoot target by lowering), and
    // bounded by the floor.
    const lowered = round6(Math.max(tier.retail - priceStep, floor));
    const loweredMargin = marginFraction({ retail: lowered, wholesale: tier.wholesale });
    if (lowered < tier.retail && loweredMargin >= targetMargin) {
      changes.push({
        depth,
        old_price_usdc: tier.retail,
        new_price_usdc: lowered,
        reason:
          `${depth}: wholesale $${tier.wholesale}; my margin ${pct(margin)} comfortably above ${pct(targetMargin)} target ` +
          `(stays ${pct(loweredMargin)} after); lowering retail $${tier.retail}→$${lowered} to drive volume (floor $${floor})`,
      });
    }
  }

  return changes;
}

/**
 * The dynamic pricing provider the storefront reads. Holds the live retail table
 * (seeded from initial prices), exposes the PricingProvider interface, and applies
 * PriceChanges in place. `unavailable` depths are declined-before-charge by the storefront.
 */
export class CfoPricingProvider implements PricingProvider {
  private readonly retail: Record<Depth, number>;

  constructor(
    seed: Record<Depth, number>,
    private readonly unavailable: ReadonlySet<Depth> = new Set(),
  ) {
    this.retail = { ...seed };
  }

  /** Seed from env retail price strings ("$0.03"). */
  static fromStrings(seed: Record<Depth, string>, unavailable?: ReadonlySet<Depth>): CfoPricingProvider {
    const nums = Object.fromEntries(DEPTHS.map((d) => [d, parseUsd(seed[d])])) as Record<Depth, number>;
    return new CfoPricingProvider(nums, unavailable);
  }

  priceFor(depth: Depth): PriceInfo {
    return { price_usdc: `$${this.retail[depth]}`, available: !this.unavailable.has(depth) };
  }

  priceTable(): PriceTable {
    return {
      basic: `$${this.retail.basic}`,
      standard: `$${this.retail.standard}`,
      comprehensive: `$${this.retail.comprehensive}`,
    };
  }

  /** Current numeric retail for a depth. */
  retailFor(depth: Depth): number {
    return this.retail[depth];
  }

  /** Apply a computed change in place (the caller logs it to the ledger). */
  applyChange(change: PriceChange): void {
    this.retail[change.depth] = change.new_price_usdc;
  }
}

/** Build a ledger PriceChangeRow from a computed change. */
export function toPriceChangeRow(c: PriceChange, ts: number = Date.now()): PriceChangeRow {
  return { depth: c.depth, old_price_usdc: c.old_price_usdc, new_price_usdc: c.new_price_usdc, reason: c.reason, ts };
}
