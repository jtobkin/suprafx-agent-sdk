import assert from "node:assert/strict";
import test from "node:test";
import type { SupraFxClient } from "../client.js";
import { SupraFxClient as Client } from "../client.js";
import type { DelegateSigner } from "../signer.js";
import { findTool, ToolError, type ToolContext } from "./tools.js";

/**
 * NOTE (guarded gate): money tools now require `acknowledged: true` per
 * call unless the server was launched autonomous (`--allow-dangerous`).
 * These tests exercise handler behaviour, not the gate — they pass
 * `mode: "autonomous"` in the context so the gate is not the thing under
 * test. The gate itself is covered in `test/regressions.test.ts`.
 */

// These handlers drive stub clients with no orderbook, so apply-confirmation
// has nothing to read. Skip the confirmation poll entirely — the lifecycle
// contract itself is covered in `test/regressions.test.ts`.
process.env.SUPRAFX_APPLY_POLL_MS = "0";

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
  const ctx: ToolContext = { client: {} as SupraFxClient, signer, mode: "autonomous" };
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
  const ctx: ToolContext = { client: {} as SupraFxClient, signer, mode: "autonomous" };
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
    await tool.handler(args, { client, signer, mode: "autonomous" as const });
    assert.equal(expiries[0], 2_860_000n);
    assert.deepEqual(warnings, []);

    offsetMs = 60_001;
    await tool.handler(args, { client, signer, mode: "autonomous" as const });
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

// ─── get_deposit_status ───────────────────────────────────────────
//
// The tool exists so an agent can tell "still crediting" from "failed"
// without looping on balances. These pin its routing: a (chain, tx_hash)
// pair reads ONE claim, nothing lists the configured master, and a half
// key is refused instead of silently becoming a list.

test("get_deposit_status reads one claim when chain and tx_hash are both given", async () => {
  const seen: unknown[] = [];
  const client = {
    getDepositStatus: async (chain: string, txHash: string) => {
      seen.push([chain, txHash]);
      return { found: true, claim: { state: "pending", stale: true } };
    },
    listDepositClaims: async () => { throw new Error("must not list"); },
  } as unknown as SupraFxClient;
  const tool = findTool("get_deposit_status", false);
  assert.ok(tool);
  assert.equal(tool.requiresSigner, false);
  const out = (await tool.handler({ chain: " supra ", tx_hash: "0xabc" }, { client, signer: null })) as any;
  assert.deepEqual(seen, [["supra", "0xabc"]]);
  assert.equal(out.claim.stale, true);
});

test("get_deposit_status with no key lists the configured master's claims", async () => {
  const seen: unknown[] = [];
  const client = {
    getDepositStatus: async () => { throw new Error("must not read one"); },
    listDepositClaims: async (address: string, limit: number) => {
      seen.push([address, limit]);
      return { address, claims: [], counts: { pending: 0, stale: 0, credited: 0, rejected: 0, expired: 0 }, truncated: false };
    },
  } as unknown as SupraFxClient;
  const tool = findTool("get_deposit_status", false);
  assert.ok(tool);
  await tool.handler({}, { client, signer: null, masterAddress: "0xmaster" });
  await tool.handler({ address: "0xother", limit: 5 }, { client, signer: null, masterAddress: "0xmaster" });
  assert.deepEqual(seen, [["0xmaster", 20], ["0xother", 5]]);
});

test("get_deposit_status refuses a half key rather than silently listing", async () => {
  const tool = findTool("get_deposit_status", false);
  assert.ok(tool);
  const ctx = { client: {} as SupraFxClient, signer: null, masterAddress: "0xmaster" };
  await assert.rejects(
    tool.handler({ chain: "supra" }, ctx),
    (e: unknown) => e instanceof ToolError && e.code === "INVALID_ARGS",
  );
  await assert.rejects(
    tool.handler({ tx_hash: "0xabc" }, ctx),
    (e: unknown) => e instanceof ToolError && e.code === "INVALID_ARGS",
  );
});

test("get_deposit_status without a master and without a key says exactly what to set", async () => {
  const tool = findTool("get_deposit_status", false);
  assert.ok(tool);
  await assert.rejects(
    tool.handler({}, { client: {} as SupraFxClient, signer: null }),
    (e: unknown) => e instanceof ToolError && e.code === "NO_MASTER_ADDRESS" && /SUPRAFX_MASTER_ADDRESS/.test(e.remedy),
  );
});
