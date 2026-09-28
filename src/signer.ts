/**
 * Delegate signer: encapsulates the ed25519 key + sequence counter,
 * encodes a SupraFX event, signs it, and submits to the dApp ingress.
 *
 * Designed for an agent process that holds ONE delegate key. To run
 * multiple delegates (e.g. one per pair) instantiate one Signer each.
 *
 * Sequence management:
 *   - On construct, takeOff with `loadSequenceFromChain()` to align
 *     the counter to the chain's current expectation
 *   - On a `body.ok === true` submit: counter advances by 1
 *   - On `body.ok === false` with code in `CHAIN_SAW_IT_CODES`:
 *     counter advances (the chain saw the bad envelope and consumed
 *     the seq slot for replay protection)
 *   - On `body.ok === false` with ingress codes (decode_error,
 *     rate_limited, missing_envelope): counter unchanged, safe to retry
 *
 * The chain rejects sequence-number replays at vote time silently —
 * the dApp's submit returns HTTP 200 from mempool but the trade
 * never commits. Re-fetch via `loadSequenceFromChain()` on any
 * suspected drift to recover.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import {
  encodeUserEvent,
  type UserEvent,
} from "./event-bcs.js";
import {
  composeSignBytes,
  encodeEnvelopeBcs,
} from "./sign-event.js";
import { SupraFxClient, type SubmitResult } from "./client.js";
import {
  DEFAULT_EXPIRY_BATCHES,
  MAX_EXPIRY_BATCHES,
  MIN_SAFE_EXPIRY_BATCHES,
  readLockReleaseState,
} from "./expiry.js";

/** Codes that mean the chain accepted the envelope at mempool but
 *  rejected it at apply-time. The seq slot is consumed either way. */
const CHAIN_SAW_IT_CODES: ReadonlySet<string> = new Set([
  "gate_rejected",
  "auth_failed",
]);

/**
 * The event kinds that actually CARRY a `user_sequence_number` in their
 * BCS payload, and therefore consume a sequence slot on chain.
 *
 * WHY THIS GATE EXISTS. `CancelRfq` and `WithdrawQuote` have no
 * `user_sequence_number` field at all (see `event-bcs.ts`
 * `CancelRfqEvent` / `WithdrawQuoteEvent`) — their replay protection is
 * the uniqueness of `rfq_id` / `quote_id`. But `sendEnvelope` used to
 * advance `nextSeq` on ANY `ok === true`, so a single cancel or quote
 * withdrawal pushed the local counter one ahead of the chain's. Every
 * later trade then signed a seq the chain had already consumed, and the
 * chain drops a replayed seq SILENTLY — `ok:true` at ingress, never
 * committed. One cancel desynced every trade after it until reconnect.
 */
const CONSUMES_SEQ: ReadonlySet<UserEvent["kind"]> = new Set([
  "SubmitRfq",
  "SubmitRfqV2",
  "PlaceQuote",
  "PlaceQuoteV2",
  "AcceptQuote",
]);

export interface DelegateSignerOptions {
  /** 32-byte ed25519 private key as hex (with or without 0x prefix). */
  delegatePrivKeyHex: string;
  /** The dApp HTTP client. Reused for reads + writes. */
  client: SupraFxClient;
}

export class DelegateSigner {
  private readonly priv: Uint8Array;
  private readonly pub: Uint8Array;
  /** 32-byte Supra address = sha3_256(pubkey || 0x00). */
  readonly address: Uint8Array;
  /** Address as `0x`-prefixed lowercase hex. */
  readonly addressHex: string;
  private readonly client: SupraFxClient;
  private nextSeq: bigint;
  private chainIdHash: Uint8Array | null = null;

  constructor(opts: DelegateSignerOptions) {
    this.priv = hexToBytes(stripHex(opts.delegatePrivKeyHex));
    if (this.priv.length !== 32) {
      throw new Error(
        `delegatePrivKeyHex must be 32 bytes (got ${this.priv.length})`,
      );
    }
    this.pub = ed25519.getPublicKey(this.priv);
    const addrInput = new Uint8Array(this.pub.length + 1);
    addrInput.set(this.pub, 0);
    addrInput[this.pub.length] = 0x00;
    this.address = sha3_256(addrInput);
    this.addressHex = "0x" + bytesToHex(this.address);
    this.client = opts.client;
    this.nextSeq = BigInt(0); // overwritten by loadSequenceFromChain()
  }

  /** Re-anchor the local sequence counter to the chain's expectation.
   *  Call on startup, on uncertainty, and after long network gaps. */
  async loadSequenceFromChain(): Promise<bigint> {
    const next = await this.client.getSequenceNumber(this.addressHex);
    this.nextSeq = BigInt(next);
    return this.nextSeq;
  }

  /** Cached lookup of the chain id hash (constant per genesis). */
  private async ensureChainIdHash(): Promise<Uint8Array> {
    if (this.chainIdHash) return this.chainIdHash;
    const ci = await this.client.getChainInfo();
    this.chainIdHash = hexToBytes(stripHex(ci.chainIdHashHex));
    return this.chainIdHash;
  }

  /** Current next-sequence-number this signer would use. Exposed
   *  for diagnostics and for adapters that need to forward seq into
   *  custom event payloads. */
  getNextSeq(): bigint {
    return this.nextSeq;
  }

  /**
   * Build a signed envelope from `event` and submit it to the
   * matching dApp endpoint. Returns the raw `SubmitResult` plus the
   * envelope bytes (handy for logging or replaying).
   *
   * The caller MUST pass an event whose `payload.*sequence_number*`
   * matches `this.getNextSeq()` — we don't mutate the payload here
   * because the field name differs by event type (`user_sequence_number`
   * on most, etc.). Helper methods below (`placeQuote`, `submitRfq`,
   * etc.) handle this for you.
   */
  async sendEnvelope(event: UserEvent): Promise<SubmitResult & {
    envelopeBcsHex: string;
  }> {
    const chainIdHash = await this.ensureChainIdHash();
    const eventBcs = encodeUserEvent(event);
    const signBytes = composeSignBytes(chainIdHash, eventBcs);
    const sig = ed25519.sign(signBytes, this.priv);
    const envelopeBcs = encodeEnvelopeBcs({
      event_bcs: eventBcs,
      signer_pubkey: this.pub,
      signer_sig: sig,
    });
    const envelopeBcsHex = bytesToHex(envelopeBcs);

    const { endpoint, bodyField } = routeForEvent(event.kind);
    const res = await this.client.submitEnvelope(
      endpoint,
      bodyField,
      envelopeBcsHex,
    );

    // Only seq-BEARING events may move the counter. A cancel/withdraw
    // returning ok:true must leave it exactly where it was.
    if (CONSUMES_SEQ.has(event.kind)) {
      if (res.ok === true) {
        this.nextSeq = this.nextSeq + 1n;
      } else if (res.code && CHAIN_SAW_IT_CODES.has(res.code)) {
        // Chain saw the envelope but rejected. Seq slot is consumed.
        this.nextSeq = this.nextSeq + 1n;
      }
      // Otherwise (ingress-level reject): seq unchanged.
    }

    return { ...res, envelopeBcsHex };
  }

  // ─── Convenience methods that build the event + send ──────────

  async submitRfq(payload: Omit<
    Extract<UserEvent, { kind: "SubmitRfqV2" }>["payload"],
    "user_sequence_number" | "user" | "expires_at_batch"
  > & { expires_in_batches?: number }): Promise<SubmitResult> {
    const { expires_in_batches = DEFAULT_EXPIRY_BATCHES, ...eventPayload } = payload;
    assertExpiryLifetime(expires_in_batches);
    const lockRelease = await readLockReleaseState(this.client);
    if (!lockRelease.live || lockRelease.targetBatch === null) {
      return await this.sendEnvelope({
        kind: "SubmitRfq",
        payload: {
          user: this.address,
          ...eventPayload,
          user_sequence_number: this.nextSeq,
        } as Extract<UserEvent, { kind: "SubmitRfq" }>["payload"],
      });
    }
    const targetBatch = lockRelease.targetBatch;
    return await this.sendEnvelope({
      kind: "SubmitRfqV2",
      payload: {
        user: this.address,
        ...eventPayload,
        user_sequence_number: this.nextSeq,
        expires_at_batch: targetBatch + BigInt(expires_in_batches),
      } as Extract<UserEvent, { kind: "SubmitRfqV2" }>["payload"],
    });
  }

  async placeQuote(payload: Omit<
    Extract<UserEvent, { kind: "PlaceQuoteV2" }>["payload"],
    "user_sequence_number" | "maker" | "expires_at_batch"
  > & { expires_in_batches?: number; parent_expires_at_batch?: bigint | number | string }): Promise<SubmitResult> {
    const {
      expires_in_batches = DEFAULT_EXPIRY_BATCHES,
      parent_expires_at_batch,
      ...eventPayload
    } = payload;
    assertExpiryLifetime(expires_in_batches);
    const lockRelease = await readLockReleaseState(this.client);
    if (!lockRelease.live || lockRelease.targetBatch === null) {
      return await this.sendEnvelope({
        kind: "PlaceQuote",
        payload: {
          maker: this.address,
          ...eventPayload,
          user_sequence_number: this.nextSeq,
        } as Extract<UserEvent, { kind: "PlaceQuote" }>["payload"],
      });
    }
    const targetBatch = lockRelease.targetBatch;
    const parentExpiry = parent_expires_at_batch == null
      ? await this.fetchParentExpiry(
          eventPayload.rfq_id,
          lockRelease.activationBatch!,
        )
      : BigInt(parent_expires_at_batch);
    const expiresAtBatch = minBigInt(targetBatch + BigInt(expires_in_batches), parentExpiry);
    if (expiresAtBatch < targetBatch + BigInt(MIN_SAFE_EXPIRY_BATCHES)) {
      throw new Error("The parent RFQ expires too soon to place a quote safely.");
    }
    return await this.sendEnvelope({
      kind: "PlaceQuoteV2",
      payload: {
        maker: this.address,
        ...eventPayload,
        user_sequence_number: this.nextSeq,
        expires_at_batch: expiresAtBatch,
      } as Extract<UserEvent, { kind: "PlaceQuoteV2" }>["payload"],
    });
  }

  /** Fetch expiry only after activation. Pre-activation quotes stay V1 and
   * never mistake absent expiry metadata for a frozen parent. */
  private async fetchParentExpiry(
    rfqId: Uint8Array,
    activationBatch: bigint,
  ): Promise<bigint> {
    let parent: Awaited<ReturnType<SupraFxClient["getRfqById"]>>;
    try {
      parent = await this.client.getRfqById(bytes16ToUuid(rfqId));
    } catch {
      throw parentExpiryUnavailable();
    }
    if (!parent) throw parentExpiryUnavailable();
    if (parent.status.toLowerCase() !== "open") {
      throw new Error("This order is no longer open.");
    }
    if (parent.expires_at_batch != null) {
      try {
        return BigInt(parent.expires_at_batch);
      } catch {
        throw parentExpiryUnavailable();
      }
    }
    let parentBatch: bigint | null = null;
    if (parent.council_batch_number != null) {
      try {
        parentBatch = BigInt(parent.council_batch_number);
      } catch {
        throw parentExpiryUnavailable();
      }
    }
    if (parentBatch === null || parentBatch < activationBatch) {
      throw new Error(
        "This older order is frozen for the expiry upgrade and cannot receive new quotes.",
      );
    }
    throw parentExpiryUnavailable();
  }

  /** CancelRfq has no `user_sequence_number` — rfq_id uniqueness is
   *  the replay-protection invariant. The signer doesn't advance the
   *  seq counter for this event type. */
  async cancelRfq(args: { rfq_id: Uint8Array; reason: string }): Promise<SubmitResult> {
    return await this.sendEnvelope({
      kind: "CancelRfq",
      payload: {
        user: this.address,
        rfq_id: args.rfq_id,
        reason: args.reason,
      },
    });
  }

  /** AcceptQuote: takes `quote_id` + `trade_id` (caller-supplied, used
   *  as the on-chain trade identity). Does NOT take `rfq_id`. */
  async acceptQuote(args: {
    quote_id: Uint8Array;
    trade_id: Uint8Array;
  }): Promise<SubmitResult> {
    return await this.sendEnvelope({
      kind: "AcceptQuote",
      payload: {
        taker: this.address,
        quote_id: args.quote_id,
        trade_id: args.trade_id,
        user_sequence_number: this.nextSeq,
      },
    });
  }

  /** WithdrawQuote takes only `quote_id`. No sequence number — quote_id
   *  uniqueness is the replay-protection invariant. */
  async withdrawQuote(args: { quote_id: Uint8Array }): Promise<SubmitResult> {
    return await this.sendEnvelope({
      kind: "WithdrawQuote",
      payload: {
        maker: this.address,
        quote_id: args.quote_id,
      },
    });
  }
}

function routeForEvent(kind: UserEvent["kind"]): {
  endpoint:
    | "submit-rfq"
    | "place-quote"
    | "accept-quote"
    | "withdraw-quote"
    | "cancel-rfq";
  bodyField: string;
} {
  switch (kind) {
    case "SubmitRfq":
    case "SubmitRfqV2":
      return { endpoint: "submit-rfq", bodyField: "submit_rfq_envelope_bcs_hex" };
    case "PlaceQuote":
    case "PlaceQuoteV2":
      return { endpoint: "place-quote", bodyField: "place_quote_envelope_bcs_hex" };
    case "AcceptQuote":
      return { endpoint: "accept-quote", bodyField: "accept_quote_envelope_bcs_hex" };
    case "WithdrawQuote":
      return { endpoint: "withdraw-quote", bodyField: "withdraw_quote_envelope_bcs_hex" };
    case "CancelRfq":
      return { endpoint: "cancel-rfq", bodyField: "cancel_rfq_envelope_bcs_hex" };
    default:
      throw new Error(`routeForEvent: no endpoint for event kind ${kind}`);
  }
}

function assertExpiryLifetime(value: number): void {
  if (
    !Number.isInteger(value) ||
    value < MIN_SAFE_EXPIRY_BATCHES ||
    value > MAX_EXPIRY_BATCHES
  ) {
    throw new Error(
      `expires_in_batches must be a whole number between ${MIN_SAFE_EXPIRY_BATCHES} and ${MAX_EXPIRY_BATCHES}`,
    );
  }
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function parentExpiryUnavailable(): Error {
  return new Error(
    "This order's on-chain expiry is unavailable. Refresh the orderbook and try again.",
  );
}

function stripHex(s: string): string {
  return (s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s).toLowerCase();
}

function hexToBytes(s: string): Uint8Array {
  const stripped = stripHex(s);
  if (stripped.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function bytes16ToUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error("rfq_id must be 16 bytes");
  const h = bytesToHex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
