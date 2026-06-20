/**
 * treasury.ts (D4) — a typed wrapper over the Circle CLI (`circle …`).
 *
 * The CLI runner and the eth_getCode fetcher are INJECTED so the whole module
 * is unit-testable offline (tests assert the exact argv and the receipt decode
 * with zero real CLI/RPC calls). `--output json` is always passed; the
 * `{ data: … }` envelope is unwrapped.
 *
 * Wallets are counterfactual SCAs — `deployWallet` runs the zero-value
 * self-transfer that deploys them on a chain, then polls eth_getCode (step 0).
 * `payService` decodes the base64 `payment.receipt` to the settlement tx hash,
 * which is OPTIONAL under batched settlement (returned as `txHash?`).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../lib/env.ts";

const execFileAsync = promisify(execFile);

const POLL_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 1500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type CliRunner = (args: string[]) => Promise<string>;
export type CodeFetcher = (address: string, rpcUrl: string) => Promise<string>;

export interface WalletInfo {
  type?: string;
  address: string;
  blockchain?: string;
  createDate?: string;
}

export interface PayServiceArgs {
  url: string;
  address: string;
  chain?: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  data?: unknown;
  maxAmount?: string | number;
}

export interface PayResult {
  response: unknown;
  amount?: string;
  txHash?: string;
}

/** Raw `circle services pay --output json` payload shape. */
interface PayPayload {
  response?: unknown;
  payment?: { amount?: string; receipt?: string };
}

/** Default runner: spawn `circle <args>` and return stdout. */
export const defaultCliRunner: CliRunner = async (args) => {
  const { stdout } = await execFileAsync("circle", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

/** Default eth_getCode over JSON-RPC (no library, just fetch). */
export const defaultCodeFetcher: CodeFetcher = async (address, rpcUrl) => {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
  });
  const json = (await res.json()) as { result?: string; error?: unknown };
  if (json.error) throw new Error(`eth_getCode failed: ${JSON.stringify(json.error)}`);
  return json.result ?? "0x";
};

/** Unwrap the CLI's `{ data: … }` envelope; pass through payloads without it. */
export function unwrap<T>(stdout: string): T {
  const parsed = JSON.parse(stdout) as unknown;
  if (parsed && typeof parsed === "object" && "data" in (parsed as Record<string, unknown>)) {
    return (parsed as { data: T }).data;
  }
  return parsed as T;
}

/** Decode the base64 `payment.receipt` → `{ transaction }` → tx hash (or undefined). */
export function decodeReceiptTxHash(receipt?: string): string | undefined {
  if (!receipt) return undefined;
  try {
    const decoded = Buffer.from(receipt, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as { transaction?: string };
    return parsed.transaction || undefined;
  } catch {
    return undefined;
  }
}

export class Treasury {
  constructor(
    private readonly run: CliRunner = defaultCliRunner,
    private readonly fetchCode: CodeFetcher = defaultCodeFetcher,
    private readonly rpcUrl: string = env.rpcUrl(),
  ) {}

  async createWallet(): Promise<{ address: string }> {
    const data = unwrap<{ address: string }>(
      await this.run(["wallet", "create", "--type", "agent", "--testnet", "--output", "json"]),
    );
    return { address: data.address };
  }

  async listWallets(chain: string = env.chain()): Promise<WalletInfo[]> {
    const data = unwrap<{ wallets: WalletInfo[] }>(
      await this.run(["wallet", "list", "--type", "agent", "--chain", chain, "--output", "json"]),
    );
    return data.wallets ?? [];
  }

  async getBalance(address: string, chain: string = env.chain()): Promise<unknown> {
    return unwrap(await this.run(["wallet", "balance", "--address", address, "--chain", chain, "--output", "json"]));
  }

  /** Deployed iff eth_getCode is non-empty (counterfactual SCA → "0x"). */
  async isDeployed(address: string, _chain: string = env.chain()): Promise<boolean> {
    const code = await this.fetchCode(address, this.rpcUrl);
    return code != null && code !== "0x" && code !== "0x0" && code !== "";
  }

  /** Deploy the SCA via a zero-value self-transfer, then poll until eth_getCode is non-empty. */
  async deployWallet(address: string, chain: string = env.chain()): Promise<{ deployed: boolean; txId?: string }> {
    if (await this.isDeployed(address, chain)) return { deployed: true };
    const data = unwrap<{ id?: string; transactionId?: string }>(
      await this.run(["wallet", "transfer", address, "--amount", "0", "--address", address, "--chain", chain, "--output", "json"]),
    );
    const txId = data.id ?? data.transactionId;
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      if (await this.isDeployed(address, chain)) return { deployed: true, txId };
      await sleep(POLL_INTERVAL_MS);
    }
    return { deployed: false, txId };
  }

  /** Plain USDC send. Returns the (async) transaction id. */
  async transfer(to: string, amount: string | number, from: string, chain: string = env.chain()): Promise<unknown> {
    return unwrap(
      await this.run(["wallet", "transfer", to, "--amount", String(amount), "--address", from, "--chain", chain, "--output", "json"]),
    );
  }

  /** Pay an x402 service; decode the receipt to the settlement tx hash (may be undefined → batched). */
  async payService(argsIn: PayServiceArgs): Promise<PayResult> {
    const { url, address, chain = env.chain(), method = "POST", data, maxAmount } = argsIn;
    const args = ["services", "pay", url, "--address", address, "--chain", chain, "-X", method];
    if (data !== undefined) args.push("-d", typeof data === "string" ? data : JSON.stringify(data));
    if (maxAmount !== undefined) args.push("--max-amount", String(maxAmount));
    args.push("--output", "json");
    const payload = unwrap<PayPayload>(await this.run(args));
    return {
      response: payload.response,
      amount: payload.payment?.amount,
      txHash: decodeReceiptTxHash(payload.payment?.receipt),
    };
  }

  /** Inspect a paid endpoint: price + input schema. */
  async inspectService(url: string): Promise<unknown> {
    return unwrap(await this.run(["services", "inspect", url, "--output", "json"]));
  }
}

/** Default instance using the real CLI + RPC. */
export const treasury = new Treasury();
