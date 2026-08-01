import assert from "node:assert/strict";
import test from "node:test";
import type { SupraFxClient } from "../client.js";
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
