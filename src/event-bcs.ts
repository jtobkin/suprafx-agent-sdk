/**
 * BCS encoders for user-originated `Event` variants.
 *
 * Mirrors the Rust struct schemas in
 * `council-rust/crates/protocol/src/events.rs` byte-for-byte.
 * Cross-language fixture
 * (`lib/council/__fixtures__/user-event-envelope-fixtures.json`)
 * proves equivalence; any drift is caught by
 * `tests/unit/council-event-bcs.test.ts`.
 *
 * ## Why we encode client-side (not server-side)
 *
 * The user signs `event_bcs` directly. If the server encoded those
 * bytes, a malicious or compromised server could mutate the event
 * (UI shows "Withdraw 100 USDC", server encodes "Withdraw 1M USDC")
 * and the user's wallet would sign the malicious bytes without the
 * user knowing — chain accepts the sig as valid because the math
 * works. Client-side encoding makes the bytes-the-user-signs equal
 * the bytes-the-UI-rendered, since both come from the same auditable
 * open-source TS code.
 *
 * Standard practice — Aptos, Sui, Solana, Ethereum all encode user
 * transactions client-side for the same reason.
 *
 * ## Variant index (must match Rust `Event` enum order)
 *
 * BCS encodes a Rust enum as `ULEB128(discriminant) + fields`. The
 * discriminant is the variant's declaration order in the enum:
 *
 *   0  DepositCredited           (validator-attested; not signed by user)
 *   1  WithdrawRequested         ← user
 *   2  WithdrawFinalized         (validator-attested)
 *   3  WithdrawCancelled         (lifecycle)
 *   4  SubmitRfq                 ← user
 *   5  CancelRfq                 ← user
 *   6  PlaceQuote                ← user (maker)
 *   7  AcceptQuote               ← user (taker)
 *   8  WithdrawQuote             ← user (maker)
 *   9  SlashMaker                (lifecycle)
 *  10..19  validator/governance
 *  20  DelegatePolicyCreated     ← user (master)
 *  21  DelegatePolicyUpdated     ← user (master)
 *  22  DelegatePolicyRevoked     ← user (master)
 *  23..30 other (not user-signed)
 *
 * If any of these indices change in Rust, the cross-language fixture
 * will fail at the next `cargo run --example
 * gen_user_event_envelope_fixture` and the TS test will catch it.
 *
 * ## Type sizes (locked at the protocol level)
 *
 *   AccountId    [u8; 32]
 *   AssetId      [u8; 32]
 *   PairId       [u8; 32]
 *   RfqId        [u8; 16]
 *   QuoteId      [u8; 16]
 *   TradeId      [u8; 16]
 *   Hash         [u8; 32]
 *   Amount       u128 (16 LE bytes; BCS does NOT use ULEB128 for u128)
 *   SequenceNumber  u64 (8 LE bytes)
 */

// ─── BCS primitive writers ────────────────────────────────────────

class BcsWriter {
  private chunks: Uint8Array[] = [];
  private len = 0;

  bytes(buf: Uint8Array): void {
    this.chunks.push(buf);
    this.len += buf.length;
  }

  /** Fixed-size byte array (no length prefix). */
  fixed(buf: Uint8Array, expectedLen: number, fieldName: string): void {
    if (buf.length !== expectedLen) {
      throw new Error(
        `${fieldName}: expected ${expectedLen} bytes, got ${buf.length}`,
      );
    }
    this.bytes(buf);
  }

  /** Variable-length `Vec<u8>` — ULEB128 length prefix + bytes. */
  varBytes(buf: Uint8Array): void {
    this.uleb128(buf.length);
    this.bytes(buf);
  }

  /** UTF-8 string — same wire shape as `Vec<u8>`. */
  str(s: string): void {
    this.varBytes(new TextEncoder().encode(s));
  }

  /** ULEB128 (variable-length unsigned int). */
  uleb128(n: number): void {
    if (n < 0 || !Number.isInteger(n)) {
      throw new Error(`uleb128: invalid value ${n}`);
    }
    let v = n;
    const out: number[] = [];
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v & 0x7f);
    this.bytes(new Uint8Array(out));
  }

  /** u8 — 1 byte. */
  u8(n: number): void {
    if (n < 0 || n > 0xff || !Number.isInteger(n)) {
      throw new Error(`u8: invalid value ${n}`);
    }
    this.bytes(new Uint8Array([n & 0xff]));
  }

  /** u32 little-endian — 4 bytes. */
  u32(n: number): void {
    if (n < 0 || n > 0xffffffff || !Number.isInteger(n)) {
      throw new Error(`u32: invalid value ${n}`);
    }
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, n, true);
    this.bytes(buf);
  }

  /** u64 little-endian — 8 bytes. Accepts `bigint` or safe-integer `number`. */
  u64(n: bigint | number): void {
    let v = typeof n === "bigint" ? n : BigInt(n);
    if (v < BigInt(0) || v > BigInt("0xffffffffffffffff")) {
      throw new Error(`u64: out of range ${v}`);
    }
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, v, true);
    this.bytes(buf);
  }

  /** u128 little-endian — 16 bytes. Used by `Amount`. */
  u128(n: bigint | number | string): void {
    let v: bigint;
    if (typeof n === "bigint") v = n;
    else if (typeof n === "number") v = BigInt(n);
    else v = BigInt(n);
    if (v < BigInt(0) || v > (BigInt(1) << BigInt(128)) - BigInt(1)) {
      throw new Error(`u128: out of range ${v}`);
    }
    const buf = new Uint8Array(16);
    const view = new DataView(buf.buffer);
    const lo = v & BigInt("0xffffffffffffffff");
    const hi = v >> BigInt(64);
    view.setBigUint64(0, lo, true);
    view.setBigUint64(8, hi, true);
    this.bytes(buf);
  }

  /** bool — 1 byte (0 = false, 1 = true). */
  bool(b: boolean): void {
    this.u8(b ? 1 : 0);
  }

  /** Vec<T> — ULEB128 length + repeated `writeFn(item)`. */
  vec<T>(items: T[], writeFn: (w: BcsWriter, item: T) => void): void {
    this.uleb128(items.length);
    for (const item of items) writeFn(this, item);
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.len);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

// ─── Variant tag constants ────────────────────────────────────────

const TAG_DEPOSIT_CREDITED = 0;
const TAG_WITHDRAW_REQUESTED = 1;
const TAG_SUBMIT_RFQ = 4;
const TAG_CANCEL_RFQ = 5;
const TAG_PLACE_QUOTE = 6;
const TAG_ACCEPT_QUOTE = 7;
const TAG_WITHDRAW_QUOTE = 8;
// On-chain-settlement claim events. Bump per-user (taker / maker)
// sequence numbers; included so projection-from-mirror endpoints
// (e.g. /api/council/sequence-number) can decode them.
const TAG_TAKER_TX_PENDING = 14;
const TAG_MAKER_TX_PENDING = 16;
const TAG_DELEGATE_POLICY_CREATED = 20;
const TAG_DELEGATE_POLICY_UPDATED = 21;
const TAG_DELEGATE_POLICY_REVOKED = 22;
// LinkedAddressRevoked = enum index 25 (Rust Event variant order:
// see council-rust/crates/protocol/src/events.rs).
const TAG_LINKED_ADDRESS_REVOKED = 25;

// ─── Domain types (mirror Rust) ───────────────────────────────────

/** Settlement mode: Platform=0, OnChain=1. Matches Rust `SettlementMode`. */
export type SettlementMode = "Platform" | "OnChain";

function writeSettlementMode(w: BcsWriter, m: SettlementMode): void {
  w.uleb128(m === "Platform" ? 0 : 1);
}

/** Delegate role: Maker=0, Taker=1, Agent=2. Matches Rust `DelegateRole`. */
export type DelegateRole = "Maker" | "Taker" | "Agent";

function writeDelegateRole(w: BcsWriter, r: DelegateRole): void {
  if (r === "Maker") w.uleb128(0);
  else if (r === "Taker") w.uleb128(1);
  else if (r === "Agent") w.uleb128(2);
  else throw new Error(`unknown DelegateRole: ${r as string}`);
}

// ─── Event payload types (mirror Rust struct fields exactly) ──────

/**
 * `SubmitRfq` payload. Field order MUST match
 * `council_protocol::events::SubmitRfq` struct declaration.
 */
/**
 * `DepositCredited` payload — validator-attested L1-deposit credit.
 * Layout matches Rust `council_protocol::events::DepositCredited`
 * field order; BCS is positional so any reorder there must mirror
 * here or the cross-language fixture round-trip breaks.
 */
export interface DepositCreditedEvent {
  user: Uint8Array; // [u8; 32]
  asset: Uint8Array; // [u8; 32]
  amount: bigint; // u128 micro-units
  source_chain: string;
  source_tx: Uint8Array; // [u8; 32]
  deposit_id: bigint; // u64
  source_block: bigint; // u64
  attesting_validators: Uint8Array[]; // Vec<[u8; 32]>
  attestations: Uint8Array[]; // Vec<[u8; 64]>
}

export interface SubmitRfqEvent {
  user: Uint8Array; // [u8; 32]
  pair: Uint8Array; // [u8; 32]
  base_asset: Uint8Array; // [u8; 32]
  quote_asset: Uint8Array; // [u8; 32]
  size: bigint; // u128 (Amount)
  reference_price: bigint; // u128 (Amount)
  auto_accept: boolean;
  auto_accept_target_rate: bigint; // u128 (Amount)
  allow_partial_fills: boolean;
  min_fill_size: bigint; // u128 (Amount)
  expires_at_ms: bigint; // u64
  rfq_id: Uint8Array; // [u8; 16]
  user_sequence_number: bigint; // u64
  settlement_mode: SettlementMode;
}

/** `CancelRfq` payload. */
export interface CancelRfqEvent {
  user: Uint8Array;
  rfq_id: Uint8Array;
  reason: string;
}

/** `PlaceQuote` payload. Note: `maker`, NOT `user`. */
export interface PlaceQuoteEvent {
  maker: Uint8Array;
  rfq_id: Uint8Array; // [u8; 16]
  quote_id: Uint8Array; // [u8; 16]
  rate: bigint;
  fill_size: bigint;
  user_sequence_number: bigint;
}

/** `AcceptQuote` payload. Note: `taker` field, plus `trade_id` (NOT `rfq_id`). */
export interface AcceptQuoteEvent {
  taker: Uint8Array;
  quote_id: Uint8Array; // [u8; 16]
  trade_id: Uint8Array; // [u8; 16]
  user_sequence_number: bigint;
}

/** `WithdrawQuote` payload. */
export interface WithdrawQuoteEvent {
  maker: Uint8Array;
  quote_id: Uint8Array; // [u8; 16]
}

/** `WithdrawRequested` payload. */
export interface WithdrawRequestedEvent {
  user: Uint8Array;
  asset: Uint8Array;
  amount: bigint; // u128
  /**
   * AssetId the protocol withdrawal fee is paid in. v1: always SUPRA
   * (matches the Rust constant in `protocol/src/fees.rs`). Future
   * USD-pegged variants may switch per chain config.
   *
   * Wire position: AFTER `amount`, BEFORE `withdrawal_id` — must
   * match Rust `events::WithdrawRequested` exactly. Existing BCS
   * fixtures from before this field was added will fail to decode
   * (the explorer reader returns null for them, which the renderer
   * already handles as "unknown event").
   */
  fee_asset: Uint8Array;
  /**
   * Fee amount in `fee_asset` micro-units. dApp computes via
   * `computeWithdrawalFee(amount, asset)`; validator re-computes
   * and rejects on mismatch.
   */
  fee_amount: bigint;
  withdrawal_id: bigint; // u64
  dest_chain: string;
  dest_address: Uint8Array; // Vec<u8>
  deadline_ms: bigint; // u64
  user_sequence_number: bigint;
}

/**
 * One entry of a delegate's per-asset cap map (Option B). Mirrors the
 * Rust `policy::AssetCap` keyed by its `AssetId`. DENY semantics — an
 * asset with no entry is not tradeable by the delegate.
 */
export interface AssetCapEntry {
  /** 32-byte AssetId. */
  asset: Uint8Array;
  /** Per-trade cap (Amount, micro-units). 0n = authorized, unlimited. */
  maxTradeSize: bigint;
  /** Cumulative open-earmark cap. 0n = authorized, unlimited. */
  maxEarmarkTotal: bigint;
}

/** `DelegatePolicyCreated` payload. Used for session bootstrap. */
export interface DelegatePolicyCreatedEvent {
  master: Uint8Array;
  delegate: Uint8Array;
  label: string;
  allowed_roles: DelegateRole[];
  allowed_pairs: Uint8Array[]; // Vec<PairId> = Vec<[u8; 32]>
  /**
   * Per-asset caps — a BCS `BTreeMap<AssetId, AssetCap>`. DENY
   * semantics: an asset absent from this list is not tradeable.
   * See `docs/handoffs/option-b-per-asset-caps-design.md`.
   */
  asset_caps: AssetCapEntry[];
  /**
   * Batch number at which this delegation EXPIRES — the on-chain
   * session bound (#25 H10). `0n` = never expires. Once consensus
   * reaches this batch, `check_delegate_policy` rejects every
   * delegated action, so a leaked delegate key is time-bounded even
   * if the master never submits a revoke. Carried in the signed
   * envelope so the master cryptographically commits to the lifetime.
   * Wire position: AFTER `asset_caps`, BEFORE `user_sequence_number`
   * — must match Rust `events::DelegatePolicyCreated` exactly.
   */
  expires_at_batch: bigint;
  user_sequence_number: bigint;
}

// ─── Per-variant encoders ─────────────────────────────────────────

function writeSubmitRfq(w: BcsWriter, e: SubmitRfqEvent): void {
  w.fixed(e.user, 32, "user");
  w.fixed(e.pair, 32, "pair");
  w.fixed(e.base_asset, 32, "base_asset");
  w.fixed(e.quote_asset, 32, "quote_asset");
  w.u128(e.size);
  w.u128(e.reference_price);
  w.bool(e.auto_accept);
  w.u128(e.auto_accept_target_rate);
  w.bool(e.allow_partial_fills);
  w.u128(e.min_fill_size);
  w.u64(e.expires_at_ms);
  w.fixed(e.rfq_id, 16, "rfq_id");
  w.u64(e.user_sequence_number);
  writeSettlementMode(w, e.settlement_mode);
}

function writeCancelRfq(w: BcsWriter, e: CancelRfqEvent): void {
  w.fixed(e.user, 32, "user");
  w.fixed(e.rfq_id, 16, "rfq_id");
  w.str(e.reason);
}

function writePlaceQuote(w: BcsWriter, e: PlaceQuoteEvent): void {
  w.fixed(e.maker, 32, "maker");
  w.fixed(e.rfq_id, 16, "rfq_id");
  w.fixed(e.quote_id, 16, "quote_id");
  w.u128(e.rate);
  w.u128(e.fill_size);
  w.u64(e.user_sequence_number);
}

function writeAcceptQuote(w: BcsWriter, e: AcceptQuoteEvent): void {
  w.fixed(e.taker, 32, "taker");
  w.fixed(e.quote_id, 16, "quote_id");
  w.fixed(e.trade_id, 16, "trade_id");
  w.u64(e.user_sequence_number);
}

function writeWithdrawQuote(w: BcsWriter, e: WithdrawQuoteEvent): void {
  w.fixed(e.maker, 32, "maker");
  w.fixed(e.quote_id, 16, "quote_id");
}

function writeWithdrawRequested(w: BcsWriter, e: WithdrawRequestedEvent): void {
  w.fixed(e.user, 32, "user");
  w.fixed(e.asset, 32, "asset");
  w.u128(e.amount);
  w.fixed(e.fee_asset, 32, "fee_asset");
  w.u128(e.fee_amount);
  w.u64(e.withdrawal_id);
  w.str(e.dest_chain);
  w.varBytes(e.dest_address);
  w.u64(e.deadline_ms);
  w.u64(e.user_sequence_number);
}

/** Lexicographic compare of two byte arrays (BCS map-key ordering). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * BCS-encode `asset_caps` as a `BTreeMap<AssetId, AssetCap>`:
 * `ULEB128(count)` then entries **sorted by AssetId bytes ascending**
 * — BCS map canonicality. Rust `bcs` produces exactly this; a wrong
 * sort yields a valid-but-non-canonical envelope the validator
 * rejects. Duplicate keys are rejected (a `BTreeMap` has none).
 */
function writeAssetCaps(w: BcsWriter, caps: AssetCapEntry[]): void {
  const sorted = [...caps].sort((a, b) => compareBytes(a.asset, b.asset));
  for (let i = 1; i < sorted.length; i++) {
    if (compareBytes(sorted[i - 1].asset, sorted[i].asset) === 0) {
      throw new Error("writeAssetCaps: duplicate AssetId in asset_caps");
    }
  }
  w.uleb128(sorted.length);
  for (const entry of sorted) {
    w.fixed(entry.asset, 32, "asset_cap.asset");
    w.u128(entry.maxTradeSize);
    w.u128(entry.maxEarmarkTotal);
  }
}

function writeDelegatePolicyCreated(
  w: BcsWriter,
  e: DelegatePolicyCreatedEvent,
): void {
  w.fixed(e.master, 32, "master");
  w.fixed(e.delegate, 32, "delegate");
  w.str(e.label);
  w.vec(e.allowed_roles, writeDelegateRole);
  w.vec(e.allowed_pairs, (ww, p) => ww.fixed(p, 32, "pair"));
  writeAssetCaps(w, e.asset_caps);
  // #25 H10: on-chain session expiry. u64 LE, AFTER asset_caps and
  // BEFORE user_sequence_number — matches the Rust field order.
  w.u64(e.expires_at_batch);
  w.u64(e.user_sequence_number);
}

/** Master-signed `DelegatePolicyRevoked` writer. Symmetric to
 *  `readDelegatePolicyRevoked` further down. Was missing until
 *  2026-06-01 — every revoke envelope sent before this date threw
 *  "encoder not implemented" and the on-chain delegate kept its
 *  authorization. Wire shape: master[32] || delegate[32] ||
 *  user_sequence_number[u64 LE]. Matches Rust
 *  `council_protocol::events::DelegatePolicyRevoked` exactly. */
function writeDelegatePolicyRevoked(
  w: BcsWriter,
  e: DelegatePolicyRevokedEvent,
): void {
  w.fixed(e.master, 32, "master");
  w.fixed(e.delegate, 32, "delegate");
  w.u64(e.user_sequence_number);
}

function writeDelegatePolicyUpdated(
  w: BcsWriter,
  e: DelegatePolicyUpdatedEvent,
): void {
  w.fixed(e.master, 32, "master");
  w.fixed(e.delegate, 32, "delegate");
  w.str(e.label);
  w.vec(e.allowed_roles, writeDelegateRole);
  w.vec(e.allowed_pairs, (ww, p) => ww.fixed(p, 32, "pair"));
  writeAssetCaps(w, e.asset_caps);
  w.bool(e.active);
  w.u64(e.user_sequence_number);
}

/** Taker on-chain settlement claim. Bumps taker's sequence number;
 *  no balance change (claim only — bridge attesters verify later). */
export interface TakerTxPendingEvent {
  trade_id: Uint8Array;       // [u8; 16]
  taker: Uint8Array;          // 32-byte AccountId
  source_chain: string;
  source_tx: Uint8Array;      // [u8; 32]
  user_sequence_number: bigint;
}

/** Maker on-chain settlement claim. Bumps maker's sequence number. */
export interface MakerTxPendingEvent {
  trade_id: Uint8Array;       // [u8; 16]
  maker: Uint8Array;          // 32-byte AccountId
  source_chain: string;
  source_tx: Uint8Array;      // [u8; 32]
  user_sequence_number: bigint;
}

/** Master-signed delegate-policy update. Same shape as Created plus
 *  an `active` flag inserted between max_earmark_total + sequence. */
export interface DelegatePolicyUpdatedEvent {
  master: Uint8Array;
  delegate: Uint8Array;
  label: string;
  allowed_roles: DelegateRole[];
  allowed_pairs: Uint8Array[];
  /** Per-asset caps — see `AssetCapEntry`. BCS `BTreeMap<AssetId, AssetCap>`. */
  asset_caps: AssetCapEntry[];
  active: boolean;
  user_sequence_number: bigint;
}

/** Master-signed delegate-policy revocation. Removes the policy
 *  entirely; in-flight earmarks are NOT auto-cleared. */
export interface DelegatePolicyRevokedEvent {
  master: Uint8Array;
  delegate: Uint8Array;
  user_sequence_number: bigint;
}

/** Master-signed link revocation. Removes (chain, address) from the
 *  user's linked_addresses + clears the address_to_master reverse index. */
export interface LinkedAddressRevokedEvent {
  /** Master account (32 bytes). */
  user: Uint8Array;
  /** Foreign chain id ("eth-sepolia", "supra-testnet", ...). */
  chain: string;
  /** Foreign address bytes (variable length per chain). */
  address: Uint8Array;
  /** Strict-next sequence number for the master. */
  user_sequence_number: bigint;
}

function writeLinkedAddressRevoked(
  w: BcsWriter,
  e: LinkedAddressRevokedEvent,
): void {
  w.fixed(e.user, 32, "user");
  w.str(e.chain);
  w.varBytes(e.address);
  w.u64(e.user_sequence_number);
}

// ─── Public API: encode an Event (variant tag + body) ─────────────

/**
 * Tagged-union shape for the user-event encoder. Each `kind` maps
 * 1-1 to a Rust `Event` variant we support; the discriminator
 * determines the BCS variant tag and which struct schema is used
 * for the body.
 */
export type UserEvent =
  | { kind: "DepositCredited"; payload: DepositCreditedEvent }
  | { kind: "SubmitRfq"; payload: SubmitRfqEvent }
  | { kind: "CancelRfq"; payload: CancelRfqEvent }
  | { kind: "PlaceQuote"; payload: PlaceQuoteEvent }
  | { kind: "AcceptQuote"; payload: AcceptQuoteEvent }
  | { kind: "WithdrawQuote"; payload: WithdrawQuoteEvent }
  | { kind: "WithdrawRequested"; payload: WithdrawRequestedEvent }
  | { kind: "TakerTxPending"; payload: TakerTxPendingEvent }
  | { kind: "MakerTxPending"; payload: MakerTxPendingEvent }
  | { kind: "DelegatePolicyCreated"; payload: DelegatePolicyCreatedEvent }
  | { kind: "DelegatePolicyUpdated"; payload: DelegatePolicyUpdatedEvent }
  | { kind: "DelegatePolicyRevoked"; payload: DelegatePolicyRevokedEvent }
  | { kind: "LinkedAddressRevoked"; payload: LinkedAddressRevokedEvent };

/**
 * BCS-encode a user-originated `Event`. Returns the bytes the user
 * signs (becomes `event_bcs` in the `SignedEventEnvelope`).
 *
 * Pure function. Same input → same bytes, every time.
 */
export function encodeUserEvent(ev: UserEvent): Uint8Array {
  const w = new BcsWriter();
  switch (ev.kind) {
    case "SubmitRfq":
      w.uleb128(TAG_SUBMIT_RFQ);
      writeSubmitRfq(w, ev.payload);
      break;
    case "CancelRfq":
      w.uleb128(TAG_CANCEL_RFQ);
      writeCancelRfq(w, ev.payload);
      break;
    case "PlaceQuote":
      w.uleb128(TAG_PLACE_QUOTE);
      writePlaceQuote(w, ev.payload);
      break;
    case "AcceptQuote":
      w.uleb128(TAG_ACCEPT_QUOTE);
      writeAcceptQuote(w, ev.payload);
      break;
    case "WithdrawQuote":
      w.uleb128(TAG_WITHDRAW_QUOTE);
      writeWithdrawQuote(w, ev.payload);
      break;
    case "WithdrawRequested":
      w.uleb128(TAG_WITHDRAW_REQUESTED);
      writeWithdrawRequested(w, ev.payload);
      break;
    case "DelegatePolicyCreated":
      w.uleb128(TAG_DELEGATE_POLICY_CREATED);
      writeDelegatePolicyCreated(w, ev.payload);
      break;
    case "DelegatePolicyUpdated":
      w.uleb128(TAG_DELEGATE_POLICY_UPDATED);
      writeDelegatePolicyUpdated(w, ev.payload);
      break;
    case "LinkedAddressRevoked":
      w.uleb128(TAG_LINKED_ADDRESS_REVOKED);
      writeLinkedAddressRevoked(w, ev.payload);
      break;
    case "DelegatePolicyRevoked":
      w.uleb128(TAG_DELEGATE_POLICY_REVOKED);
      writeDelegatePolicyRevoked(w, ev.payload);
      break;
    case "TakerTxPending":
    case "MakerTxPending":
      // Decode-only support today: these variants are added so the
      // projection-from-mirror endpoints can READ them out of
      // `council_event_chain`, but no UI flow signs them yet. If/when
      // a UI flow needs to sign one, add the encoder symmetrically
      // (the Rust struct shape is documented in events.rs).
      throw new Error(
        `encodeUserEvent: ${ev.kind} is decode-only; encoder not implemented`,
      );
  }
  return w.finish();
}

// ─── BCS reader + decoders ────────────────────────────────────────
//
// Inverse of BcsWriter + encodeUserEvent. Used by the explorer +
// projection logic to surface decoded fields from `payload_bcs_hex`
// in council_event_chain. Decoders are paired with the encoders
// above; any change to a struct field order MUST be reflected in
// both, and the cross-language fixture round-trips guard against
// drift (`tests/unit/council-sign-event.test.ts`).

class BcsReader {
  private off = 0;
  constructor(private readonly buf: Uint8Array) {}

  private take(n: number): Uint8Array {
    if (this.off + n > this.buf.length) {
      throw new Error(
        `BcsReader: out of bounds (need ${n} bytes at off ${this.off}, len ${this.buf.length})`,
      );
    }
    const out = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }

  fixed(n: number): Uint8Array {
    return new Uint8Array(this.take(n));
  }

  varBytes(): Uint8Array {
    const len = this.uleb128();
    return new Uint8Array(this.take(len));
  }

  str(): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.varBytes());
  }

  uleb128(): number {
    let result = 0;
    let shift = 0;
    while (true) {
      if (this.off >= this.buf.length) {
        throw new Error("BcsReader: truncated ULEB128");
      }
      const byte = this.buf[this.off++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift >= 35) throw new Error("BcsReader: ULEB128 exceeds u32");
    }
  }

  u8(): number {
    return this.take(1)[0];
  }

  u64(): bigint {
    const b = this.take(8);
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
  }

  u128(): bigint {
    const b = this.take(16);
    const view = new DataView(b.buffer, b.byteOffset, 16);
    const lo = view.getBigUint64(0, true);
    const hi = view.getBigUint64(8, true);
    return (hi << BigInt(64)) | lo;
  }

  bool(): boolean {
    const b = this.u8();
    if (b !== 0 && b !== 1) {
      throw new Error(`BcsReader: invalid bool byte ${b}`);
    }
    return b === 1;
  }

  /** Bytes consumed so far. Useful for debug + length asserts. */
  position(): number {
    return this.off;
  }

  /** Bytes remaining. Should be 0 after a complete decode. */
  remaining(): number {
    return this.buf.length - this.off;
  }
}

// ─── Per-variant decoders (mirror order of writeXxx above) ────────

function readDepositCredited(r: BcsReader): DepositCreditedEvent {
  const user = r.fixed(32);
  const asset = r.fixed(32);
  const amount = r.u128();
  const source_chain = r.str();
  const source_tx = r.fixed(32);
  const deposit_id = r.u64();
  const source_block = r.u64();
  const validatorsCount = r.uleb128();
  const attesting_validators: Uint8Array[] = [];
  for (let i = 0; i < validatorsCount; i++) {
    attesting_validators.push(r.fixed(32));
  }
  const sigsCount = r.uleb128();
  const attestations: Uint8Array[] = [];
  for (let i = 0; i < sigsCount; i++) {
    attestations.push(r.fixed(64));
  }
  return {
    user,
    asset,
    amount,
    source_chain,
    source_tx,
    deposit_id,
    source_block,
    attesting_validators,
    attestations,
  };
}

function readSubmitRfq(r: BcsReader): SubmitRfqEvent {
  return {
    user: r.fixed(32),
    pair: r.fixed(32),
    base_asset: r.fixed(32),
    quote_asset: r.fixed(32),
    size: r.u128(),
    reference_price: r.u128(),
    auto_accept: r.bool(),
    auto_accept_target_rate: r.u128(),
    allow_partial_fills: r.bool(),
    min_fill_size: r.u128(),
    expires_at_ms: r.u64(),
    rfq_id: r.fixed(16),
    user_sequence_number: r.u64(),
    settlement_mode: readSettlementMode(r),
  };
}

function readCancelRfq(r: BcsReader): CancelRfqEvent {
  return {
    user: r.fixed(32),
    rfq_id: r.fixed(16),
    reason: r.str(),
  };
}

function readPlaceQuote(r: BcsReader): PlaceQuoteEvent {
  return {
    maker: r.fixed(32),
    rfq_id: r.fixed(16),
    quote_id: r.fixed(16),
    rate: r.u128(),
    fill_size: r.u128(),
    user_sequence_number: r.u64(),
  };
}

function readAcceptQuote(r: BcsReader): AcceptQuoteEvent {
  return {
    taker: r.fixed(32),
    quote_id: r.fixed(16),
    trade_id: r.fixed(16),
    user_sequence_number: r.u64(),
  };
}

function readWithdrawQuote(r: BcsReader): WithdrawQuoteEvent {
  return {
    maker: r.fixed(32),
    quote_id: r.fixed(16),
  };
}

function readWithdrawRequested(r: BcsReader): WithdrawRequestedEvent {
  return {
    user: r.fixed(32),
    asset: r.fixed(32),
    amount: r.u128(),
    fee_asset: r.fixed(32),
    fee_amount: r.u128(),
    withdrawal_id: r.u64(),
    dest_chain: r.str(),
    dest_address: r.varBytes(),
    deadline_ms: r.u64(),
    user_sequence_number: r.u64(),
  };
}

/** Exact inverse of `writeLinkedAddressRevoked`. */
function readLinkedAddressRevoked(r: BcsReader): LinkedAddressRevokedEvent {
  return {
    user: r.fixed(32),
    chain: r.str(),
    address: r.varBytes(),
    user_sequence_number: r.u64(),
  };
}

/** Inverse of `writeAssetCaps` — reads the BCS `BTreeMap` entries. */
function readAssetCaps(r: BcsReader): AssetCapEntry[] {
  const count = r.uleb128();
  const out: AssetCapEntry[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      asset: r.fixed(32),
      maxTradeSize: r.u128(),
      maxEarmarkTotal: r.u128(),
    });
  }
  return out;
}

function readDelegatePolicyCreated(r: BcsReader): DelegatePolicyCreatedEvent {
  const master = r.fixed(32);
  const delegate = r.fixed(32);
  const label = r.str();
  // Vec<DelegateRole>
  const allowed_roles_len = r.uleb128();
  const allowed_roles: DelegateRole[] = [];
  for (let i = 0; i < allowed_roles_len; i++) {
    allowed_roles.push(readDelegateRole(r));
  }
  // Vec<PairId>
  const allowed_pairs_len = r.uleb128();
  const allowed_pairs: Uint8Array[] = [];
  for (let i = 0; i < allowed_pairs_len; i++) {
    allowed_pairs.push(r.fixed(32));
  }
  // Read in strict wire order — `asset_caps` then `expires_at_batch`
  // then `user_sequence_number` (#25 H10). Pulled into statements so
  // the read order does not depend on object-literal evaluation order.
  const asset_caps = readAssetCaps(r);
  const expires_at_batch = r.u64();
  const user_sequence_number = r.u64();
  return {
    master,
    delegate,
    label,
    allowed_roles,
    allowed_pairs,
    asset_caps,
    expires_at_batch,
    user_sequence_number,
  };
}

function readTakerTxPending(r: BcsReader): TakerTxPendingEvent {
  return {
    trade_id: r.fixed(16),
    taker: r.fixed(32),
    source_chain: r.str(),
    source_tx: r.fixed(32),
    user_sequence_number: r.u64(),
  };
}

function readMakerTxPending(r: BcsReader): MakerTxPendingEvent {
  return {
    trade_id: r.fixed(16),
    maker: r.fixed(32),
    source_chain: r.str(),
    source_tx: r.fixed(32),
    user_sequence_number: r.u64(),
  };
}

function readDelegatePolicyUpdated(r: BcsReader): DelegatePolicyUpdatedEvent {
  const master = r.fixed(32);
  const delegate = r.fixed(32);
  const label = r.str();
  const allowed_roles_len = r.uleb128();
  const allowed_roles: DelegateRole[] = [];
  for (let i = 0; i < allowed_roles_len; i++) {
    allowed_roles.push(readDelegateRole(r));
  }
  const allowed_pairs_len = r.uleb128();
  const allowed_pairs: Uint8Array[] = [];
  for (let i = 0; i < allowed_pairs_len; i++) {
    allowed_pairs.push(r.fixed(32));
  }
  return {
    master,
    delegate,
    label,
    allowed_roles,
    allowed_pairs,
    asset_caps: readAssetCaps(r),
    active: r.bool(),
    user_sequence_number: r.u64(),
  };
}

function readDelegatePolicyRevoked(r: BcsReader): DelegatePolicyRevokedEvent {
  return {
    master: r.fixed(32),
    delegate: r.fixed(32),
    user_sequence_number: r.u64(),
  };
}

function readSettlementMode(r: BcsReader): SettlementMode {
  const tag = r.uleb128();
  if (tag === 0) return "Platform";
  if (tag === 1) return "OnChain";
  throw new Error(`unknown SettlementMode tag: ${tag}`);
}

function readDelegateRole(r: BcsReader): DelegateRole {
  const tag = r.uleb128();
  if (tag === 0) return "Maker";
  if (tag === 1) return "Taker";
  if (tag === 2) return "Agent";
  throw new Error(`unknown DelegateRole tag: ${tag}`);
}

/**
 * Decode a BCS-encoded `Event` into the corresponding `UserEvent`
 * variant. Reads the variant tag (ULEB128) from the front of the
 * buffer + dispatches.
 *
 * Returns `null` for variants this module doesn't know about
 * (validator-attested events like `DepositCredited`, governance, etc.) —
 * callers should treat that as "decoding deferred to a future
 * version" rather than an error.
 *
 * Throws on truly malformed BCS bytes (truncated, invalid bools, etc).
 *
 * After decoding, `reader.remaining()` should be 0; if not, the
 * payload had trailing bytes (caller-supplied buffer too long, or
 * a struct-field-mismatch bug).
 */
export function decodeUserEvent(bcs: Uint8Array): UserEvent | null {
  const r = new BcsReader(bcs);
  const tag = r.uleb128();
  let result: UserEvent | null = null;
  switch (tag) {
    case TAG_DEPOSIT_CREDITED:
      result = { kind: "DepositCredited", payload: readDepositCredited(r) };
      break;
    case TAG_SUBMIT_RFQ:
      result = { kind: "SubmitRfq", payload: readSubmitRfq(r) };
      break;
    case TAG_CANCEL_RFQ:
      result = { kind: "CancelRfq", payload: readCancelRfq(r) };
      break;
    case TAG_PLACE_QUOTE:
      result = { kind: "PlaceQuote", payload: readPlaceQuote(r) };
      break;
    case TAG_ACCEPT_QUOTE:
      result = { kind: "AcceptQuote", payload: readAcceptQuote(r) };
      break;
    case TAG_WITHDRAW_QUOTE:
      result = { kind: "WithdrawQuote", payload: readWithdrawQuote(r) };
      break;
    case TAG_WITHDRAW_REQUESTED:
      result = {
        kind: "WithdrawRequested",
        payload: readWithdrawRequested(r),
      };
      break;
    case TAG_TAKER_TX_PENDING:
      result = { kind: "TakerTxPending", payload: readTakerTxPending(r) };
      break;
    case TAG_MAKER_TX_PENDING:
      result = { kind: "MakerTxPending", payload: readMakerTxPending(r) };
      break;
    case TAG_DELEGATE_POLICY_CREATED:
      result = {
        kind: "DelegatePolicyCreated",
        payload: readDelegatePolicyCreated(r),
      };
      break;
    case TAG_DELEGATE_POLICY_UPDATED:
      result = {
        kind: "DelegatePolicyUpdated",
        payload: readDelegatePolicyUpdated(r),
      };
      break;
    case TAG_DELEGATE_POLICY_REVOKED:
      result = {
        kind: "DelegatePolicyRevoked",
        payload: readDelegatePolicyRevoked(r),
      };
      break;
    case TAG_LINKED_ADDRESS_REVOKED:
      result = {
        kind: "LinkedAddressRevoked",
        payload: readLinkedAddressRevoked(r),
      };
      break;
    default:
      // Validator-attested / governance / consensus-internal —
      // outside the user-event scope of this module.
      return null;
  }
  if (r.remaining() !== 0) {
    throw new Error(
      `decodeUserEvent: ${r.remaining()} trailing bytes after ${result.kind}`,
    );
  }
  return result;
}
