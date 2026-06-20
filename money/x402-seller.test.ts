import { describe, it, expect, vi } from "vitest";
import { buildReceipt, wrapHandler, createPaidApp, type VerifiedPayment } from "./x402-seller.ts";

const payment = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  verified: true,
  payer: "0xBUYER",
  amount: "3000", // atomic USDC → 0.003
  network: "eip155:5042002",
  ...over,
});

function fakeRes() {
  const res: any = {};
  res.statusCode = 200;
  res.body = undefined;
  res.status = vi.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = vi.fn((b: unknown) => {
    res.body = b;
    return res;
  });
  return res;
}

describe("buildReceipt", () => {
  it("settled when a transaction hash is present", () => {
    expect(buildReceipt(payment({ transaction: "0xabc" }))).toEqual({
      paidBy: "0xBUYER",
      usdc: 0.003,
      txHash: "0xabc",
      settlement: "settled",
    });
  });

  it("pending-batch when transaction is undefined (guarded)", () => {
    const r = buildReceipt(payment({ transaction: undefined }));
    expect(r.txHash).toBeNull();
    expect(r.settlement).toBe("pending-batch");
  });

  it("zero/empty when payment is absent", () => {
    expect(buildReceipt(undefined)).toEqual({ paidBy: "", usdc: 0, txHash: null, settlement: "pending-batch" });
  });
});

describe("wrapHandler", () => {
  it("merges the handler result with the receipt", async () => {
    const req: any = { body: { hello: "world" }, payment: payment({ transaction: "0xtx" }) };
    const res = fakeRes();
    await wrapHandler((body) => ({ echoed: body }))(req, res);
    expect(res.json).toHaveBeenCalledOnce();
    expect(res.body).toEqual({ echoed: { hello: "world" }, receipt: { paidBy: "0xBUYER", usdc: 0.003, txHash: "0xtx", settlement: "settled" } });
  });

  it("surfaces a 502 (no silent success) when the handler throws", async () => {
    const req: any = { body: {}, payment: payment() };
    const res = fakeRes();
    await wrapHandler(() => {
      throw new Error("engine unreachable");
    })(req, res);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.body).toEqual({ error: "engine unreachable" });
  });
});

describe("createPaidApp", () => {
  it("constructs an Express app from a route list without touching the network", () => {
    const app = createPaidApp({
      sellerAddress: "0xSELLER",
      facilitatorUrl: "https://gateway-api-testnet.circle.com",
      networks: "eip155:5042002",
      routes: [{ method: "post", path: "/echo", price: "$0.001", handler: (b) => ({ echoed: b }) }],
    });
    expect(typeof app).toBe("function"); // an Express app is callable
  });
});
