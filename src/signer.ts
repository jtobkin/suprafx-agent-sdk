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

/** Codes that mean the chain accepted the envelope at mempool but
 *  rejected it at apply-time. The seq slot is consumed either way. */
const CHAIN_SAW_IT_CODES: ReadonlySet<string> = new Set([
  "gate_rejected",
  "auth_failed",
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

    if (res.ok === true) {
      this.nextSeq = this.nextSeq + 1n;
    } else if (res.code && CHAIN_SAW_IT_CODES.has(res.code)) {
      // Chain saw the envelope but rejected. Seq slot is consumed.
      this.nextSeq = this.nextSeq + 1n;
    }
    // Otherwise (ingress-level reject): seq unchanged.

    return { ...res, envelopeBcsHex };
  }

  // ─── Convenience methods that build the event + send ──────────

  async submitRfq(payload: Omit<
    Extract<UserEvent, { kind: "SubmitRfq" }>["payload"],
    "user_sequence_number" | "user"
  >): Promise<SubmitResult> {
    return await this.sendEnvelope({
      kind: "SubmitRfq",
      payload: {
        user: this.address,
        ...payload,
        user_sequence_number: this.nextSeq,
      } as Extract<UserEvent, { kind: "SubmitRfq" }>["payload"],
    });
  }

  async placeQuote(payload: Omit<
    Extract<UserEvent, { kind: "PlaceQuote" }>["payload"],
    "user_sequence_number" | "maker"
  >): Promise<SubmitResult> {
    return await this.sendEnvelope({
      kind: "PlaceQuote",
      payload: {
        maker: this.address,
        ...payload,
        user_sequence_number: this.nextSeq,
      } as Extract<UserEvent, { kind: "PlaceQuote" }>["payload"],
    });
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
      return { endpoint: "submit-rfq", bodyField: "submit_rfq_envelope_bcs_hex" };
    case "PlaceQuote":
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
