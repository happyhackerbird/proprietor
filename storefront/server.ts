/**
 * server.ts (D8') — the customer-facing storefront.
 *
 * Free: GET /healthz, GET /v1/enrich/schema, POST /v1/preview (proxy engine).
 * Paid: POST /v1/enrich/<depth> mounted PER AVAILABLE TIER via the Phase-1
 * factory at the tier's retail price. An unavailable tier is NOT mounted as
 * payable — its path returns 409 (decline-before-charge; x402 has no refunds).
 *
 * The paid handler pays the supplier (fulfiller), builds the storefront Receipt
 * (revenue − wholesale = margin, both tx hashes guarded), emits one JSON log
 * line, and returns { profile, receipt }.
 */
import { pathToFileURL } from "node:url";
import type { Express, Request } from "express";
import type { PaymentRequest } from "@circle-fin/x402-batching/server";
import { createPaidApp, type PaidRoute } from "../money/x402-seller.ts";
import { Treasury } from "../money/treasury.ts";
import { DEPTHS, env, type Depth } from "../lib/env.ts";
import { StaticPricingProvider, type PricingProvider } from "./pricing.ts";
import { HttpPreviewClient, type PreviewClient } from "./engine-client.ts";
import { SupplierFulfiller, type Fulfiller } from "./fulfiller.ts";
import { buildReceipt } from "./receipt.ts";

export interface StorefrontDeps {
  pricing: PricingProvider;
  fulfiller: Fulfiller;
  preview: PreviewClient;
}

/** The per-depth paid handler — extracted so it is unit-testable offline. */
export function enrichHandler(fulfiller: Fulfiller, depth: Depth) {
  return async (body: unknown, req: Request) => {
    const { company, force_refresh } = (body ?? {}) as { company?: unknown; force_refresh?: unknown };
    if (typeof company !== "string" || company.trim() === "") {
      throw new Error("missing 'company' in request body");
    }
    const fulfilment = await fulfiller.fulfil({ company, depth, force_refresh: force_refresh === true });
    const payment = (req as unknown as PaymentRequest).payment;
    const receipt = buildReceipt({ company, payment, fulfilment });
    // One structured JSON log line per completed job (ledger ingests later).
    console.log(JSON.stringify({ event: "job.receipt", ...receipt }));
    return { profile: fulfilment.profile, receipt };
  };
}

export function buildStorefrontApp(deps: StorefrontDeps): Express {
  const { pricing, fulfiller, preview } = deps;

  const paidRoutes: PaidRoute[] = [];
  const declined: Depth[] = [];
  for (const depth of DEPTHS) {
    const info = pricing.priceFor(depth);
    if (!info.available) {
      declined.push(depth);
      continue;
    }
    paidRoutes.push({
      method: "post",
      path: `/v1/enrich/${depth}`,
      price: info.price_usdc,
      ownsResponse: true,
      handler: enrichHandler(fulfiller, depth),
    });
  }

  return createPaidApp({
    sellerAddress: env.treasuryAddress(),
    facilitatorUrl: env.facilitatorUrl(),
    networks: env.networkCaip2(),
    routes: paidRoutes,
    freeRoutes: (app) => {
      app.get("/healthz", (_req, res) => res.json({ ok: true }));

      app.get("/v1/enrich/schema", (_req, res) => {
        res.json({
          input: { company: "string", depth: "basic|standard|comprehensive" },
          output: "CompanyProfile",
          price_table: pricing.priceTable(),
          terms: "x402 USDC on Arc Testnet; decline-before-charge; no refunds.",
        });
      });

      app.post("/v1/preview", async (req, res) => {
        const { company } = (req.body ?? {}) as { company?: unknown };
        if (typeof company !== "string" || company.trim() === "") {
          res.status(400).json({ error: "missing 'company'" });
          return;
        }
        try {
          res.json(await preview.preview(company));
        } catch (err) {
          res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
        }
      });

      // decline-before-charge: an unavailable tier returns 409 — never a payable 402.
      for (const depth of declined) {
        app.post(`/v1/enrich/${depth}`, (_req, res) =>
          res.status(409).json({ error: `depth '${depth}' is currently unavailable` }),
        );
      }
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = env.storefrontPort();
  const app = buildStorefrontApp({
    pricing: new StaticPricingProvider(),
    fulfiller: new SupplierFulfiller(new Treasury()),
    preview: new HttpPreviewClient(env.engineUrl()),
  });
  app.listen(port, () => {
    console.log(`[storefront] x402 storefront on :${port} (seller=${env.treasuryAddress()}, supplier=${env.supplierUrl()})`);
  });
}
