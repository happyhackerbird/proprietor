/**
 * main.ts (CFO) — `npm run cfo` entrypoint: process one order end-to-end via the Claude
 * Agent SDK (the live agentic payment loop). Reads the order from argv/env, drives
 * runCfoAgent, prints the resulting receipt. Live path — requires the Claude Code
 * subscription session and a running supplier/treasury on Arc Testnet.
 *
 * Usage: npm run cfo -- '{"order_id":"o1","company":"stripe.com","depth":"standard","retail_paid_usdc":0.03}'
 */
import { pathToFileURL } from "node:url";
import { isDepth } from "../lib/env.ts";
import { Ledger } from "../ledger/ledger.ts";
import { runCfoAgent } from "./agent.ts";
import type { Order } from "./processor.ts";

function parseOrder(raw: string | undefined): Order {
  if (!raw) throw new Error("usage: npm run cfo -- '<order JSON>'");
  const o = JSON.parse(raw) as Partial<Order>;
  if (typeof o.order_id !== "string" || typeof o.company !== "string" || typeof o.retail_paid_usdc !== "number" || !isDepth(String(o.depth))) {
    throw new Error(`invalid order: ${raw}`);
  }
  return { order_id: o.order_id, company: o.company, depth: o.depth!, retail_paid_usdc: o.retail_paid_usdc };
}

const USAGE = [
  "Usage: npm run cfo -- '<order JSON>'",
  "",
  "Example:",
  `  npm run cfo -- '{"order_id":"o1","company":"stripe.com","depth":"standard","retail_paid_usdc":0.03}'`,
  "",
  "The CFO inspects and pays the supplier, so the engine + supplier must be running.",
  "To see every decision branch (allow / budget-deny / approval-deny / reprice), run:",
  "  npm run cfo:demo",
].join("\n");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = process.argv[2];
  if (!raw) {
    // No order given — print usage cleanly (no stack trace) and exit success.
    console.log(USAGE);
    process.exit(0);
  }
  let order: Order;
  try {
    order = parseOrder(raw);
  } catch (err) {
    console.error(`[cfo] ${err instanceof Error ? err.message : String(err)}\n`);
    console.error(USAGE);
    process.exit(1);
  }
  const ledgerPath = process.env.CFO_LEDGER_PATH ?? "data/cfo-ledger.db";
  const ledger = new Ledger(ledgerPath);
  runCfoAgent(order, { ledger })
    .then((receipt) => {
      if (receipt) {
        console.log(JSON.stringify({ event: "cfo.receipt", ...receipt }, null, 2));
      } else {
        console.error("[cfo] no receipt produced (payment may have been gated/declined — check the ledger)");
        process.exitCode = 1;
      }
      ledger.close();
    })
    .catch((err) => {
      console.error(`[cfo] order failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
