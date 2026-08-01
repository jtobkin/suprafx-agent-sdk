import assert from "node:assert/strict";
import test from "node:test";
import type { SupraFxClient } from "../client.js";
import { SupraFxClient as Client } from "../client.js";
import type { DelegateSigner } from "../signer.js";
import { findTool, ToolError, type ToolContext } from "./tools.js";

const rfqId = "00000000-0000-0000-0000-000000000001";

test("a write tool without a signer returns NO_DELEGATE_CONFIGURED", async () => {
  const tool = findTool("cancel_rfq", false);
  assert.ok(tool);
  const ctx = { client: {} as SupraFxClient, signer: null };
  await assert.rejects(
    tool.handler({ rfq_id: rfqId }, ctx),
    (error: unknown) =>
      error instanceof ToolError &&
      error.code === "NO_DELEGATE_CONFIGURED" &&
      error.detail ===
        "run `suprafx-mcp init` or set SUPRAFX_DELEGATE_PRIV_HEX, then retry",
  );
});

test("cancel_rfq generates a distinct default reason per call", async () => {
  const reasons: string[] = [];
  const signer = {
    cancelRfq: async ({ reason }: { reason: string }) => {
      reasons.push(reason);
      return { ok: true };
    },
  } as unknown as DelegateSigner;
  const ctx: ToolContext = { client: {} as SupraFxClient, signer };
  const tool = findTool("cancel_rfq", true);
  assert.ok(tool);
  await tool.handler({ rfq_id: rfqId }, ctx);
  await tool.handler({ rfq_id: rfqId }, ctx);
  assert.match(reasons[0], /^agent_cancel-/);
  assert.notEqual(reasons[0], reasons[1]);
});

test("cancel_rfq leaves an explicit reason untouched", async () => {
  let received = "";
  const signer = {
    cancelRfq: async ({ reason }: { reason: string }) => {
      received = reason;
      return { ok: true };
    },
  } as unknown as DelegateSigner;
  const ctx: ToolContext = { client: {} as SupraFxClient, signer };
  const tool = findTool("cancel_rfq", true);
  assert.ok(tool);
  await tool.handler({ rfq_id: rfqId, reason: "operator-requested" }, ctx);
  assert.equal(received, "operator-requested");
});

test("get_setup_status remains available without a signer", async () => {
  const client = {
    getChainInfo: async () => ({
      chainId: "test-chain",
      chainIdHashHex: "00".repeat(32),
      threshold: 1,
    }),
    getVenueClockOffsetMs: async () => 0,
  } as unknown as SupraFxClient;
  const tool = findTool("get_setup_status", false);
  assert.ok(tool);
  const result = await tool.handler({}, { client, signer: null }) as Record<
    string,
    { status: string; detail: string; remedy: string }
  >;
  assert.equal(result.chain_reachable.status, "ok");
  assert.equal(result.delegate_key.status, "fail");
  for (const field of Object.values(result)) {
    assert.equal(typeof field.detail, "string");
    assert.equal(typeof field.remedy, "string");
  }
});

test("venue clock offset uses the Date header and is cached", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return new Response("{}", {
      headers: { date: "Thu, 01 Jan 2026 00:02:00 GMT" },
    });
  };
  Date.now = () => Date.parse("Thu, 01 Jan 2026 00:00:00 GMT");
  try {
    const client = new Client({ baseUrl: "https://venue.test" });
    assert.equal(await client.getVenueClockOffsetMs(), 120_000);
    assert.equal(await client.getVenueClockOffsetMs(), 120_000);
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("venue clock offset falls back to zero for an invalid Date header", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", {
    headers: { date: "not-a-date" },
  });
  try {
    const client = new Client({ baseUrl: "https://venue.test" });
    assert.equal(await client.getVenueClockOffsetMs(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("submit_rfq uses venue-aligned expiry and warns only beyond 60 seconds", async () => {
  const originalNow = Date.now;
  const originalError = console.error;
  const warnings: string[] = [];
  Date.now = () => 1_000_000;
  console.error = (message?: unknown) => warnings.push(String(message));
  let offsetMs = 60_000;
  const expiries: bigint[] = [];
  const client = {
    listAssets: async () => [
      { chain_id: "ethereum", asset_symbol: "ETH", contract_address: null, decimals: 18 },
      { chain_id: "ethereum", asset_symbol: "USDC", contract_address: null, decimals: 6 },
    ],
    getCurrentBatch: async () => 1,
    getVenueClockOffsetMs: async () => offsetMs,
  } as unknown as SupraFxClient;
  const signer = {
    submitRfq: async ({ expires_at_ms }: { expires_at_ms: bigint }) => {
      expiries.push(expires_at_ms);
      return { ok: true };
    },
  } as unknown as DelegateSigner;
  const tool = findTool("submit_rfq", true);
  assert.ok(tool);
  const args = {
    sell_chain: "eth-mainnet",
    sell_token: "ETH",
    buy_chain: "eth-mainnet",
    buy_token: "USDC",
    size: 1,
    reference_price: 2000,
    expires_in_minutes: 30,
  };
  try {
    await tool.handler(args, { client, signer });
    assert.equal(expiries[0], 2_860_000n);
    assert.deepEqual(warnings, []);

    offsetMs = 60_001;
    await tool.handler(args, { client, signer });
    assert.equal(expiries[1], 2_860_001n);
    assert.deepEqual(warnings, [
      "local clock skewed by 61s vs venue; using server-aligned expiry",
    ]);
  } finally {
    Date.now = originalNow;
    console.error = originalError;
  }
});

test("get_setup_status reports clock skew beyond 60 seconds", async () => {
  const client = {
    getChainInfo: async () => ({
      chainId: "test-chain",
      chainIdHashHex: "00".repeat(32),
      threshold: 1,
    }),
    getVenueClockOffsetMs: async () => -60_001,
  } as unknown as SupraFxClient;
  const tool = findTool("get_setup_status", false);
  assert.ok(tool);
  const result = await tool.handler({}, { client, signer: null }) as Record<
    string,
    { status: string; detail: string; remedy: string }
  >;
  assert.equal(result.clock_skew.status, "warn");
  assert.match(result.clock_skew.detail, /-61s/);
  assert.equal(result.clock_skew.remedy, "sync your system clock (NTP)");
});
