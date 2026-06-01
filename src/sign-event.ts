/**
 * Phase 3 of #22: TS-side counterpart of `council-protocol::auth`.
 *
 * Produces and verifies `SignedEventEnvelope` byte-for-byte compatibly
 * with the Rust validator's `auth::verify_and_decode`. Used by:
 *
 *   - The SupraFX UI (browser): signs user-authored events with the
 *     wallet's Ed25519 key, packages into an envelope, POSTs to
 *     `/api/council/submit`.
 *   - The SupraFX server (`/api/council/submit`): re-verifies the
 *     envelope at ingress before forwarding to validator gRPC.
 *     Cheap reject prevents forging-attack traffic from reaching the
 *     chain even before the validator's vote-time gate fires.
 *
 * ## What this module does NOT do
 *
 * - **Encode the Event itself.** This module treats `event_bcs` as
 *   opaque bytes. The caller is responsible for producing them in
 *   canonical BCS so the validator can decode. A separate module
 *   (`lib/council/event-bcs.ts`, Phase 3.2) provides per-variant
 *   BCS encoders mirroring `council_protocol::events::Event`.
 * - **Talk to the wallet.** StarKey signing happens in the UI layer
 *   (see `lib/starkey.ts`); this module accepts a raw signing key
 *   or a callback that returns a sig over the sign-bytes.
 *
 * ## Cryptographic contract (matches Rust auth.rs)
 *
 * Address derivation:
 *   `auth_key = SHA3-256(pubkey ‖ 0x00)` — Aptos / Supra layout.
 *   Source: `node_modules/supra-l1-sdk-core` `AuthenticationKey.ED25519_SCHEME = 0`.
 *
 * Sign bytes:
 *   `b"SUPRAFX-USER-EVENT-V1" ‖ chain_id_hash[32] ‖ event_bcs`
 *   - DST domain-separates from any other sig context.
 *   - chain_id_hash prevents cross-chain replay.
 *
 * Wire envelope (BCS-encoded via this module's `encodeEnvelopeBcs`):
 *   ```
 *   struct SignedEventEnvelope {
 *     event_bcs: Vec<u8>,        // length-prefixed via BCS ULEB128
 *     signer_pubkey: [u8; 32],   // fixed
 *     signer_sig: [u8; 64],      // fixed (with serde-big-array on Rust side)
 *   }
 *   ```
 *
 * BCS encoding rules used here:
 *   - `Vec<u8>` (= `event_bcs`): ULEB128 length, then bytes.
 *   - `[u8; N]` (fixed-size): N bytes, no length prefix.
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { ed25519 } from "@noble/curves/ed25519.js";

/**
 * Header line of the sign-bytes display message — must match Rust
 * `auth::USER_EVENT_SIGN_HEADER` byte-for-byte. Wallets that show
 * the user a human-readable prompt render this as the first line.
 */
export const USER_EVENT_SIGN_HEADER = "SUPRAFX-COUNCIL-SIGN-V1";

/**
 * Backwards-compat alias. Old name; the constant now reflects the
 * new display-message header rather than the legacy raw-bytes DST.
 * Kept so external callers that pinned the symbol name keep working.
 */
export const USER_EVENT_DST = new TextEncoder().encode(USER_EVENT_SIGN_HEADER);

/** Supra Ed25519 scheme byte used in auth-key derivation. */
export const ED25519_SCHEME = 0x00;

/**
 * Wire envelope. Field shapes match the Rust struct exactly so BCS
 * serialization is byte-equivalent.
 */
export interface SignedEventEnvelope {
  /** Canonical BCS encoding of the user's `Event`. Opaque to this module. */
  event_bcs: Uint8Array;
  /** Ed25519 public key of the signer (32 bytes). */
  signer_pubkey: Uint8Array;
  /** Ed25519 signature (64 bytes) over `composeSignBytes(chainIdHash, event_bcs)`. */
  signer_sig: Uint8Array;
}

/**
 * Derive a Supra account address from an Ed25519 public key.
 *
 * `auth_key = SHA3-256(pubkey || 0x00)`. 32-byte output, no truncation.
 * Aligned byte-for-byte with Supra L1 SDK's
 * `AuthenticationKey.fromEd25519PublicKey`.
 *
 * @throws if `pubkey.length !== 32`.
 */
export function deriveSupraAddress(pubkey: Uint8Array): Uint8Array {
  if (pubkey.length !== 32) {
    throw new Error(
      `deriveSupraAddress: pubkey must be 32 bytes, got ${pubkey.length}`,
    );
  }
  const buf = new Uint8Array(33);
  buf.set(pubkey, 0);
  buf[32] = ED25519_SCHEME;
  return sha3_256(buf);
}

/**
 * Compose the canonical bytes the signer signs / verifier checks.
 * Pure function: same inputs always produce identical output.
 *
 * ## Format (V1)
 *
 * The output is a UTF-8 string a wallet can render to the user. Raw
 * event bytes are hashed into the message rather than embedded so the
 * displayed prompt has fixed shape (~173 ASCII chars), and wallets
 * that only sign valid UTF-8 (StarKey's `signMessage`) accept it.
 *
 * ```text
 * SUPRAFX-COUNCIL-SIGN-V1
 * chain: 0x<chain_id_hash_hex_64>
 * payload: 0x<blake3_of_event_bcs_hex_64>
 * ```
 *
 * Security: chain_id_hash blocks cross-chain replay; the BLAKE3 of
 * event_bcs binds the sig to the exact event (substituting any byte
 * yields a different payload hash). Header is the domain-separation
 * tag — sigs over this aren't fungible with sigs from any other
 * SupraFX flow (login session, genesis attestation, etc.).
 *
 * MUST match Rust `auth::compose_sign_bytes` byte-for-byte. Verified
 * by cross-language fixture in `tests/unit/council-sign-event.test.ts`.
 *
 * @throws if `chainIdHash.length !== 32`.
 */
export function composeSignBytes(
  chainIdHash: Uint8Array,
  eventBcs: Uint8Array,
): Uint8Array {
  if (chainIdHash.length !== 32) {
    throw new Error(
      `composeSignBytes: chain_id_hash must be 32 bytes, got ${chainIdHash.length}`,
    );
  }
  const payloadHash = blake3(eventBcs);
  const chainHex = bytesToLowerHex(chainIdHash);
  const payloadHex = bytesToLowerHex(payloadHash);
  const msg = `${USER_EVENT_SIGN_HEADER}\nchain: 0x${chainHex}\npayload: 0x${payloadHex}`;
  return new TextEncoder().encode(msg);
}

function bytesToLowerHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Sign an event-bytes payload with an Ed25519 secret key, producing
 * a `SignedEventEnvelope` ready for BCS-encoding + submission.
 *
 * `secretKey` is the 32-byte Ed25519 seed (NOT the 64-byte
 * extended/hashed form). `@noble/curves/ed25519` derives the public
 * key on demand via `ed25519.getPublicKey(secretKey)`.
 *
 * For wallets that don't expose the secret key (StarKey), use
 * `signEnvelopeWithCallback` instead — it accepts a callback that
 * returns a sig over the supplied bytes.
 */
export function signEnvelope(
  eventBcs: Uint8Array,
  secretKey: Uint8Array,
  chainIdHash: Uint8Array,
): SignedEventEnvelope {
  if (secretKey.length !== 32) {
    throw new Error(
      `signEnvelope: secret key must be 32 bytes, got ${secretKey.length}`,
    );
  }
  const signBytes = composeSignBytes(chainIdHash, eventBcs);
  const sig = ed25519.sign(signBytes, secretKey);
  const pubkey = ed25519.getPublicKey(secretKey);
  return {
    event_bcs: new Uint8Array(eventBcs),
    signer_pubkey: new Uint8Array(pubkey),
    signer_sig: new Uint8Array(sig),
  };
}

/**
 * Sign via a wallet-provided callback (e.g. StarKey's signMessage).
 * The callback receives the canonical sign-bytes and must return the
 * 64-byte Ed25519 signature.
 *
 * `signerPubkey` MUST be the wallet's Ed25519 pubkey — the verifier
 * checks `derive_supra_address(signerPubkey) == event.user`, so a
 * mismatch here will cause silent rejection at the chain.
 */
export async function signEnvelopeWithCallback(
  eventBcs: Uint8Array,
  signerPubkey: Uint8Array,
  chainIdHash: Uint8Array,
  signCallback: (signBytes: Uint8Array) => Promise<Uint8Array>,
): Promise<SignedEventEnvelope> {
  if (signerPubkey.length !== 32) {
    throw new Error(
      `signEnvelopeWithCallback: pubkey must be 32 bytes, got ${signerPubkey.length}`,
    );
  }
  const signBytes = composeSignBytes(chainIdHash, eventBcs);
  const sig = await signCallback(signBytes);
  if (sig.length !== 64) {
    throw new Error(
      `signEnvelopeWithCallback: callback returned ${sig.length}-byte sig, expected 64`,
    );
  }
  return {
    event_bcs: new Uint8Array(eventBcs),
    signer_pubkey: new Uint8Array(signerPubkey),
    signer_sig: new Uint8Array(sig),
  };
}

/**
 * Verify a `SignedEventEnvelope` against a chain_id_hash. Mirrors
 * Rust `auth::verify_and_decode` MINUS the event-decode step (TS
 * doesn't need to materialize the Event — only the chain does).
 *
 * Verification steps:
 *   1. `derive = derive_supra_address(envelope.signer_pubkey)`.
 *   2. (Caller's responsibility) — assert `derive` matches the
 *      `user` field in `event_bcs`. We can't do that here without
 *      the Event schema; the SupraFX submit endpoint runs this
 *      check after BCS-decoding the event.
 *   3. Verify Ed25519 sig over composed sign-bytes.
 *
 * Returns `{ ok: true, derivedAddress }` on pass, or `{ ok: false,
 * reason }` with a typed reason. Errors are NOT thrown — the
 * caller (often a request handler) wants a typed result.
 */
export function verifyEnvelope(
  envelope: SignedEventEnvelope,
  chainIdHash: Uint8Array,
):
  | { ok: true; derivedAddress: Uint8Array }
  | { ok: false; reason: "invalid_pubkey" | "sig_verify_failed" } {
  if (envelope.signer_pubkey.length !== 32) {
    return { ok: false, reason: "invalid_pubkey" };
  }
  if (envelope.signer_sig.length !== 64) {
    return { ok: false, reason: "sig_verify_failed" };
  }
  let derivedAddress: Uint8Array;
  try {
    derivedAddress = deriveSupraAddress(envelope.signer_pubkey);
  } catch {
    return { ok: false, reason: "invalid_pubkey" };
  }
  const signBytes = composeSignBytes(chainIdHash, envelope.event_bcs);
  let valid: boolean;
  try {
    valid = ed25519.verify(envelope.signer_sig, signBytes, envelope.signer_pubkey);
  } catch {
    // @noble/curves throws on malformed pubkey points (off-curve, etc.).
    return { ok: false, reason: "invalid_pubkey" };
  }
  if (!valid) {
    return { ok: false, reason: "sig_verify_failed" };
  }
  return { ok: true, derivedAddress };
}

// ─── BCS encoding for the envelope wire shape ─────────────────────

/**
 * Encode a u32 (or smaller positive int) as BCS ULEB128. Used for
 * the length prefix of `event_bcs: Vec<u8>`.
 */
function encodeUleb128(n: number): Uint8Array {
  if (n < 0 || !Number.isInteger(n)) {
    throw new Error(`encodeUleb128: invalid value ${n}`);
  }
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return new Uint8Array(out);
}

/**
 * BCS-encode a `SignedEventEnvelope` for submission via gRPC's
 * `SubmitEventsRequest.envelopes_bcs` field.
 *
 * Layout (matches the Rust derived `serde::Serialize` + `bcs`):
 *   - `event_bcs: Vec<u8>` → ULEB128 length, then bytes.
 *   - `signer_pubkey: [u8; 32]` → 32 raw bytes (no length prefix).
 *   - `signer_sig: [u8; 64]` → 64 raw bytes (no length prefix; the
 *     Rust side uses `serde-big-array` to make this work but the
 *     wire shape is just 64 bytes).
 */
export function encodeEnvelopeBcs(env: SignedEventEnvelope): Uint8Array {
  if (env.signer_pubkey.length !== 32) {
    throw new Error(
      `encodeEnvelopeBcs: signer_pubkey must be 32 bytes, got ${env.signer_pubkey.length}`,
    );
  }
  if (env.signer_sig.length !== 64) {
    throw new Error(
      `encodeEnvelopeBcs: signer_sig must be 64 bytes, got ${env.signer_sig.length}`,
    );
  }
  const lenPrefix = encodeUleb128(env.event_bcs.length);
  const total = lenPrefix.length + env.event_bcs.length + 32 + 64;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(lenPrefix, off);
  off += lenPrefix.length;
  out.set(env.event_bcs, off);
  off += env.event_bcs.length;
  out.set(env.signer_pubkey, off);
  off += 32;
  out.set(env.signer_sig, off);
  return out;
}

/**
 * Decode a BCS-encoded envelope (inverse of `encodeEnvelopeBcs`).
 * Used by `/api/council/submit` to parse the body before re-verifying
 * at ingress.
 *
 * Throws on malformed input (wrong length, truncated, etc.).
 */
export function decodeEnvelopeBcs(bytes: Uint8Array): SignedEventEnvelope {
  let off = 0;
  // Decode ULEB128 length.
  let eventLen = 0;
  let shift = 0;
  while (true) {
    if (off >= bytes.length) {
      throw new Error("decodeEnvelopeBcs: truncated ULEB128 length");
    }
    const byte = bytes[off];
    off += 1;
    eventLen |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 32) {
      throw new Error("decodeEnvelopeBcs: ULEB128 length exceeds u32");
    }
  }
  const expectedTotal = off + eventLen + 32 + 64;
  if (bytes.length !== expectedTotal) {
    throw new Error(
      `decodeEnvelopeBcs: wrong length (expected ${expectedTotal} from len=${eventLen}, got ${bytes.length})`,
    );
  }
  const event_bcs = bytes.slice(off, off + eventLen);
  off += eventLen;
  const signer_pubkey = bytes.slice(off, off + 32);
  off += 32;
  const signer_sig = bytes.slice(off, off + 64);
  return { event_bcs, signer_pubkey, signer_sig };
}

// ─── Hex helpers (for routes that ship envelopes as JSON) ─────────

/** Lower-case hex without `0x` prefix, matching the Rust hex crate. */
export function bytesToHexLower(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

/** Decode hex (with or without `0x` prefix). Throws on invalid input. */
export function hexToBytes(hex: string): Uint8Array {
  let h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd hex length ${h.length}`);
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`hexToBytes: invalid hex at offset ${i * 2}`);
    }
    out[i] = byte;
  }
  return out;
}
