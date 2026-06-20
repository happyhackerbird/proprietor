/**
 * circle-tools.ts (CFO) — the Circle capabilities as an in-process MCP server for the
 * Claude Agent SDK (spec §Framework).
 *
 * Exposes the three wallet capabilities the CFO uses as SDK tools:
 *   - circle_get_balance     → Treasury.getBalance (runway)
 *   - circle_inspect_service → Treasury.inspectService (supplier wholesale price)
 *   - circle_pay_service     → the ONLY outbound spend path, routed through CfoProcessor
 *                              (whose CfoFulfiller runs the budget gate). `circle_pay_service`
 *                              is additionally gated by `canUseTool` in cfo/agent.ts.
 *
 * This module (and cfo/agent.ts) are the ONLY files importing the Agent SDK / zod, so the
 * deterministic core (processor/gate/ledger/repricer/fulfiller) stays SDK-free and
 * offline-testable. Auth is the Claude Code subscription session — no ANTHROPIC_API_KEY.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { isDepth, type Depth } from "../lib/env.ts";
import { Treasury } from "../money/treasury.ts";
import { CfoProcessor, type Order } from "./processor.ts";

export interface CircleToolDeps {
  treasury: Treasury;
  processor: CfoProcessor;
  treasuryAddress: string;
  supplierUrl: string;
}

/** Build the in-process "cfo" MCP server exposing the Circle wallet tools. */
export function createCircleMcpServer(deps: CircleToolDeps) {
  const { treasury, processor, treasuryAddress, supplierUrl } = deps;

  const circle_get_balance = tool(
    "circle_get_balance",
    "Get the Proprietor treasury wallet's current USDC balance (runway). Call this before any spend.",
    { address: z.string().optional().describe("treasury wallet address; defaults to the configured treasury") },
    async ({ address }) => {
      const balance = await treasury.getBalance(address ?? treasuryAddress);
      return { content: [{ type: "text", text: JSON.stringify(balance) }] };
    },
  );

  const circle_inspect_service = tool(
    "circle_inspect_service",
    "Inspect the supplier-agent's paid service to read its current wholesale price and input schema per depth.",
    { url: z.string().optional().describe("supplier service URL; defaults to the configured supplier") },
    async ({ url }) => {
      const info = await treasury.inspectService(url ?? supplierUrl);
      return { content: [{ type: "text", text: JSON.stringify(info) }] };
    },
  );

  const circle_pay_service = tool(
    "circle_pay_service",
    "Pay the supplier-agent in USDC for one research job and return a justified receipt. This is the ONLY " +
      "outbound spend path; it runs the budget/approval/runway gate and writes the ledger. Gated by canUseTool.",
    {
      order_id: z.string().describe("the storefront order id"),
      company: z.string().describe("the company to research"),
      depth: z.string().describe("research depth: basic | standard | comprehensive"),
      retail_paid_usdc: z.number().describe("the retail USDC the customer already paid the storefront"),
    },
    async ({ order_id, company, depth, retail_paid_usdc }) => {
      if (!isDepth(depth)) {
        return { content: [{ type: "text", text: `error: invalid depth ${JSON.stringify(depth)}` }], isError: true };
      }
      const order: Order = { order_id, company, depth: depth as Depth, retail_paid_usdc };
      try {
        const { receipt } = await processor.processOrder(order);
        return { content: [{ type: "text", text: JSON.stringify(receipt) }] };
      } catch (err) {
        // Decline-before-charge / supplier failure — surface, never fake success.
        return {
          content: [{ type: "text", text: `payment not completed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  return createSdkMcpServer({
    name: "cfo",
    version: "0.1.0",
    tools: [circle_get_balance, circle_inspect_service, circle_pay_service],
  });
}

/** The MCP-namespaced tool name the SDK assigns to circle_pay_service (server "cfo"). */
export const PAY_TOOL = "mcp__cfo__circle_pay_service";
export const BALANCE_TOOL = "mcp__cfo__circle_get_balance";
export const INSPECT_TOOL = "mcp__cfo__circle_inspect_service";
