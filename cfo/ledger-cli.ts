/**
 * ledger-cli.ts (CFO) — `npm run cfo:ledger` entrypoint: render the spend-ledger read
 * view (treasury balance, per-order P&L, price history, today's spend vs cap) from the
 * persistent ledger DB. Best-effort treasury balance via the Circle CLI; "n/a (offline)"
 * if it can't be read.
 */
import { pathToFileURL } from "node:url";
import { env } from "../lib/env.ts";
import { Treasury } from "../money/treasury.ts";
import { Ledger } from "../ledger/ledger.ts";
import { renderReadView } from "./read-view.ts";
import { resolveConfig } from "./config.ts";
import { parseBalanceUsdc } from "./processor.ts";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ledgerPath = process.env.CFO_LEDGER_PATH ?? "data/cfo-ledger.db";
  const ledger = new Ledger(ledgerPath);
  const config = resolveConfig();

  (async () => {
    let balance: number | null = null;
    try {
      balance = parseBalanceUsdc(await new Treasury().getBalance(env.treasuryAddress()));
    } catch {
      balance = null; // offline / no wallet — render "n/a (offline)"
    }
    console.log(renderReadView(ledger, balance, config));
    ledger.close();
  })().catch((err) => {
    console.error(`[cfo:ledger] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
