/**
 * config.ts (CFO) — the CFO agent's own typed config accessor.
 *
 * Mirrors lib/env.ts's fail-loud accessor style WITHOUT editing lib/. The CFO's
 * keys (DAILY_CAP_USDC, RUNWAY_FLOOR_USDC, APPROVAL_THRESHOLD_USDC, TARGET_MARGIN,
 * PRICE_STEP, PRICE_FLOOR_*, PRICE_CEILING_*) are not part of lib/env.ts. Numeric
 * env is parsed via parseUsd (re-used, read-only import). Cap/threshold/floor/
 * margin/step carry documented testnet defaults (opt-backed); per-depth price
 * floor/ceiling are need-backed and fail loud when accessed-and-missing
 * (Silent-substitution-at-boundary: surface the gap, never substitute a proxy).
 */
import { opt, parseUsd, type Depth } from "../lib/env.ts";

/** Parse a numeric env value, failing loud on a non-number (never a silent NaN). */
function num(key: string, raw: string): number {
  const n = parseUsd(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`[cfo-env] ${key} is not a number: ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Required CFO numeric env — throws if missing/blank or non-numeric. */
function needNum(key: string): number {
  const v = process.env[key];
  if (v == null || v.trim() === "") {
    throw new Error(`[cfo-env] missing required variable ${key} — set it in .env`);
  }
  return num(key, v.trim());
}

/** Optional CFO numeric env with a documented default. */
function optNum(key: string, fallback: string): number {
  return num(key, opt(key, fallback));
}

/** Per-key accessors; each reads process.env on call (fail-loud where required). */
export const cfoEnv = {
  dailyCapUsdc: () => optNum("DAILY_CAP_USDC", "$1.00"),
  approvalThresholdUsdc: () => optNum("APPROVAL_THRESHOLD_USDC", "$0.50"),
  runwayFloorUsdc: () => optNum("RUNWAY_FLOOR_USDC", "$0.10"),
  /** Target margin as a fraction, e.g. 0.40 = 40%. */
  targetMargin: () => optNum("TARGET_MARGIN", "0.40"),
  priceStep: () => optNum("PRICE_STEP", "$0.01"),
  priceFloor: (d: Depth) => needNum(`PRICE_FLOOR_${d.toUpperCase()}`),
  priceCeiling: (d: Depth) => needNum(`PRICE_CEILING_${d.toUpperCase()}`),
};

/** A resolved config snapshot: scalars read once, per-depth accessors stay lazy. */
export interface CfoConfig {
  dailyCapUsdc: number;
  approvalThresholdUsdc: number;
  runwayFloorUsdc: number;
  targetMargin: number;
  priceStep: number;
  priceFloor: (d: Depth) => number;
  priceCeiling: (d: Depth) => number;
}

export function resolveConfig(): CfoConfig {
  return {
    dailyCapUsdc: cfoEnv.dailyCapUsdc(),
    approvalThresholdUsdc: cfoEnv.approvalThresholdUsdc(),
    runwayFloorUsdc: cfoEnv.runwayFloorUsdc(),
    targetMargin: cfoEnv.targetMargin(),
    priceStep: cfoEnv.priceStep(),
    priceFloor: cfoEnv.priceFloor,
    priceCeiling: cfoEnv.priceCeiling,
  };
}
