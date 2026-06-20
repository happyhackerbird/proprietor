/**
 * x402-seller.ts (D5) — the reusable paid-route factory.
 *
 * `createPaidApp({ sellerAddress, facilitatorUrl, networks, routes })` returns
 * an Express app that mounts each handler behind `gateway.require(price)` from
 * `@circle-fin/x402-batching`. On handler success it returns
 * `{ ...handlerResult, receipt }` built from the verified `req.payment`,
 * GUARDING `transaction === undefined` (→ "pending-batch"). On handler failure
 * it surfaces a 502 — decline-before-charge happens upstream in the middleware;
 * we never fake success after the charge, and never blind-retry.
 *
 * The echo seller, the supplier-agent, and the storefront all reuse THIS
 * factory — x402 is implemented once.
 */
import express, { type Request, type Response } from "express";
import { createGatewayMiddleware, type PaymentRequest } from "@circle-fin/x402-batching/server";

export type HttpMethod = "get" | "post" | "put" | "delete" | "patch";

export interface PaidRoute {
  method: HttpMethod;
  path: string;
  /** Price string accepted by gateway.require, e.g. "$0.001". */
  price: string;
  /** Business handler; its returned object is merged with the receipt. */
  handler: (body: unknown, req: Request) => Promise<unknown> | unknown;
  /**
   * When true, the handler OWNS the full response (it built its own richer
   * receipt) — the factory returns the handler result verbatim and does not
   * append the default receipt. Used by the storefront (D8/D9). Default false:
   * simple sellers (echo, supplier) get the default receipt appended.
   */
  ownsResponse?: boolean;
}

export interface PaidAppConfig {
  sellerAddress: string;
  facilitatorUrl?: string;
  networks?: string | string[];
  routes: PaidRoute[];
  /** Optional extra (free) routes mounted before the paid ones (e.g. /healthz). */
  freeRoutes?: (app: express.Express) => void;
}

export type Settlement = "settled" | "pending-batch";

export interface Receipt {
  paidBy: string;
  usdc: number;
  txHash: string | null;
  settlement: Settlement;
}

/** The verified payment the gateway attaches to the request. */
export type VerifiedPayment = NonNullable<PaymentRequest["payment"]>;

/** Build the receipt from req.payment, guarding the optional settlement tx hash. */
export function buildReceipt(payment?: VerifiedPayment): Receipt {
  const txHash = payment?.transaction ?? null;
  return {
    paidBy: payment?.payer ?? "",
    usdc: payment ? Number(payment.amount) / 1e6 : 0,
    txHash,
    settlement: txHash ? "settled" : "pending-batch",
  };
}

/** Wrap a business handler into an Express handler that appends the receipt. */
export function wrapHandler(handler: PaidRoute["handler"], ownsResponse = false) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await handler(req.body, req);
      if (ownsResponse) {
        // Handler built its own (richer) response/receipt — return it verbatim.
        res.json(result);
        return;
      }
      const payment = (req as unknown as PaymentRequest).payment;
      res.json({ ...(result as Record<string, unknown>), receipt: buildReceipt(payment) });
    } catch (err) {
      // The buyer was already charged (x402, no refund); surface the failure
      // explicitly. Never return a success-shaped body, never blind-retry.
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}

export function createPaidApp(config: PaidAppConfig): express.Express {
  const app = express();
  app.use(express.json());

  config.freeRoutes?.(app);

  const gateway = createGatewayMiddleware({
    sellerAddress: config.sellerAddress,
    facilitatorUrl: config.facilitatorUrl,
    networks: config.networks,
  });

  for (const route of config.routes) {
    app[route.method](route.path, gateway.require(route.price), wrapHandler(route.handler, route.ownsResponse));
  }

  return app;
}
