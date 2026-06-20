import { describe, it, expect, vi } from "vitest";
import { researchHandler, buildSupplierApp } from "./research-seller.ts";
import type { EngineClient, EnrichResponse, EnrichRequest } from "./engine-client.ts";

const fakeResponse = (depth: EnrichRequest["depth"]): EnrichResponse => ({
  profile: { company: "stripe.com", confidence: 0.9, basics: {}, product: {}, funding: {}, hiring: {}, news: {} },
  cost: { tavily_searches: 3, nebius_calls: 5, nebius_tokens: 1200, est_usd: 0.0156 },
  cache_hit: false,
  depth_served: depth,
});

function fakeEngine(): EngineClient & { calls: EnrichRequest[] } {
  const calls: EnrichRequest[] = [];
  return {
    calls,
    enrich: vi.fn(async (req: EnrichRequest) => {
      calls.push(req);
      return fakeResponse(req.depth);
    }),
    preview: vi.fn(async () => ({ disambiguation_choices: [] })),
  };
}

describe("researchHandler", () => {
  it("calls the engine with company + path-depth and returns the profile + cost", async () => {
    const engine = fakeEngine();
    const out = await researchHandler(engine, "standard")({ company: "stripe.com" });
    expect(engine.calls[0]).toEqual({ company: "stripe.com", depth: "standard", force_refresh: false });
    expect(out).toEqual({
      profile: fakeResponse("standard").profile,
      cost: fakeResponse("standard").cost,
      cache_hit: false,
      depth_served: "standard",
    });
  });

  it("passes force_refresh through only when strictly true", async () => {
    const engine = fakeEngine();
    await researchHandler(engine, "comprehensive")({ company: "x", force_refresh: true });
    expect(engine.calls[0].force_refresh).toBe(true);
    await researchHandler(engine, "comprehensive")({ company: "x", force_refresh: "yes" });
    expect(engine.calls[1].force_refresh).toBe(false);
  });

  it("rejects a missing/blank company (before any engine call)", async () => {
    const engine = fakeEngine();
    await expect(researchHandler(engine, "basic")({})).rejects.toThrow(/missing 'company'/);
    await expect(researchHandler(engine, "basic")({ company: "  " })).rejects.toThrow(/missing 'company'/);
    expect(engine.enrich).not.toHaveBeenCalled();
  });
});

describe("buildSupplierApp", () => {
  it("constructs an Express app with the three per-depth routes", () => {
    const app = buildSupplierApp(fakeEngine());
    expect(typeof app).toBe("function");
  });
});
