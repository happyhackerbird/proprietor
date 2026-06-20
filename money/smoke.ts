/**
 * smoke.ts (D6) — the buyer smoke test for the echo seller.
 *
 * Pays the running echo-seller from the BUYER wallet via treasury.payService
 * and prints { response, amount, txHash (or "pending-batch") }. Proves the whole
 * Circle two-sided loop before any business logic.
 */
import { Treasury } from "./treasury.ts";
import { env } from "../lib/env.ts";

async function main(): Promise<void> {
  const treasury = new Treasury();
  const url = `http://localhost:${env.echoPort()}/echo`;
  console.log(`[smoke] paying ${url} from BUYER ${env.buyerAddress()} …`);
  const res = await treasury.payService({
    url,
    address: env.buyerAddress(),
    chain: env.chain(),
    method: "POST",
    data: { hello: "proprietor" },
    maxAmount: "0.01",
  });
  console.log("response:", JSON.stringify(res.response));
  console.log("amount:  ", res.amount);
  console.log("txHash:  ", res.txHash ?? "pending-batch");
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
