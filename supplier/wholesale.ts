/**
 * wholesale.ts — fixed wholesale price per depth (the supplier's published
 * prices). Read from WHOLESALE_BASIC/STANDARD/COMPREHENSIVE (fail-loud).
 * The supplier absorbs within-tier difficulty variance — price is fixed by tier.
 */
import { DEPTHS, env, type Depth } from "../lib/env.ts";

export function wholesalePrice(depth: Depth): string {
  return env.wholesalePrice(depth);
}

export function wholesaleTable(): Record<Depth, string> {
  return Object.fromEntries(DEPTHS.map((d) => [d, env.wholesalePrice(d)])) as Record<Depth, string>;
}
