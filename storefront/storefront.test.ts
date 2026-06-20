import { describe, it, expect, vi, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { buildReceipt } from "./receipt.ts";
import { StaticPricingProvider } from "./pricing.ts";
import { enrichHandler, buildStorefrontApp } from "./server.ts";
import type { Fulfiller, FulfilResult } from "./fulfiller.ts";
import type { PreviewClient } from "./engine-client.ts";
import type { VerifiedPayment } from "../money/x402-seller.ts";

const fulfilResult = (over: Partial<FulfilResult> = {}): FulfilResult => ({
  profile: { company: "stripe.com", confidence: 0.9, basics: {}, product: {}, funding: {}, hiring: {}, news: {} },
  cost: { tavily_searches: 3, nebius_calls: 5, nebius_tokens: 1200, est_usd: 0.0156 },
  cache_hit: false,
  depth_served: "standard",
  wholesale_usdc: 0.015,
  supplier_tx_hash: "0xSUPPLIER",
  ...over,
});

const payment = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  verified: true,
  payer: "0xBUYER",
  amount: "30000", // atomic → 0.03 retail
  network: "eip155:5042002",
  transaction: "0xREVENUE",
  ...over,
});

function fakeFulfiller(result = fulfilResult()): Fulfiller & { calls: unknown[] } {
  const calls: unknown[] = [];
  return { calls, fulfil: vi.fn(async (i) => { calls.push(i); return result; }) };
}

describe("buildReceipt", () => {
  it("margin = revenue − wholesale; both tx hashes carried; settled when supplier tx present", () => {
    const r = buildReceipt({ company: "stripe.com", payment: payment(), fulfilment: fulfilResult() });
    expect(r.revenue_usdc).toBe(0.03);
    expect(r.wholesale_usdc).toBe(0.015);
    expect(r.margin_usdc).toBe(0.015);
    expect(r.revenue_tx_hash).toBe("0xREVENUE");
    expect(r.supplier_tx_hash).toBe("0xSUPPLIER");
    expect(r.settlement).toBe("settled");
    expect(r.cost.source).toBe("onchain");
  });

  it("pending-batch when the supplier tx hash is null (guarded)", () => {
    const r = buildReceipt({ company: "x", payment: payment(), fulfilment: fulfilResult({ supplier_tx_hash: null }) });
    expect(r.settlement).toBe("pending-batch");
    expect(r.supplier_tx_hash).toBeNull();
  });
});

describe("StaticPricingProvider", () => {
  it("reports availability and a price table", () => {
    const p = new StaticPricingProvider(new Set(["comprehensive"]));
    expect(p.priceFor("standard").available).toBe(true);
    expect(p.priceFor("comprehensive").available).toBe(false);
    const table = p.priceTable();
    expect(table).toHaveProperty("basic");
    expect(table).toHaveProperty("standard");
    expect(table).toHaveProperty("comprehensive");
  });
});

describe("enrichHandler", () => {
  it("pays the supplier via the fulfiller and returns { profile, receipt }", async () => {
    const f = fakeFulfiller();
    const req: any = { payment: payment() };
    const out: any = await enrichHandler(f, "standard")({ company: "stripe.com" }, req);
    expect(f.calls[0]).toEqual({ company: "stripe.com", depth: "standard", force_refresh: false });
    expect(out.profile.company).toBe("stripe.com");
    expect(out.receipt.margin_usdc).toBe(0.015);
  });

  it("rejects a missing company before paying", async () => {
    const f = fakeFulfiller();
    await expect(enrichHandler(f, "basic")({}, {} as any)).rejects.toThrow(/missing 'company'/);
    expect(f.fulfil).not.toHaveBeenCalled();
  });
});

describe("storefront HTTP (free routes + decline-before-charge)", () => {
  let server: ReturnType<ReturnType<typeof buildStorefrontApp>["listen"]> | undefined;
  afterEach(() => server?.close());

  async function start(unavailable: Parameters<typeof StaticPricingProvider.prototype.priceFor>[0][] = []) {
    const preview: PreviewClient = { preview: vi.fn(async (c: string) => ({ disambiguation_choices: [{ id: "1", display_name: c }] })) };
    const app = buildStorefrontApp({
      pricing: new StaticPricingProvider(new Set(unavailable)),
      fulfiller: fakeFulfiller(),
      preview,
    });
    return await new Promise<{ base: string }>((resolve) => {
      server = app.listen(0, () => {
        const port = (server!.address() as AddressInfo).port;
        resolve({ base: `http://127.0.0.1:${port}` });
      });
    });
  }

  it("GET /healthz → 200 { ok:true }", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /v1/enrich/schema → price table", async () => {
    const { base } = await start();
    const body = (await (await fetch(`${base}/v1/enrich/schema`)).json()) as { price_table: Record<string, string> };
    expect(body.price_table).toHaveProperty("standard");
  });

  it("POST /v1/preview proxies the engine (free)", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/v1/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company: "acme" }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { disambiguation_choices: unknown[] }).disambiguation_choices).toHaveLength(1);
  });

  it("decline-before-charge: an unavailable tier → 409, NOT a payable 402", async () => {
    const { base } = await start(["comprehensive"]);
    const res = await fetch(`${base}/v1/enrich/comprehensive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company: "x" }) });
    expect(res.status).toBe(409);
  });
});
