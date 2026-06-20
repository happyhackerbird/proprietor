import { describe, it, expect } from "vitest";
import { runRepriceCycle } from "./reprice.ts";
import { CfoPricingProvider } from "./repricer.ts";
import { Ledger } from "../ledger/ledger.ts";
import type { CfoConfig } from "./config.ts";
import { Treasury, type CliRunner, type CodeFetcher } from "../money/treasury.ts";

function fakeTreasury(inspect: unknown): Treasury {
  const run: CliRunner = async (args) => {
    if (args.join(" ").includes("services inspect")) return JSON.stringify({ data: inspect });
    throw new Error("unexpected");
  };
  const code: CodeFetcher = async () => "0x";
  return new Treasury(run, code, "http://rpc");
}

const config: CfoConfig = {
  dailyCapUsdc: 1.0,
  approvalThresholdUsdc: 0.5,
  runwayFloorUsdc: 0.1,
  targetMargin: 0.4,
  priceStep: 0.02,
  priceFloor: () => 0.005,
  priceCeiling: () => 0.5,
};

const now = () => Date.UTC(2026, 5, 20, 12, 0, 0);

describe("runRepriceCycle", () => {
  it("inspects supplier, raises retail on margin compression, applies to the provider, and logs to the ledger", async () => {
    // standard retail 0.03, supplier wholesale now 0.025 → margin ~17% < 40% target → raise.
    const treasury = fakeTreasury({ prices: { standard: "$0.025" } });
    const ledger = new Ledger();
    const pricing = new CfoPricingProvider({ basic: 0.01, standard: 0.03, comprehensive: 0.08 });

    const changes = await runRepriceCycle({ treasury, ledger, pricing, config, supplierUrl: "http://s", now });

    expect(changes).toHaveLength(1);
    expect(changes[0].depth).toBe("standard");
    expect(changes[0].new_price_usdc).toBe(0.05);
    // applied to the live provider the storefront reads
    expect(pricing.retailFor("standard")).toBe(0.05);
    // logged to the ledger with reason
    const rows = ledger.priceChanges();
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(/margin fell to 17% < 40% target/);
    ledger.close();
  });

  it("makes no change and logs nothing when margins are within band", async () => {
    const treasury = fakeTreasury({ prices: { standard: "$0.018" } }); // 0.03 retail → margin 40% == target
    const ledger = new Ledger();
    const pricing = new CfoPricingProvider({ basic: 0.01, standard: 0.03, comprehensive: 0.08 });
    const changes = await runRepriceCycle({ treasury, ledger, pricing, config, supplierUrl: "http://s", now });
    expect(changes).toHaveLength(0);
    expect(ledger.priceChanges()).toHaveLength(0);
    ledger.close();
  });

  it("skips a depth whose wholesale can't be read (surfaced by absence, not silently defaulted)", async () => {
    // inspect only has standard; basic/comprehensive omitted → skipped (no change attempted).
    const treasury = fakeTreasury({ prices: { standard: "$0.025" } });
    const ledger = new Ledger();
    const pricing = new CfoPricingProvider({ basic: 0.01, standard: 0.03, comprehensive: 0.08 });
    const changes = await runRepriceCycle({ treasury, ledger, pricing, config, supplierUrl: "http://s", now });
    expect(changes.every((c) => c.depth === "standard")).toBe(true);
    ledger.close();
  });
});
