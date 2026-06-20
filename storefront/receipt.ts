/**
 * receipt.ts (D9') — the storefront Receipt for the two-sided loop.
 *
 * revenue (buyer→storefront, retail) and wholesale (storefront→supplier,
 * on-chain) are both real USDC; margin = revenue − wholesale. Both tx hashes are
 * guarded (→ null under batched settlement). Headline `settlement` keys off the
 * outbound supplier tx (the agentic payment that proves the loop).
 */
import { randomUUID } from "node:crypto";
import type { Depth } from "../lib/env.ts";
import type { VerifiedPayment } from "../money/x402-seller.ts";
import type { FulfilResult } from "./fulfiller.ts";

export type Settlement = "settled" | "pending-batch";

export interface Receipt {
  job_id: string;
  company: string;
  depth_served: Depth;
  cache_hit: boolean;
  revenue_usdc: number;
  wholesale_usdc: number;
  cost: {
    source: "onchain";
    tavily_searches: number;
    nebius_calls: number;
    nebius_tokens: number;
    est_usd: number;
  };
  margin_usdc: number;
  supplier_tx_hash: string | null;
  revenue_tx_hash: string | null;
  settlement: Settlement;
  reasoning: string;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export function buildReceipt(params: {
  company: string;
  payment?: VerifiedPayment;
  fulfilment: FulfilResult;
}): Receipt {
  const { company, payment, fulfilment } = params;
  const revenue_usdc = payment ? round6(Number(payment.amount) / 1e6) : 0;
  const wholesale_usdc = round6(fulfilment.wholesale_usdc);
  const margin_usdc = round6(revenue_usdc - wholesale_usdc);
  const supplier_tx_hash = fulfilment.supplier_tx_hash;
  const revenue_tx_hash = payment?.transaction ?? null;
  const settlement: Settlement = supplier_tx_hash ? "settled" : "pending-batch";

  return {
    job_id: randomUUID(),
    company,
    depth_served: fulfilment.depth_served,
    cache_hit: fulfilment.cache_hit,
    revenue_usdc,
    wholesale_usdc,
    cost: { source: "onchain", ...fulfilment.cost },
    margin_usdc,
    supplier_tx_hash,
    revenue_tx_hash,
    settlement,
    reasoning:
      `${fulfilment.depth_served} tier: revenue $${revenue_usdc} − wholesale $${wholesale_usdc} = ` +
      `margin $${margin_usdc}; cache_hit=${fulfilment.cache_hit}; ` +
      `${fulfilment.cost.tavily_searches} Tavily + ${fulfilment.cost.nebius_calls} Nebius calls; ` +
      `supplier_tx=${supplier_tx_hash ?? "pending-batch"}`,
  };
}
