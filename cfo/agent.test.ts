/**
 * agent.test.ts — offline tests for the SDK orchestration's gate seam.
 *
 * The full `runCfoAgent` (query() + subprocess) is a live-only path (needs the Claude Code
 * subscription session) and is exercised by the reviewer. Here we test `buildCanUseTool`
 * in isolation: it must gate `circle_pay_service` through the SAME pure gate the processor
 * uses, with faked Circle reads — no SDK subprocess.
 */
import { describe, it, expect, vi } from "vitest";
import { buildCanUseTool } from "./agent.ts";
import { PAY_TOOL, BALANCE_TOOL } from "./circle-tools.ts";
import { Ledger } from "../ledger/ledger.ts";
import type { CfoConfig } from "./config.ts";
import { Treasury, type CliRunner, type CodeFetcher } from "../money/treasury.ts";

function fakeTreasury(balance: unknown, inspect: unknown): Treasury {
  const run: CliRunner = async (args) => {
    const j = args.join(" ");
    if (j.includes("wallet balance")) return JSON.stringify({ data: balance });
    if (j.includes("services inspect")) return JSON.stringify({ data: inspect });
    throw new Error(`unexpected: ${j}`);
  };
  const code: CodeFetcher = async () => "0x";
  return new Treasury(run, code, "http://rpc");
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

const now = () => Date.UTC(2026, 5, 20, 12, 0, 0);

function make(over: { balance?: unknown; inspect?: unknown; ledger?: Ledger; config?: CfoConfig; approve?: any } = {}) {
  const ledger = over.ledger ?? new Ledger();
  const treasury = fakeTreasury(over.balance ?? { usdc: "1.0" }, over.inspect ?? { prices: { standard: "$0.015" } });
  const canUseTool = buildCanUseTool({
    treasury, ledger, config: over.config ?? config, treasuryAddress: "0xT", supplierUrl: "http://s", approve: over.approve, now,
  });
  return { canUseTool, ledger };
}

const payInput = { order_id: "ord-1", company: "stripe.com", depth: "standard", retail_paid_usdc: 0.03 };
const sdkOpts = { signal: new AbortController().signal, toolUseID: "t1" } as any;

describe("buildCanUseTool", () => {
  it("allows read-only tools (non-pay) to pass through", async () => {
    const { canUseTool } = make();
    const r = await canUseTool(BALANCE_TOOL, {}, sdkOpts);
    expect(r.behavior).toBe("allow");
  });

  it("ALLOWS circle_pay_service when the gate allows (within cap and runway)", async () => {
    const { canUseTool } = make();
    const r = await canUseTool(PAY_TOOL, payInput, sdkOpts);
    expect(r.behavior).toBe("allow");
  });

  it("DENIES circle_pay_service when the daily cap would be exceeded", async () => {
    const ledger = new Ledger();
    ledger.recordPayment({ order_id: "p", amount_usdc: 0.99, tx_hash: null, settlement: "pending-batch", gate_code: null, reasoning: "", ts: now() });
    const { canUseTool } = make({ ledger });
    const r = await canUseTool(PAY_TOOL, payInput, sdkOpts);
    expect(r.behavior).toBe("deny");
    if (r.behavior === "deny") expect(r.message).toMatch(/daily-cap/);
  });

  it("DENIES circle_pay_service when runway floor would be breached", async () => {
    const { canUseTool } = make({ balance: { usdc: "0.11" } }); // 0.11 - 0.015 < 0.1
    const r = await canUseTool(PAY_TOOL, payInput, sdkOpts);
    expect(r.behavior).toBe("deny");
    if (r.behavior === "deny") expect(r.message).toMatch(/runway-floor/);
  });

  it("DENIES (human-prompt path) when wholesale ≥ approval threshold and no approver", async () => {
    const { canUseTool } = make({ balance: { usdc: "5.0" }, inspect: { prices: { standard: "$0.60" } }, config: { ...config, dailyCapUsdc: 10 } });
    const r = await canUseTool(PAY_TOOL, payInput, sdkOpts);
    expect(r.behavior).toBe("deny");
    if (r.behavior === "deny") expect(r.message).toMatch(/approval-denied/);
  });

  it("ALLOWS the ≥-threshold spend when an approver approves", async () => {
    const approve = vi.fn(() => true);
    const { canUseTool } = make({ balance: { usdc: "5.0" }, inspect: { prices: { standard: "$0.60" } }, config: { ...config, dailyCapUsdc: 10 }, approve });
    const r = await canUseTool(PAY_TOOL, payInput, sdkOpts);
    expect(approve).toHaveBeenCalledOnce();
    expect(r.behavior).toBe("allow");
  });
});
