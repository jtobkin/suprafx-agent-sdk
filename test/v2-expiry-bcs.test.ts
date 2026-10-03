import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeUserEvent,
  encodeUserEvent,
  TAG_PLACE_QUOTE_V2,
  TAG_SUBMIT_RFQ_V2,
  type UserEvent,
} from "../src/event-bcs.js";
import { decodeEnvelopeBcs } from "../src/sign-event.js";
import { DelegateSigner } from "../src/signer.js";
import { readLockReleaseState, U64_MAX } from "../src/expiry.js";

const SUBMIT_RFQ_V2_RUST_BCS =
  "24010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303040404040404040404040404040404040404040404040404040404040404040405000000000000000000000000000000060000000000000000000000000000000107000000000000000000000000000000000800000000000000000000000000000009000000000000000a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0b00000000000000010c00000000000000";
const PLACE_QUOTE_V2_RUST_BCS =
  "250d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f100000000000000000000000000000001100000000000000000000000000000012000000000000001300000000000000";
const SUBMIT_RFQ_V1_RUST_BCS =
  "04010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303040404040404040404040404040404040404040404040404040404040404040405000000000000000000000000000000060000000000000000000000000000000107000000000000000000000000000000000800000000000000000000000000000009000000000000000a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0b0000000000000001";
const PLACE_QUOTE_V1_RUST_BCS =
  "060d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f10000000000000000000000000000000110000000000000000000000000000001200000000000000";

const filled = (byte: number, length: number) => new Uint8Array(length).fill(byte);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

test("V2 order encoders equal the Rust Step 4 vectors", () => {
  const submit: UserEvent = {
    kind: "SubmitRfqV2",
    payload: {
      user: filled(1, 32), pair: filled(2, 32), base_asset: filled(3, 32),
      quote_asset: filled(4, 32), size: 5n, reference_price: 6n,
      auto_accept: true, auto_accept_target_rate: 7n,
      allow_partial_fills: false, min_fill_size: 8n, expires_at_ms: 9n,
      rfq_id: filled(10, 16), user_sequence_number: 11n,
      settlement_mode: "OnChain", expires_at_batch: 12n,
    },
  };
  const place: UserEvent = {
    kind: "PlaceQuoteV2",
    payload: {
      maker: filled(13, 32), rfq_id: filled(14, 16), quote_id: filled(15, 16),
      rate: 16n, fill_size: 17n, user_sequence_number: 18n,
      expires_at_batch: 19n,
    },
  };
  assert.equal(TAG_SUBMIT_RFQ_V2, 36);
  assert.equal(TAG_PLACE_QUOTE_V2, 37);
  assert.equal(hex(encodeUserEvent(submit)), SUBMIT_RFQ_V2_RUST_BCS);
  assert.equal(hex(encodeUserEvent(place)), PLACE_QUOTE_V2_RUST_BCS);
  assert.deepEqual(decodeUserEvent(encodeUserEvent(submit)), submit);
  assert.deepEqual(decodeUserEvent(encodeUserEvent(place)), place);
});

test("V1 order encoders equal the existing Rust vectors", () => {
  const submit: UserEvent = {
    kind: "SubmitRfq",
    payload: {
      user: filled(1, 32), pair: filled(2, 32), base_asset: filled(3, 32),
      quote_asset: filled(4, 32), size: 5n, reference_price: 6n,
      auto_accept: true, auto_accept_target_rate: 7n,
      allow_partial_fills: false, min_fill_size: 8n, expires_at_ms: 9n,
      rfq_id: filled(10, 16), user_sequence_number: 11n,
      settlement_mode: "OnChain",
    },
  };
  const place: UserEvent = {
    kind: "PlaceQuote",
    payload: {
      maker: filled(13, 32), rfq_id: filled(14, 16), quote_id: filled(15, 16),
      rate: 16n, fill_size: 17n, user_sequence_number: 18n,
    },
  };
  assert.equal(hex(encodeUserEvent(submit)), SUBMIT_RFQ_V1_RUST_BCS);
  assert.equal(hex(encodeUserEvent(place)), PLACE_QUOTE_V1_RUST_BCS);
});

test("signer defaults to 545 batches and caps a quote at its parent", async () => {
  const submitted: Uint8Array[] = [];
  const client = {
    getCurrentBatch: async () => 100,
    getConsensusParams: async () => ({
      fleet_must_match: { lock_release_activation_batch: "100" },
    }),
    getChainInfo: async () => ({ chainIdHashHex: "00".repeat(32) }),
    getSequenceNumber: async () => 11,
    submitEnvelope: async (_endpoint: string, _field: string, envelopeHex: string) => {
      submitted.push(Buffer.from(envelopeHex, "hex"));
      return { ok: true };
    },
  } as any;
  const signer = new DelegateSigner({ delegatePrivKeyHex: "11".repeat(32), client });
  await signer.submitRfq({
    pair: filled(1, 32), base_asset: filled(2, 32), quote_asset: filled(3, 32),
    size: 1n, reference_price: 1n, auto_accept: false,
    auto_accept_target_rate: 0n, allow_partial_fills: false, min_fill_size: 0n,
    expires_at_ms: 1n, rfq_id: filled(4, 16), settlement_mode: "Platform",
  });
  await signer.placeQuote({
    rfq_id: filled(4, 16), quote_id: filled(5, 16), rate: 1n, fill_size: 1n,
    parent_expires_at_batch: 400n,
  });
  const first = decodeUserEvent(decodeEnvelopeBcs(submitted[0]).event_bcs);
  const second = decodeUserEvent(decodeEnvelopeBcs(submitted[1]).event_bcs);
  assert.equal(first?.kind, "SubmitRfqV2");
  assert.equal(first?.kind === "SubmitRfqV2" && first.payload.expires_at_batch, 646n);
  assert.equal(second?.kind, "PlaceQuoteV2");
  assert.equal(second?.kind === "PlaceQuoteV2" && second.payload.expires_at_batch, 400n);
  await assert.rejects(
    () => signer.submitRfq({
      pair: filled(1, 32), base_asset: filled(2, 32), quote_asset: filled(3, 32),
      size: 1n, reference_price: 1n, auto_accept: false,
      auto_accept_target_rate: 0n, allow_partial_fills: false, min_fill_size: 0n,
      expires_at_ms: 1n, rfq_id: filled(4, 16), settlement_mode: "Platform",
      expires_in_batches: 200_001,
    }),
    /between 12 and 200000/,
  );
  await assert.rejects(
    () => signer.submitRfq({
      pair: filled(1, 32), base_asset: filled(2, 32), quote_asset: filled(3, 32),
      size: 1n, reference_price: 1n, auto_accept: false,
      auto_accept_target_rate: 0n, allow_partial_fills: false, min_fill_size: 0n,
      expires_at_ms: 1n, rfq_id: filled(4, 16), settlement_mode: "Platform",
      expires_in_batches: 11,
    }),
    /between 12 and 200000/,
  );
});

test("signer uses V1 before H and V2 for the target batch H boundary", async () => {
  const submitted: Uint8Array[] = [];
  let currentBatch = 98;
  const client = {
    getCurrentBatch: async () => currentBatch,
    getConsensusParams: async () => ({
      fleet_must_match: { lock_release_activation_batch: "100" },
    }),
    getChainInfo: async () => ({ chainIdHashHex: "00".repeat(32) }),
    getSequenceNumber: async () => 11,
    submitEnvelope: async (_endpoint: string, _field: string, envelopeHex: string) => {
      submitted.push(Buffer.from(envelopeHex, "hex"));
      return { ok: true };
    },
  } as any;
  const signer = new DelegateSigner({ delegatePrivKeyHex: "22".repeat(32), client });
  await signer.loadSequenceFromChain();
  const payload = {
    pair: filled(2, 32), base_asset: filled(3, 32), quote_asset: filled(4, 32),
    size: 5n, reference_price: 6n, auto_accept: true,
    auto_accept_target_rate: 7n, allow_partial_fills: false, min_fill_size: 8n,
    expires_at_ms: 9n, rfq_id: filled(10, 16), settlement_mode: "OnChain" as const,
    expires_in_batches: 12,
  };

  await signer.submitRfq(payload); // target H-1
  currentBatch = 99;
  await signer.submitRfq(payload); // target H

  const before = decodeEnvelopeBcs(submitted[0]).event_bcs;
  const at = decodeEnvelopeBcs(submitted[1]).event_bcs;
  const liveEvent = decodeUserEvent(at);
  assert.equal(decodeUserEvent(before)?.kind, "SubmitRfq");
  assert.equal(liveEvent?.kind, "SubmitRfqV2");
  assert.equal(before[0], 4, "not-live bytes must carry Rust's V1 tag");
  assert.equal(
    hex(before),
    `04${hex(signer.address)}${SUBMIT_RFQ_V1_RUST_BCS.slice(66)}`,
    "not-live signing must emit the existing Rust V1 bytes",
  );
  assert.equal(at[0], 36, "live bytes must carry the Step-4 V2 tag");
  assert.equal(
    liveEvent?.kind === "SubmitRfqV2" ? liveEvent.payload.expires_at_batch : null,
    112n,
  );
});

test("pre-activation quote is V1 without parent expiry; live quote fetches it", async () => {
  const submitted: Uint8Array[] = [];
  let currentBatch = 98;
  const parentReads: string[] = [];
  const rfqId = filled(14, 16);
  const client = {
    getCurrentBatch: async () => currentBatch,
    getConsensusParams: async () => ({
      fleet_must_match: { lock_release_activation_batch: "100" },
    }),
    getChainInfo: async () => ({ chainIdHashHex: "00".repeat(32) }),
    getRfqById: async (id: string) => {
      parentReads.push(id);
      return {
        id: "0e0e0e0e-0e0e-0e0e-0e0e-0e0e0e0e0e0e",
        status: "open",
        expires_at_batch: "130",
      };
    },
    submitEnvelope: async (_endpoint: string, _field: string, envelopeHex: string) => {
      submitted.push(Buffer.from(envelopeHex, "hex"));
      return { ok: true };
    },
  } as any;
  const signer = new DelegateSigner({ delegatePrivKeyHex: "33".repeat(32), client });
  const payload = {
    rfq_id: rfqId, quote_id: filled(15, 16), rate: 16n, fill_size: 17n,
    expires_in_batches: 12,
  };

  await signer.placeQuote(payload);
  assert.equal(decodeUserEvent(decodeEnvelopeBcs(submitted[0]).event_bcs)?.kind, "PlaceQuote");
  assert.equal(parentReads.length, 0, "V1 must not demand post-activation metadata");

  currentBatch = 99;
  await signer.placeQuote(payload);
  const live = decodeUserEvent(decodeEnvelopeBcs(submitted[1]).event_bcs);
  assert.equal(live?.kind, "PlaceQuoteV2");
  assert.equal(live?.kind === "PlaceQuoteV2" && live.payload.expires_at_batch, 112n);
  assert.deepEqual(parentReads, ["0e0e0e0e-0e0e-0e0e-0e0e-0e0e0e0e0e0e"]);
});

test("u64::MAX and unreadable activation both fail safely to not-live", async () => {
  const inert = await readLockReleaseState({
    getCurrentBatch: async () => 99,
    getConsensusParams: async () => ({
      fleet_must_match: { lock_release_activation_batch: U64_MAX.toString() },
    }),
  });
  assert.equal(inert.live, false);
  assert.equal(inert.targetBatch, 100n);

  const unknown = await readLockReleaseState({
    getCurrentBatch: async () => 99,
    getConsensusParams: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual(unknown, {
    live: false,
    targetBatch: null,
    activationBatch: null,
  });
});
