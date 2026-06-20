/**
 * agent.ts (CFO) — the Claude Agent SDK orchestration (the live "agent thinking" path).
 *
 * Per order the CFO agent runs the loop via `query()`: it calls circle_get_balance →
 * circle_inspect_service → circle_pay_service (the in-process MCP tools from
 * cfo/circle-tools.ts) and narrates a justified receipt. circle_pay_service — the ONLY
 * outbound spend — is gated by `canUseTool`, which delegates to the SAME pure gate
 * (cfo/gate.ts) the deterministic processor uses, so the budget/approval/runway policy is
 * enforced once. Auth is the Claude Code subscription session (no ANTHROPIC_API_KEY).
 *
 * This file + cfo/circle-tools.ts are the only SDK-importing modules; the deterministic
 * core stays SDK-free and offline-testable. The live integration is run by the reviewer.
 */
import { query, type CanUseTool, type Options, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { Treasury } from "../money/treasury.ts";
import { Ledger } from "../ledger/ledger.ts";
import { CfoProcessor, parseBalanceUsdc, parseWholesaleUsdc, type Order, type Receipt } from "./processor.ts";
import { CfoFulfiller } from "./fulfiller.ts";
import { evaluateGate, type ApprovalRequest, type GateInput } from "./gate.ts";
import { resolveConfig, type CfoConfig } from "./config.ts";
import { SupplierFulfiller } from "../storefront/fulfiller.ts";
import { env, isDepth, type Depth } from "../lib/env.ts";
import { createCircleMcpServer, PAY_TOOL, BALANCE_TOOL, INSPECT_TOOL } from "./circle-tools.ts";

export interface CfoAgentDeps {
  treasury?: Treasury;
  ledger?: Ledger;
  config?: CfoConfig;
  treasuryAddress?: string;
  supplierUrl?: string;
  /** Human approval channel for amount ≥ APPROVAL_THRESHOLD_USDC. Default: deny (fail-closed). */
  approve?: (req: ApprovalRequest) => boolean;
  /** Override the model (default: the SDK/session default). */
  model?: string;
}

const SYSTEM_PROMPT =
  "You are the Proprietor's CFO — the autonomous agent that holds the treasury wallet and decides and " +
  "executes the outbound USDC payments that run the business. For each order you are given, you MUST: " +
  "(1) call circle_get_balance to check runway; (2) call circle_inspect_service WITH the order's depth " +
  "and company to read the supplier's current wholesale price for that research route (it inspects the " +
  "x402-gated POST /research/<depth>); (3) decide whether to proceed within the daily budget " +
  "and runway floor, narrating your reasoning; (4) call circle_pay_service exactly once to buy the research " +
  "from the supplier — this is the only way money leaves the treasury and it is gated; (5) return the " +
  "resulting justified receipt. Never pay twice for one order and never retry a failed paid call.";

/**
 * Build the `canUseTool` callback. It gates circle_pay_service through the SAME pure
 * gate the deterministic processor uses; all other tools pass through (read-only).
 * Balance + cumulative-today + wholesale are read live so the gate decision matches what
 * the processor would compute.
 */
export function buildCanUseTool(deps: {
  treasury: Treasury;
  ledger: Ledger;
  config: CfoConfig;
  treasuryAddress: string;
  supplierUrl: string;
  approve?: (req: ApprovalRequest) => boolean;
  now?: () => number;
}): CanUseTool {
  const now = deps.now ?? (() => Date.now());
  return async (toolName, input): Promise<PermissionResult> => {
    if (toolName !== PAY_TOOL) {
      return { behavior: "allow", updatedInput: input };
    }
    const depthRaw = String((input as { depth?: unknown }).depth ?? "");
    const depth: Depth = isDepth(depthRaw) ? depthRaw : "standard";
    const company = String((input as { company?: unknown }).company ?? "");

    const balanceRaw = await deps.treasury.getBalance(deps.treasuryAddress);
    const balanceUsdc = parseBalanceUsdc(balanceRaw);

    const inspectRaw = await deps.treasury.inspectService(
      `${deps.supplierUrl}/research/${depth}`,
      { method: "POST", data: { company } },
    );
    let wholesaleUsdc = parseWholesaleUsdc(inspectRaw, depth);
    if (!Number.isFinite(wholesaleUsdc)) {
      wholesaleUsdc = Number((input as { wholesale_usdc?: unknown }).wholesale_usdc ?? NaN);
    }

    const gateInput: GateInput = {
      amountUsdc: Number.isFinite(wholesaleUsdc) ? wholesaleUsdc : 0,
      balanceUsdc,
      cumulativeTodayUsdc: deps.ledger.cumulativeSpentToday(now()),
      dailyCapUsdc: deps.config.dailyCapUsdc,
      runwayFloorUsdc: deps.config.runwayFloorUsdc,
      approvalThresholdUsdc: deps.config.approvalThresholdUsdc,
      approve: deps.approve,
    };
    const decision = evaluateGate(gateInput);
    if (decision.allow) {
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: `${decision.code}: ${decision.reason}` };
  };
}

/**
 * Run the CFO agent over one order using the Claude Agent SDK. Returns the parsed Receipt
 * (from the circle_pay_service tool result) when the agent completes a payment, else null.
 *
 * Live path — requires the Claude Code subscription session; not exercised by the offline
 * suite (the gate + processor it drives are tested deterministically).
 */
export async function runCfoAgent(order: Order, deps: CfoAgentDeps = {}): Promise<Receipt | null> {
  const treasury = deps.treasury ?? new Treasury();
  const ledger = deps.ledger ?? new Ledger();
  const config = deps.config ?? resolveConfig();
  const treasuryAddress = deps.treasuryAddress ?? env.treasuryAddress();
  const supplierUrl = deps.supplierUrl ?? env.supplierUrl();

  // The single spend path: SupplierFulfiller (on-chain x402) wrapped by the budget gate via
  // the processor; the MCP circle_pay_service tool routes through this processor.
  const innerFulfiller = new SupplierFulfiller(treasury, supplierUrl, treasuryAddress, env.chain());
  const processor = new CfoProcessor({
    treasury,
    innerFulfiller,
    ledger,
    config,
    treasuryAddress,
    supplierUrl,
    approve: deps.approve,
  });

  const mcpServer = createCircleMcpServer({ treasury, processor, treasuryAddress, supplierUrl });
  const canUseTool = buildCanUseTool({ treasury, ledger, config, treasuryAddress, supplierUrl, approve: deps.approve });

  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    mcpServers: { cfo: mcpServer },
    allowedTools: [BALANCE_TOOL, INSPECT_TOOL, PAY_TOOL],
    canUseTool,
    permissionMode: "default",
    maxTurns: 8,
    ...(deps.model ? { model: deps.model } : {}),
  };

  const prompt =
    `Process this order and pay the supplier for the research, then report the receipt:\n` +
    JSON.stringify(order);

  // Drive the agent loop to completion. The receipt is produced by circle_pay_service
  // (via the processor) and recorded to the ledger there — the ledger is the authoritative
  // source, so we drain the stream and then read the row back.
  for await (const _message of query({ prompt, options })) {
    // The CFO's effects (balance/inspect/pay/ledger) happen inside the tool handlers; the
    // message stream is the agent's narration, which the live reviewer can also observe.
  }

  const rows = ledger.orders().filter((o) => o.order_id === order.order_id);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}
