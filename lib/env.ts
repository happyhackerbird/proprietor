/**
 * Shared, typed environment loader for the Proprietor money layer (D11).
 *
 * Reads `.env` (gitignored) via dotenv. Required, no-sensible-default values
 * (wallet addresses, prices) fail LOUD when accessed-and-missing — never a
 * silent substitute (Silent-substitution-at-boundary). Documented network
 * constants (chain id, facilitator, CAIP-2, RPC) carry the spec-pinned default.
 *
 * Each accessor reads `process.env` on call, so a service only triggers
 * fail-loud for the keys it actually uses (the echo seller needs no ENGINE_URL).
 */
import { config } from "dotenv";

config();

export type Depth = "basic" | "standard" | "comprehensive";
export const DEPTHS: readonly Depth[] = ["basic", "standard", "comprehensive"] as const;

export function isDepth(value: string): value is Depth {
  return (DEPTHS as readonly string[]).includes(value);
}

/** Required env var — throws if missing/blank (no silent default). */
export function need(key: string): string {
  const v = process.env[key];
  if (v == null || v.trim() === "") {
    throw new Error(`[env] missing required variable ${key} — set it in .env`);
  }
  return v.trim();
}

/** Optional env var with a documented default constant. */
export function opt(key: string, fallback: string): string {
  const v = process.env[key];
  return v == null || v.trim() === "" ? fallback : v.trim();
}

/** Parse a USD price string ("$0.03" | "0.03") to a number. */
export function parseUsd(s: string): number {
  return Number(s.replace(/^\$/, "").trim());
}

export const env = {
  // ── Network constants (spec-pinned defaults; overridable) ──
  chain: () => opt("CIRCLE_CHAIN", "ARC-TESTNET"),
  networkCaip2: () => opt("NETWORK_CAIP2", "eip155:5042002"),
  facilitatorUrl: () => opt("FACILITATOR_URL", "https://gateway-api-testnet.circle.com"),
  rpcUrl: () => opt("ARC_RPC_URL", "https://rpc.testnet.arc.network"),

  // ── Wallet addresses (required — fail loud) ──
  treasuryAddress: () => need("TREASURY_WALLET_ADDRESS"),
  supplierAddress: () => need("SUPPLIER_WALLET_ADDRESS"),
  buyerAddress: () => need("BUYER_WALLET_ADDRESS"),

  // ── Service wiring ──
  engineUrl: () => opt("ENGINE_URL", "http://localhost:8000"),
  supplierUrl: () => opt("SUPPLIER_URL", "http://localhost:4000"),
  /** Port the supplier listens on — derived from SUPPLIER_URL (default 4000). */
  supplierPort: () => Number(new URL(opt("SUPPLIER_URL", "http://localhost:4000")).port || "4000"),
  storefrontPort: () => Number(opt("STOREFRONT_PORT", "3000")),
  echoPort: () => Number(opt("ECHO_PORT", "4000")),

  // ── Pricing (USD strings like "$0.03"; required — fail loud) ──
  retailPrice: (d: Depth) => need(`PRICE_${d.toUpperCase()}`),
  wholesalePrice: (d: Depth) => need(`WHOLESALE_${d.toUpperCase()}`),
};
