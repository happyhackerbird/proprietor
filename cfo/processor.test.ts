import { describe, it, expect, vi } from "vitest";
import { CfoProcessor, parseBalanceUsdc, parseWholesaleUsdc, type Order } from "./processor.ts";
import { GatePausedError } from "./gate.ts";
import { Ledger } from "../ledger/ledger.ts";
import type { CfoConfig } from "./config.ts";
import type { Fulfiller, FulfilInput, FulfilResult } from "../storefront/fulfiller.ts";
import { Treasury, type CliRunner, type CodeFetcher } from "../money/treasury.ts";

// ── Fakes ─────────────────────────────────────────────────────────────────────

/** A fake Treasury: returns canned balance + inspect JSON, records pay calls. */
function fakeTreasury(opts: { balance: unknown; inspect: unknown }): Treasury {
  const run: CliRunner = async (args) => {
    const joined = args.join(" ");
    if (joined.includes("wallet balance")) return JSON.stringify({ data: opts.balance });
    if (joined.includes("services inspect")) return JSON.stringify({ data: opts.inspect });
    throw new Error(`unexpected treasury call: ${joined}`);
  };
  const code: CodeFetcher = async () => "0x";
  return new Treasury(run, code, "http://rpc");
}

/** A fake inner fulfiller (SupplierFulfiller stand-in) that records calls and returns canned research. */
function fakeFulfiller(over: Partial<FulfilResult> = {}): Fulfiller & { calls: FulfilInput[] } {
  const calls: FulfilInput[] = [];
  const result: FulfilResult = {
    profile: { company: "stripe.com", confidence: 0.9, basics: {}, product: {}, funding: {}, hiring: {}, news: {} },
    cost: { tavily_searches: 3, nebius_calls: 5, nebius_tokens: 1200, est_usd: 0.0156 },
    cache_hit: false,
    depth_served: "standard",
    wholesale_usdc: 0.015,
    supplier_tx_hash: "0xSUPPLIER",
    ...over,
  };
  return {
    calls,
    fulfil: vi.fn(async (i: FulfilInput) => {
      calls.push(i);
      return result;
    }),
  };
}

const config: CfoConfig = {
  dailyCapUsdc: 1.0,
  approvalThresholdUsdc: 0.5,
  runwayFloorUsdc: 0.1,
  targetMargin: 0.4,
  priceStep: 0.01,
  priceFloor: () => 0.005,
  priceCeiling: () => 0.2,
};

const order: Order = { order_id: "ord-1", company: "stripe.com", depth: "standard", retail_paid_usdc: 0.03 };

function makeProcessor(over: { fulfiller?: Fulfiller; treasury?: Treasury; config?: CfoConfig; approve?: (r: any) => boolean } = {}) {
  const ledger = new Ledger();
  const treasury = over.treasury ?? fakeTreasury({ balance: { usdc: "1.0" }, inspect: { prices: { standard: "$0.015" } } });
  const innerFulfiller = over.fulfiller ?? fakeFulfiller();
  const processor = new CfoProcessor({
    treasury,
    innerFulfiller,
    ledger,
    config: over.config ?? config,
    treasuryAddress: "0xTREASURY",
    supplierUrl: "http://supplier",
    approve: over.approve,
    now: () => Date.UTC(2026, 5, 20, 12, 0, 0),
  });
  return { processor, ledger, innerFulfiller };
}

// ── Parsers ─────────────────────────────────────────────────────────────────────

describe("parseBalanceUsdc", () => {
  it("reads several shapes", () => {
    expect(parseBalanceUsdc({ usdc: "1.23" })).toBe(1.23);
    expect(parseBalanceUsdc({ balance: 2 })).toBe(2);
    expect(parseBalanceUsdc({ balances: [{ amount: "0.5" }] })).toBe(0.5);
    expect(parseBalanceUsdc("3.0")).toBe(3.0);
    expect(parseBalanceUsdc(4)).toBe(4);
    expect(Number.isNaN(parseBalanceUsdc({ nope: 1 }))).toBe(true);
  });
});

describe("parseWholesaleUsdc", () => {
  it("reads per-depth and flat price shapes", () => {
    expect(parseWholesaleUsdc({ prices: { standard: "$0.015" } }, "standard")).toBe(0.015);
    expect(parseWholesaleUsdc({ price: "$0.04" }, "comprehensive")).toBe(0.04);
    expect(parseWholesaleUsdc({ accepts: [{ maxAmountRequired: "0.005" }] }, "basic")).toBe(0.005);
    expect(Number.isNaN(parseWholesaleUsdc({ nope: 1 }, "standard"))).toBe(true);
  });
});

// ── Order processing ─────────────────────────────────────────────────────────────

describe("CfoProcessor.processOrder", () => {
  it("inspects → pays supplier → returns a receipt with margin = retail − wholesale; writes ledger rows with reasoning", async () => {
    const { processor, ledger, innerFulfiller } = makeProcessor();
    const { receipt } = await processor.processOrder(order);

    expect((innerFulfiller as any).calls[0]).toEqual({ company: "stripe.com", depth: "standard" });
    expect(receipt.retail_paid_usdc).toBe(0.03);
    expect(receipt.wholesale_cost_usdc).toBe(0.015);
    expect(receipt.margin_usdc).toBe(0.015);
    expect(receipt.supplier_tx_hash).toBe("0xSUPPLIER");
    expect(receipt.settlement).toBe("settled");
    expect(receipt.reasoning).toMatch(/margin \$0.015/);

    const orders = ledger.orders();
    expect(orders).toHaveLength(1);
    expect(orders[0].reasoning).toContain("margin $0.015");
    const payments = ledger.payments();
    expect(payments).toHaveLength(1);
    expect(payments[0].amount_usdc).toBe(0.015);
    expect(payments[0].gate_code).toBeNull();
  });

  it("guards an undefined supplier tx hash → settlement 'pending-batch'", async () => {
    const { processor } = makeProcessor({ fulfiller: fakeFulfiller({ supplier_tx_hash: null }) });
    const { receipt } = await processor.processOrder(order);
    expect(receipt.supplier_tx_hash).toBeNull();
    expect(receipt.settlement).toBe("pending-batch");
    expect(receipt.reasoning).toMatch(/pending-batch/);
  });

  it("DAILY CAP: a pay exceeding the cap is denied, the attempt is logged with gate_code, fulfiller is NOT called", async () => {
    const ledger = new Ledger();
    const treasury = fakeTreasury({ balance: { usdc: "1.0" }, inspect: { prices: { standard: "$0.015" } } });
    const innerFulfiller = fakeFulfiller();
    const now = Date.UTC(2026, 5, 20, 12, 0, 0);
    // Pre-load today's spend to just under the cap so the next $0.015 exceeds it.
    ledger.recordPayment({ order_id: "prev", amount_usdc: 0.99, tx_hash: null, settlement: "pending-batch", gate_code: null, reasoning: "prev", ts: now });
    const processor = new CfoProcessor({
      treasury, innerFulfiller, ledger, config, treasuryAddress: "0xT", supplierUrl: "http://s", now: () => now,
    });
    await expect(processor.processOrder(order)).rejects.toThrowError(GatePausedError);
    expect((innerFulfiller as any).fulfil).not.toHaveBeenCalled();
    const denied = ledger.payments().filter((p) => p.gate_code === "daily-cap");
    expect(denied).toHaveLength(1);
    expect(denied[0].amount_usdc).toBe(0); // never inflates today's spend
    expect(denied[0].reasoning).toMatch(/daily cap reached/);
  });

  it("RUNWAY FLOOR: a spend that would drop balance below the floor pauses spend; fulfiller not called", async () => {
    const treasury = fakeTreasury({ balance: { usdc: "0.11" }, inspect: { prices: { standard: "$0.015" } } });
    const { processor, ledger, innerFulfiller } = makeProcessor({ treasury, config: { ...config, runwayFloorUsdc: 0.1 } });
    await expect(processor.processOrder(order)).rejects.toThrowError(GatePausedError);
    expect((innerFulfiller as any).fulfil).not.toHaveBeenCalled();
    expect(ledger.payments().some((p) => p.gate_code === "runway-floor")).toBe(true);
  });

  it("APPROVAL THRESHOLD: a wholesale ≥ threshold takes the human-prompt path (denied fail-closed by default)", async () => {
    // wholesale 0.6 ≥ threshold 0.5, balance high enough, under cap.
    const treasury = fakeTreasury({ balance: { usdc: "5.0" }, inspect: { prices: { standard: "$0.60" } } });
    const { processor, ledger, innerFulfiller } = makeProcessor({
      treasury,
      fulfiller: fakeFulfiller({ wholesale_usdc: 0.6 }),
      config: { ...config, dailyCapUsdc: 10, approvalThresholdUsdc: 0.5 },
    });
    await expect(processor.processOrder({ ...order, retail_paid_usdc: 0.8 })).rejects.toThrowError(GatePausedError);
    expect((innerFulfiller as any).fulfil).not.toHaveBeenCalled();
    expect(ledger.payments().some((p) => p.gate_code === "approval-denied")).toBe(true);
  });

  it("APPROVAL THRESHOLD: with an approver that approves, it pays and produces a receipt", async () => {
    const treasury = fakeTreasury({ balance: { usdc: "5.0" }, inspect: { prices: { standard: "$0.60" } } });
    const { processor } = makeProcessor({
      treasury,
      fulfiller: fakeFulfiller({ wholesale_usdc: 0.6, supplier_tx_hash: "0xBIG" }),
      config: { ...config, dailyCapUsdc: 10, approvalThresholdUsdc: 0.5 },
      approve: () => true,
    });
    const { receipt } = await processor.processOrder({ ...order, retail_paid_usdc: 0.8 });
    expect(receipt.margin_usdc).toBe(0.2);
    expect(receipt.supplier_tx_hash).toBe("0xBIG");
  });

  it("uses the published wholesale fallback (recorded, not silent) when inspect omits a readable price", async () => {
    // inspect returns no parseable price → fall back to env WHOLESALE_STANDARD ($0.015 from .env.example).
    const treasury = fakeTreasury({ balance: { usdc: "1.0" }, inspect: { something: "else" } });
    const { processor, ledger } = makeProcessor({ treasury });
    const { receipt } = await processor.processOrder(order);
    expect(receipt.wholesale_cost_usdc).toBe(0.015);
    expect(receipt.reasoning).toMatch(/published-fallback/);
    expect(ledger.orders()).toHaveLength(1);
  });

  it("propagates a fulfiller error after the gate allowed (no blind retry, no fake success)", async () => {
    const boom: Fulfiller = { fulfil: vi.fn(async () => { throw new Error("supplier 502"); }) };
    const { processor } = makeProcessor({ fulfiller: boom });
    await expect(processor.processOrder(order)).rejects.toThrow(/supplier 502/);
    expect((boom.fulfil as any)).toHaveBeenCalledOnce();
  });
});
