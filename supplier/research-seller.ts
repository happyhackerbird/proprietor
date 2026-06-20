/**
 * research-seller.ts (D7) — the supplier-agent.
 *
 * One x402-paid route PER DEPTH (`POST /research/<depth>`), each priced at the
 * fixed wholesale price for that depth and fulfilled by calling the engine. Per
 * depth because x402 fixes a route's price at mount time (gateway.require takes a
 * string, not a body-dependent resolver). Reuses the Phase-1 factory + the engine
 * client; the supplier absorbs within-tier difficulty variance.
 *
 * Failure-path: an engine error after the buyer was charged surfaces as a 502
 * (handled by the factory) — no silent success, no blind-retry.
 */
import { pathToFileURL } from "node:url";
import type { Express } from "express";
import { createPaidApp, type PaidRoute } from "../money/x402-seller.ts";
import { HttpEngineClient, type EngineClient } from "./engine-client.ts";
import { wholesalePrice } from "./wholesale.ts";
import { DEPTHS, env, type Depth } from "../lib/env.ts";

/** The per-depth research handler — extracted so it is unit-testable offline. */
export function researchHandler(engine: EngineClient, depth: Depth) {
  return async (body: unknown) => {
    const { company, force_refresh } = (body ?? {}) as { company?: unknown; force_refresh?: unknown };
    if (typeof company !== "string" || company.trim() === "") {
      throw new Error("missing 'company' in request body");
    }
    const result = await engine.enrich({ company, depth, force_refresh: force_refresh === true });
    return {
      profile: result.profile,
      cost: result.cost,
      cache_hit: result.cache_hit,
      depth_served: result.depth_served,
    };
  };
}

export function buildSupplierApp(engine: EngineClient): Express {
  const routes: PaidRoute[] = DEPTHS.map((depth) => ({
    method: "post",
    path: `/research/${depth}`,
    price: wholesalePrice(depth),
    handler: researchHandler(engine, depth),
  }));

  return createPaidApp({
    sellerAddress: env.supplierAddress(),
    facilitatorUrl: env.facilitatorUrl(),
    networks: env.networkCaip2(),
    freeRoutes: (app) => {
      app.get("/healthz", (_req, res) => res.json({ ok: true }));
    },
    routes,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = env.supplierPort();
  buildSupplierApp(new HttpEngineClient(env.engineUrl())).listen(port, () => {
    console.log(`[supplier] x402 research seller on :${port} (seller=${env.supplierAddress()}, engine=${env.engineUrl()})`);
    for (const d of DEPTHS) console.log(`  POST /research/${d}  @ ${wholesalePrice(d)}`);
  });
}
