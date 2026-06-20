/**
 * reprice.ts (CFO) — the between-orders repricing loop orchestration + CLI entrypoint.
 *
 * `runRepriceCycle` inspects the supplier's current wholesale per depth, computes margin-
 * defending retail changes (cfo/repricer.ts), applies them to the live CfoPricingProvider
 * the storefront reads, and logs each change to the ledger with its natural-language reason.
 * Pure-core (reprice) is unit-tested separately; this is the SDK-free glue.
 */
import { DEPTHS, env, type Depth } from "../lib/env.ts";
import { pathToFileURL } from "node:url";
import { Treasury } from "../money/treasury.ts";
import { Ledger } from "../ledger/ledger.ts";
import { reprice, toPriceChangeRow, CfoPricingProvider, type PriceChange, type RepriceTier } from "./repricer.ts";
import { parseWholesaleUsdc } from "./processor.ts";
import { resolveConfig, type CfoConfig } from "./config.ts";

export interface RepriceCycleDeps {
  treasury: Treasury;
  ledger: Ledger;
  pricing: CfoPricingProvider;
  config: CfoConfig;
  supplierUrl: string;
  now?: () => number;
}

/**
 * Run one repricing cycle: inspect supplier wholesale per depth, compute + apply + log
 * retail changes. Returns the changes made. A depth whose wholesale can't be read is
 * skipped (surfaced by its absence from perDepth, not silently defaulted).
 */
export async function runRepriceCycle(deps: RepriceCycleDeps): Promise<PriceChange[]> {
  const { treasury, ledger, pricing, config, supplierUrl } = deps;
  const now = deps.now ?? (() => Date.now());

  const inspectRaw = await treasury.inspectService(supplierUrl);
  const perDepth: Partial<Record<Depth, RepriceTier>> = {};
  for (const depth of DEPTHS) {
    const wholesale = parseWholesaleUsdc(inspectRaw, depth);
    if (Number.isFinite(wholesale)) {
      perDepth[depth] = { retail: pricing.retailFor(depth), wholesale };
    }
  }

  const changes = reprice({
    perDepth,
    targetMargin: config.targetMargin,
    priceStep: config.priceStep,
    priceFloor: config.priceFloor,
    priceCeiling: config.priceCeiling,
  });

  const ts = now();
  for (const change of changes) {
    pricing.applyChange(change);
    ledger.recordPriceChange(toPriceChangeRow(change, ts));
  }
  return changes;
}

// CLI entrypoint: run one reprice cycle against the configured supplier + a persistent ledger.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ledgerPath = process.env.CFO_LEDGER_PATH ?? "data/cfo-ledger.db";
  const treasury = new Treasury();
  const ledger = new Ledger(ledgerPath);
  const pricing = CfoPricingProvider.fromStrings({
    basic: env.retailPrice("basic"),
    standard: env.retailPrice("standard"),
    comprehensive: env.retailPrice("comprehensive"),
  });
  runRepriceCycle({ treasury, ledger, pricing, config: resolveConfig(), supplierUrl: env.supplierUrl() })
    .then((changes) => {
      if (changes.length === 0) console.log("[cfo:reprice] no changes — margins within band");
      for (const c of changes) console.log(`[cfo:reprice] ${c.reason}`);
      ledger.close();
    })
    .catch((err) => {
      console.error(`[cfo:reprice] failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
