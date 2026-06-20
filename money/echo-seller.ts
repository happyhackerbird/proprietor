/**
 * echo-seller.ts (D6) — the throwaway paid seller that proves the x402 loop.
 *
 * One route `POST /echo` priced at $0.001 whose handler echoes the body. Built
 * on the Phase-1 factory (no bespoke x402). Per master-spec step 1, the seller
 * wallet is the SUPPLIER address (live-verify pays it from BUYER).
 */
import { pathToFileURL } from "node:url";
import { createPaidApp } from "./x402-seller.ts";
import { env } from "../lib/env.ts";

export function buildEchoApp() {
  return createPaidApp({
    sellerAddress: env.supplierAddress(),
    facilitatorUrl: env.facilitatorUrl(),
    networks: env.networkCaip2(),
    freeRoutes: (app) => {
      app.get("/healthz", (_req, res) => res.json({ ok: true }));
    },
    routes: [{ method: "post", path: "/echo", price: "$0.001", handler: (body) => ({ echoed: body }) }],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = env.echoPort();
  buildEchoApp().listen(port, () => {
    console.log(`[echo-seller] x402 POST /echo @ $0.001 listening on :${port} (seller=${env.supplierAddress()})`);
  });
}
