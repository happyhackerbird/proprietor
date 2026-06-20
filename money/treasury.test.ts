import { describe, it, expect } from "vitest";
import { Treasury, decodeReceiptTxHash, unwrap, type CliRunner, type CodeFetcher } from "./treasury.ts";

/** Records every argv it is called with and returns a canned response per command. */
function fakeRunner(responses: Record<string, string>): { run: CliRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CliRunner = async (args) => {
    calls.push(args);
    const key = args.slice(0, 3).join(" "); // e.g. "wallet create --type"… use first tokens
    for (const [prefix, body] of Object.entries(responses)) {
      if (args.join(" ").includes(prefix)) return body;
    }
    throw new Error(`no fake response for: ${args.join(" ")} (key ${key})`);
  };
  return { run, calls };
}

const codeFetcher = (code: string): CodeFetcher => async () => code;

// base64 of {"transaction":"0xdeadbeef"}
const SAMPLE_RECEIPT = Buffer.from(JSON.stringify({ transaction: "0xdeadbeef" })).toString("base64");

describe("decodeReceiptTxHash", () => {
  it("base64-decodes a receipt to the tx hash", () => {
    expect(decodeReceiptTxHash(SAMPLE_RECEIPT)).toBe("0xdeadbeef");
  });
  it("returns undefined for absent/garbage/empty-transaction receipts", () => {
    expect(decodeReceiptTxHash(undefined)).toBeUndefined();
    expect(decodeReceiptTxHash("not-base64-json")).toBeUndefined();
    expect(decodeReceiptTxHash(Buffer.from(JSON.stringify({})).toString("base64"))).toBeUndefined();
  });
});

describe("unwrap", () => {
  it("unwraps the { data: … } envelope", () => {
    expect(unwrap<{ a: number }>(JSON.stringify({ data: { a: 1 } }))).toEqual({ a: 1 });
  });
  it("passes through payloads without a data key", () => {
    expect(unwrap<{ payment: unknown }>(JSON.stringify({ payment: { amount: "1" } }))).toEqual({ payment: { amount: "1" } });
  });
});

describe("Treasury argv", () => {
  it("createWallet builds the testnet agent-create argv and parses the address", async () => {
    const { run, calls } = fakeRunner({ "wallet create": JSON.stringify({ data: { address: "0xNEW" } }) });
    const t = new Treasury(run, codeFetcher("0x"), "http://rpc");
    expect(await t.createWallet()).toEqual({ address: "0xNEW" });
    expect(calls[0]).toEqual(["wallet", "create", "--type", "agent", "--testnet", "--output", "json"]);
  });

  it("listWallets builds the list argv and parses the wallets array", async () => {
    const { run, calls } = fakeRunner({
      "wallet list": JSON.stringify({ data: { wallets: [{ address: "0xA" }, { address: "0xB" }] } }),
    });
    const t = new Treasury(run, codeFetcher("0x"), "http://rpc");
    expect(await t.listWallets("ARC-TESTNET")).toHaveLength(2);
    expect(calls[0]).toEqual(["wallet", "list", "--type", "agent", "--chain", "ARC-TESTNET", "--output", "json"]);
  });

  it("payService builds the pay argv and decodes the receipt tx hash", async () => {
    const { run, calls } = fakeRunner({
      "services pay": JSON.stringify({ response: { ok: true }, payment: { amount: "3000", receipt: SAMPLE_RECEIPT } }),
    });
    const t = new Treasury(run, codeFetcher("0x"), "http://rpc");
    const res = await t.payService({
      url: "http://seller/echo",
      address: "0xBUYER",
      chain: "ARC-TESTNET",
      method: "POST",
      data: { hi: 1 },
      maxAmount: "0.01",
    });
    expect(res).toEqual({ response: { ok: true }, amount: "3000", txHash: "0xdeadbeef" });
    expect(calls[0]).toEqual([
      "services", "pay", "http://seller/echo",
      "--address", "0xBUYER", "--chain", "ARC-TESTNET",
      "-X", "POST", "-d", JSON.stringify({ hi: 1 }),
      "--max-amount", "0.01", "--output", "json",
    ]);
  });

  it("payService yields txHash=undefined under batched settlement (no receipt)", async () => {
    const { run } = fakeRunner({ "services pay": JSON.stringify({ response: {}, payment: { amount: "3000" } }) });
    const t = new Treasury(run, codeFetcher("0x"), "http://rpc");
    const res = await t.payService({ url: "u", address: "0xB" });
    expect(res.txHash).toBeUndefined();
    expect(res.amount).toBe("3000");
  });
});

describe("Treasury deploy / isDeployed", () => {
  it("isDeployed is false for empty code, true for non-empty", async () => {
    const t0 = new Treasury(async () => "{}", codeFetcher("0x"), "http://rpc");
    expect(await t0.isDeployed("0xA")).toBe(false);
    const t1 = new Treasury(async () => "{}", codeFetcher("0x60806040"), "http://rpc");
    expect(await t1.isDeployed("0xA")).toBe(true);
  });

  it("deployWallet short-circuits when already deployed (no transfer call)", async () => {
    const { run, calls } = fakeRunner({});
    const t = new Treasury(run, codeFetcher("0x60806040"), "http://rpc");
    expect(await t.deployWallet("0xA", "ARC-TESTNET")).toEqual({ deployed: true });
    expect(calls).toHaveLength(0);
  });

  it("deployWallet issues the zero-value self-transfer when undeployed", async () => {
    const { run, calls } = fakeRunner({ "wallet transfer": JSON.stringify({ data: { id: "tx-123" } }) });
    // first isDeployed=false (pre-transfer), then true (poll) — flip after first call
    let codeCalls = 0;
    const flipping: CodeFetcher = async () => (codeCalls++ === 0 ? "0x" : "0x60806040");
    const t = new Treasury(run, flipping, "http://rpc");
    const res = await t.deployWallet("0xSELF", "ARC-TESTNET");
    expect(res).toEqual({ deployed: true, txId: "tx-123" });
    expect(calls[0]).toEqual([
      "wallet", "transfer", "0xSELF", "--amount", "0", "--address", "0xSELF", "--chain", "ARC-TESTNET", "--output", "json",
    ]);
  });
});
