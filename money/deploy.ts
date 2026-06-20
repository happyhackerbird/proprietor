/**
 * deploy.ts (D14) — STEP 0: deploy the counterfactual SCA wallets.
 *
 * TREASURY/SUPPLIER/BUYER are counterfactual until deployed (per chain) and
 * cannot sign x402 until then. Deploys each via a zero-value self-transfer and
 * confirms eth_getCode is non-empty. Idempotent: skips already-deployed wallets.
 *
 *   npm run deploy:wallets
 */
import { Treasury } from "./treasury.ts";
import { env } from "../lib/env.ts";

async function main(): Promise<void> {
  const treasury = new Treasury();
  const chain = env.chain();
  const wallets: ReadonlyArray<readonly [string, string]> = [
    ["TREASURY", env.treasuryAddress()],
    ["SUPPLIER", env.supplierAddress()],
    ["BUYER", env.buyerAddress()],
  ];

  for (const [name, addr] of wallets) {
    process.stdout.write(`[deploy] ${name} ${addr} … `);
    if (await treasury.isDeployed(addr, chain)) {
      console.log("already deployed");
      continue;
    }
    const r = await treasury.deployWallet(addr, chain);
    console.log(r.deployed ? `deployed (tx ${r.txId ?? "?"})` : `NOT deployed after polling (tx ${r.txId ?? "?"})`);
  }

  console.log("\n[confirm] eth_getCode:");
  let allDeployed = true;
  for (const [name, addr] of wallets) {
    const deployed = await treasury.isDeployed(addr, chain);
    allDeployed &&= deployed;
    console.log(`  ${name} ${addr} deployed=${deployed}`);
  }
  if (!allDeployed) process.exit(1);
}

main().catch((err) => {
  console.error("[deploy] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
