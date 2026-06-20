/**
 * test-setup.ts (CFO) — offline env bootstrap for the vitest suite.
 *
 * The existing suite reads required env vars (PRICE_*, WHOLESALE_*, wallet addresses)
 * via lib/env.ts's fail-loud `need()`. In a clean worktree with no `.env`, those throw.
 * This setup loads the documented defaults from `.env.example` (which carries price/
 * wholesale values), then fills ONLY still-blank required keys with non-secret offline
 * placeholders. It never overrides a value a real `.env` provides, and never writes
 * `.env`, so the reviewer's live run uses its real wallets unchanged.
 *
 * Registered via vitest.config.ts `setupFiles`. CFO unit tests set their own CFO config
 * env inline (or inject config objects), so they don't depend on this fallback for
 * correctness — it only un-blocks the env-gated existing tests.
 */
import { config } from "dotenv";

// 1. Documented defaults (prices/wholesale have values; wallet addresses are blank here).
config({ path: ".env.example" });
// 2. A real .env, if present, takes precedence (dotenv does not override already-set keys).
config();

// 3. Fill only still-blank required keys with offline placeholders (no secrets).
const placeholders: Record<string, string> = {
  TREASURY_WALLET_ADDRESS: "0xTREASURYTEST",
  SUPPLIER_WALLET_ADDRESS: "0xSUPPLIERTEST",
  BUYER_WALLET_ADDRESS: "0xBUYERTEST",
};
for (const [k, v] of Object.entries(placeholders)) {
  if (process.env[k] == null || process.env[k]!.trim() === "") {
    process.env[k] = v;
  }
}
