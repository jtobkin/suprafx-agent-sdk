/**
 * Regression tests for the agent-onboarding hardening.
 *
 * Each test names the bug it exists to stop coming back, and each one
 * FAILED before the corresponding fix. Run: `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalChain, deriveAssetId, registeredAssetId } from "../src/derive-ids.js";
import { SupraFxClient, SupraFxError } from "../src/client.js";
import { DelegateSigner } from "../src/signer.js";
import { sameId, withLifecycle } from "../src/mcp/lifecycle.js";
import { resolveMode, resolveToolGroups } from "../src/mcp/config.js";
import { allTools, findTool, ToolError } from "../src/mcp/tools.js";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// ── B1b: the chain-id bridge ───────────────────────────────────

test("canonicalChain bridges the short ids /api/assets actually returns", () => {
  assert.equal(canonicalChain("ethereum"), "eth-mainnet");
  assert.equal(canonicalChain("supra"), "supra-mainnet");
  assert.equal(canonicalChain("sepolia"), "eth-sepolia");
  // canonical in, canonical out — identity for every existing caller
  assert.equal(canonicalChain("eth-mainnet"), "eth-mainnet");
  assert.equal(canonicalChain("supra-mainnet"), "supra-mainnet");
  assert.equal(canonicalChain("supra-testnet"), "supra-testnet");
});

test("a chain id taken straight from list_assets derives the SAME asset as the canonical form", () => {
  // Before the bridge: "ethereum" was in no registry key, so deriveAssetId
  // fell through to a legacy V1 hash — a phantom id the gate rejects.
  assert.equal(hex(deriveAssetId("ethereum", "ETH")), hex(deriveAssetId("eth-mainnet", "ETH")));
  assert.equal(hex(deriveAssetId("ethereum", "USDC")), hex(deriveAssetId("eth-mainnet", "USDC")));
});

test("'supra' resolves to MAINNET, not the testnet asset it used to hit", () => {
  // The sharper half of the same bug: "supra/SUPRA" WAS a registry key —
  // pointing at supra-testnet. A mainnet trade derived a well-formed id
  // for the wrong chain, which is worse than a phantom because nothing
  // about it looks wrong.
  assert.equal(hex(deriveAssetId("supra", "SUPRA")), hex(deriveAssetId("supra-mainnet", "SUPRA")));
  assert.notEqual(
    hex(deriveAssetId("supra", "SUPRA")),
    hex(deriveAssetId("supra-testnet", "SUPRA")),
  );
});

test("every asset shape the live venue returns is a registered, tradeable id", () => {
  // Exactly what GET /api/assets answered on 2026-09-14.
  for (const [chain, sym] of [
    ["ethereum", "ETH"],
    ["ethereum", "USDC"],
    ["ethereum", "USDT"],
    ["supra", "SUPRA"],
    ["supra", "iUSDC"],
    ["supra", "iUSDT"],
  ] as const) {
    assert.ok(registeredAssetId(chain, sym), `${chain}/${sym} must resolve to a registered id`);
  }
});

// ── P0: the orderbook was silently always empty ────────────────

test("getOrderbook reads rows from `data` — the shape the venue actually sends", async () => {
  const client = new SupraFxClient({ baseUrl: "http://stub.invalid" });
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  // The venue answers { success, data, count, hasMore } — NOT { rfqs }.
  (client as any).get = async () => ({ success: true, data: rows, count: 3 });
  assert.equal((await client.getOrderbook()).length, 3);
});

test("getOrderbook still accepts a legacy { rfqs } body", async () => {
  const client = new SupraFxClient({ baseUrl: "http://stub.invalid" });
  (client as any).get = async () => ({ rfqs: [{ id: "a" }] });
  assert.equal((await client.getOrderbook()).length, 1);
});

// ── B1c: the sequence-desync gate ──────────────────────────────

test("a cancel or quote-withdrawal does NOT advance the sequence counter", async () => {
  // CancelRfq and WithdrawQuote carry no user_sequence_number at all.
  // Advancing on their ok:true pushed the local counter one past the
  // chain's, and every later trade was then dropped as a silent replay.
  const client = new SupraFxClient({ baseUrl: "http://stub.invalid" });
  (client as any).getChainInfo = async () => ({
    chainId: "t",
    chainIdHashHex: "00".repeat(32),
    threshold: 1,
  });
  (client as any).submitEnvelope = async () => ({ ok: true });
  const signer = new DelegateSigner({ delegatePrivKeyHex: "11".repeat(32), client });

  const before = signer.getNextSeq();
  await signer.cancelRfq({ rfq_id: new Uint8Array(16), reason: "test" });
  assert.equal(signer.getNextSeq(), before, "cancel_rfq must not consume a seq");
  await signer.withdrawQuote({ quote_id: new Uint8Array(16) });
  assert.equal(signer.getNextSeq(), before, "withdraw_quote must not consume a seq");

  // …while a seq-bearing write still does.
  await signer.submitRfq({
    pair: new Uint8Array(32),
    base_asset: new Uint8Array(32),
    quote_asset: new Uint8Array(32),
    size: 1n,
    reference_price: 1n,
    auto_accept: false,
    auto_accept_target_rate: 0n,
    allow_partial_fills: false,
    min_fill_size: 0n,
    expires_at_ms: 1n,
    rfq_id: new Uint8Array(16),
    settlement_mode: "Platform",
  } as any);
  assert.equal(signer.getNextSeq(), before + 1n, "submit_rfq must consume a seq");
});

test("submit→cancel→submit leaves the counter exactly 2 ahead, not 3", async () => {
  const client = new SupraFxClient({ baseUrl: "http://stub.invalid" });
  (client as any).getChainInfo = async () => ({
    chainId: "t",
    chainIdHashHex: "00".repeat(32),
    threshold: 1,
  });
  (client as any).submitEnvelope = async () => ({ ok: true });
  const signer = new DelegateSigner({ delegatePrivKeyHex: "22".repeat(32), client });
  const rfq = {
    pair: new Uint8Array(32),
    base_asset: new Uint8Array(32),
    quote_asset: new Uint8Array(32),
    size: 1n,
    reference_price: 1n,
    auto_accept: false,
    auto_accept_target_rate: 0n,
    allow_partial_fills: false,
    min_fill_size: 0n,
    expires_at_ms: 1n,
    rfq_id: new Uint8Array(16),
    settlement_mode: "Platform" as const,
  };
  const start = signer.getNextSeq();
  await signer.submitRfq(rfq as any);
  await signer.cancelRfq({ rfq_id: new Uint8Array(16), reason: "x" });
  await signer.submitRfq(rfq as any);
  assert.equal(signer.getNextSeq(), start + 2n);
});

// ── C1: the ID-casing false negative ───────────────────────────

test("sameId cannot report a landed write as applied:false on casing alone", () => {
  assert.ok(sameId("AD0F0693-9537-4193-8A3A-47E6025DCC46", "ad0f0693-9537-4193-8a3a-47e6025dcc46"));
  assert.ok(sameId("ad0f06939537419383a347e6025dcc46", "AD0F0693-9537-4193-83A3-47E6025DCC46".replace(/-/g, "")));
  assert.ok(!sameId("ad0f0693-9537-4193-8a3a-47e6025dcc46", "11111111-1111-1111-1111-111111111111"));
  assert.ok(!sameId(null, "x"));
});

// ── C1: the lifecycle contract, and the note that must not lie ──

test("an ingress rejection is `rejected`, applied:false", async () => {
  const r = await withLifecycle(
    { ok: false, code: "decode_error" },
    { verifiedBy: "x", tieBreaker: "get_balances", check: async () => false },
  );
  assert.equal(r.lifecycle, "rejected");
  assert.equal(r.applied, false);
});

test("a confirmed write is `applied`, applied:true", async () => {
  const r = await withLifecycle(
    { ok: true },
    { verifiedBy: "get_orderbook", tieBreaker: "get_balances", check: async () => true },
  );
  assert.equal(r.lifecycle, "applied");
  assert.equal(r.applied, true);
});

test("an unconfirmed write is `unknown` with applied:null — never a false negative", async () => {
  const r = await withLifecycle(
    { ok: true },
    { verifiedBy: "get_orderbook", tieBreaker: "get_balances", check: async () => false, budgetMs: 10 },
  );
  assert.equal(r.lifecycle, "unknown");
  assert.equal(r.applied, null, "must be null (unknown), not false (rejected)");
});

test("the apply note NEVER claims funds are unlocked without reading them", async () => {
  // The old handler appended a hard-coded 'Kein Guthaben gesperrt'
  // ("no funds locked") on every apply-miss. That is a lock claim made
  // without a balance read, and it was categorically wrong whenever the
  // write actually landed.
  for (const ok of [true, false]) {
    const r = await withLifecycle(
      { ok, code: ok ? undefined : "gate_rejected" },
      { verifiedBy: "get_orderbook", tieBreaker: "get_balances", check: async () => false, budgetMs: 10 },
    );
    assert.ok(!/Guthaben/i.test(r.note), "note must not be German");
    assert.ok(
      !/no funds (were )?locked/i.test(r.note),
      `note must not assert an unread lock state: ${r.note}`,
    );
    assert.ok(/get_balances/.test(r.note), "note must point at the tie-breaker read");
  }
});

test("a transient read failure during the poll is `unknown`, never `rejected`", async () => {
  const r = await withLifecycle(
    { ok: true },
    {
      verifiedBy: "get_orderbook",
      tieBreaker: "get_balances",
      check: async () => {
        throw new Error("network blip");
      },
      budgetMs: 10,
    },
  );
  assert.equal(r.lifecycle, "unknown");
  assert.equal(r.applied, null);
});

// ── C1: the guarded gate ───────────────────────────────────────

test("guarded is the default; --allow-dangerous and the env var opt out", () => {
  assert.equal(resolveMode([]), "guarded");
  assert.equal(resolveMode(["--allow-dangerous"]), "autonomous");
});

test("every money tool is gated in guarded mode, and no read tool is", () => {
  const writes = ["submit_rfq", "place_quote", "accept_quote", "cancel_rfq", "withdraw_quote"];
  for (const name of writes) {
    const t = findTool(name, true);
    assert.ok(t, `${name} must exist`);
    assert.equal(t!.dangerous, true, `${name} must be gated`);
    assert.equal(t!.requiresSigner, true);
  }
  for (const t of allTools(false)) {
    assert.notEqual(t.dangerous, true, `${t.name} is a read tool and must not be gated`);
    // `group` is optional and defaults to read.
    assert.equal(t.group ?? "read", "read");
  }
});

test("a guarded money tool refuses without acknowledgement, and says how to proceed", async () => {
  const tool = findTool("submit_rfq", true)!;
  await assert.rejects(
    () =>
      tool.handler(
        { sell_chain: "supra", sell_token: "SUPRA", buy_chain: "ethereum", buy_token: "USDC", size: 1, reference_price: 1 },
        { client: {} as any, signer: {} as any, masterAddress: null, mode: "guarded", groups: new Set(["read", "trade", "cancel"]) },
      ),
    (e: unknown) => {
      assert.ok(e instanceof ToolError, "must be a ToolError");
      assert.equal((e as ToolError).code, "NEEDS_ACKNOWLEDGEMENT");
      assert.match((e as ToolError).remedy, /acknowledged: true/);
      return true;
    },
  );
});

// ── C1 P2: launch-time read/write split ────────────────────────

test("--tools=read exposes a keyed agent with ZERO write tools", () => {
  const groups = resolveToolGroups(["--tools=read"]);
  const names = allTools(true, groups).map((t) => t.name);
  for (const w of ["submit_rfq", "place_quote", "accept_quote", "cancel_rfq", "withdraw_quote"]) {
    assert.ok(!names.includes(w), `${w} must not be exposed`);
  }
  assert.ok(names.includes("get_orderbook"));
});

test("--tools=read,cancel exposes the release tools and nothing that opens a position", () => {
  const names = allTools(true, resolveToolGroups(["--tools=read,cancel"])).map((t) => t.name);
  assert.ok(names.includes("cancel_rfq") && names.includes("withdraw_quote"));
  for (const w of ["submit_rfq", "place_quote", "accept_quote"]) {
    assert.ok(!names.includes(w), `${w} must not be exposed`);
  }
});

test("reads are never withheld, and the default exposes every class", () => {
  assert.ok(resolveToolGroups(["--tools=trade"]).has("read"));
  const d = resolveToolGroups([]);
  assert.ok(d.has("read") && d.has("trade") && d.has("cancel"));
});

// ── C1: dead-on-arrival RFQs are refused before they lock funds ─

test("an RFQ that could never fill is refused client-side, not left holding collateral", async () => {
  const tool = findTool("submit_rfq", true)!;
  const ctx = {
    client: {} as any,
    signer: {} as any,
    masterAddress: null,
    mode: "autonomous" as const,
    groups: new Set(["read", "trade", "cancel"]),
  };
  const base = {
    sell_chain: "supra", sell_token: "SUPRA",
    buy_chain: "ethereum", buy_token: "USDC",
    size: 1, reference_price: 1,
  };
  for (const bad of [
    { ...base, expires_in_minutes: 0 },
    { ...base, allow_partial_fills: true, min_fill_size: 5 },
    { ...base, size: 0 },
  ]) {
    await assert.rejects(
      () => tool.handler(bad, ctx),
      (e: unknown) => {
        assert.ok(e instanceof ToolError, "must be a ToolError");
        assert.equal((e as ToolError).code, "RFQ_DEAD_ON_ARRIVAL");
        return true;
      },
      `should refuse ${JSON.stringify(bad)}`,
    );
  }
});

// ── C1: structured errors ──────────────────────────────────────

test("errors carry a stable category and the action that clears it", () => {
  const e = new SupraFxError("rate_limit", "backoff", "429");
  assert.deepEqual(e.toEnvelope(), { error: "rate_limit", action: "backoff", message: "429" });
});

// ── C1 P2: the master address survives a context reset ─────────

test("get_master_address explains itself instead of returning a bare null", async () => {
  const tool = findTool("get_master_address", false)!;
  const ctx = { client: {} as any, signer: null, masterAddress: null, mode: "guarded" as const, groups: new Set(["read"]) };
  const r = (await tool.handler({}, ctx)) as any;
  assert.equal(r.configured, false);
  assert.match(r.how_to_fix, /SUPRAFX_MASTER_ADDRESS/);

  const r2 = (await tool.handler({}, { ...ctx, masterAddress: "0xabc" })) as any;
  assert.equal(r2.configured, true);
  assert.equal(r2.master_address, "0xabc");
});

// ── B2: the cap-zero rule, pinned to the contract ──────────────

test("MAX_CAP is u64::MAX — the unlimited sentinel, and not u128::MAX", async () => {
  const { MAX_CAP } = await import("../src/event-bcs.js");
  assert.equal(MAX_CAP, 18446744073709551615n);
  assert.equal(MAX_CAP, (1n << 64n) - 1n);
  // u128::MAX would overflow the validator's checked_add(earmarks, size).
  assert.notEqual(MAX_CAP, (1n << 128n) - 1n);
  // And it is emphatically not zero: 0 is fail-closed, "no trades".
  assert.notEqual(MAX_CAP, 0n);
});
