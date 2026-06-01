# Trading from an external bot (SupraFX delegate signing recipe)

Your master wallet (StarKey) signed off on a delegate's **public key** via the **Delegates** tab. The matching **private key** stays with your bot. With it, your bot can sign trade envelopes locally and POST them to the SupraFX council endpoints — no wallet popup per trade.

This doc gives you the exact signing recipe.

## What you have

After the master signs the policy via the dApp UI, your bot needs:

1. The **delegate private key** (hex, 32 bytes) — downloaded as a JSON file when you clicked **Generate**, or generated yourself.
2. The **delegate Supra address** — derivable from the public key: `address = sha3_256(public_key || 0x00)`.
3. The **chain id hash** from the council genesis — `GET https://suprafx.ai/api/council/chain-id` → `chain_id_hash_hex`.
4. The **next sequence number** for your delegate — `GET https://suprafx.ai/api/council/sequence-number?address=<delegate_address>`.

## What you send

Each trade is a **signed BCS envelope** posted to a per-event endpoint:

| Event | Endpoint | Body field |
|---|---|---|
| `SubmitRfq` | `POST /api/council/submit-rfq` | `submit_rfq_envelope_bcs_hex` |
| `PlaceQuote` | `POST /api/council/place-quote` | `place_quote_envelope_bcs_hex` |
| `AcceptQuote` | `POST /api/council/accept-quote` | `accept_quote_envelope_bcs_hex` |
| `WithdrawQuote` | `POST /api/council/withdraw-quote` | `withdraw_quote_envelope_bcs_hex` |
| `CancelRfq` | `POST /api/council/cancel-rfq` | `cancel_rfq_envelope_bcs_hex` |

The envelope is:

```
SignedEventEnvelope {
  event_bcs:    Vec<u8>,   // BCS-encoded event payload
  signer_pubkey: [u8; 32], // your delegate's ed25519 public key
  signer_sig:   [u8; 64],  // ed25519 sig over compose_sign_bytes(chain_id_hash, event_bcs)
}
```

`compose_sign_bytes` prepends a domain-separator + chain id hash to the event BCS so a signature on chain A can never replay on chain B.

## Node.js / TypeScript recipe

The dApp already ships canonical BCS encoders + envelope helpers — your bot can import them from `lib/council/event-bcs.ts` and `lib/council/sign-event.ts` if you vendor them, or recreate them following the schema documented in those files.

```ts
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { encodeUserEvent } from "./lib/council/event-bcs";
import { encodeEnvelopeBcs, composeSignBytes } from "./lib/council/sign-event";

const DELEGATE_PRIV = hexToBytes("...your 32-byte ed25519 seed..."); // never leaves your machine
const DELEGATE_PUB  = ed25519.getPublicKey(DELEGATE_PRIV);
const DELEGATE_ADDR = sha3_256(new Uint8Array([...DELEGATE_PUB, 0x00])); // 32 bytes

const SUPRAFX_BASE = "https://suprafx.ai";

// 1) chain id hash (one-time per chain)
const chainInfo = await fetch(`${SUPRAFX_BASE}/api/council/chain-id`).then(r => r.json());
const chainIdHash = hexToBytes(chainInfo.chain_id_hash_hex);

// 2) next sequence number for THIS delegate
const seqResp = await fetch(
  `${SUPRAFX_BASE}/api/council/sequence-number?address=0x${bytesToHex(DELEGATE_ADDR)}`,
).then(r => r.json());
const userSeq = BigInt(seqResp.next_sequence_number);

// 3) build the event (PlaceQuote shown; see event-bcs.ts for other shapes)
const eventBcs = encodeUserEvent({
  kind: "PlaceQuote",
  payload: {
    maker: DELEGATE_ADDR,
    rfq_id: hexToBytes("...16 bytes..."),     // the RFQ you're quoting against
    quote_id: randomBytes(16),                 // your client-side quote id
    rate: BigInt("...BFT-scaled rate..."),     // see encodePlaceQuoteAmounts in lib/council/asset-registry
    fill_size: BigInt("...base micro-units..."),
    user_sequence_number: userSeq,
  },
});

// 4) sign + assemble envelope
const signBytes = composeSignBytes(chainIdHash, eventBcs);
const sig = ed25519.sign(signBytes, DELEGATE_PRIV);
const envelopeBcs = encodeEnvelopeBcs({
  event_bcs: eventBcs,
  signer_pubkey: DELEGATE_PUB,
  signer_sig: sig,
});

// 5) POST
const resp = await fetch(`${SUPRAFX_BASE}/api/council/place-quote`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ place_quote_envelope_bcs_hex: bytesToHex(envelopeBcs) }),
});
const result = await resp.json();
// result.ok === true on success; result.detail on failure
```

## How the chain verifies you

When the envelope reaches the council it runs (this is `auth.rs::verify_and_decode` in `council-rust`):

1. `derive_supra_address(signer_pubkey) == event.maker` (or `taker`, `user`, etc.)  
   This is the impersonation defense: an attacker can't substitute their own pubkey because it wouldn't hash to your delegate address.
2. `ed25519.verify(signer_sig, compose_sign_bytes(chain_id_hash, event_bcs), signer_pubkey)`.
3. Look up the delegate policy by address: `policies[(master, delegate)]`.
4. Enforce limits: `active`, `allowed_roles`, `allowed_pairs`, `max_trade_size`, `asset_caps`, `expires_at_batch`.

If any step fails the validators reject and your POST gets a `502` with `code: "auth_failed"` or a per-validator rejection list. No state changes.

## Master revoke

The master can revoke at any time via the Delegates tab — that fires a `DelegatePolicyRevoked` event. Once committed, every subsequent trade from your delegate fails the policy lookup and is rejected by the validators.

## Sequence numbers

Every event from a delegate must use a strictly-monotonic `user_sequence_number`. The chain rejects:

- A duplicate (same `user_sequence_number` already committed) — replay attempt
- A backward (less than the current high water mark) — also a replay attempt
- A skipped value can land out-of-order *within* a small window, but you should treat sequence numbers as opaque counters you fetch from `/api/council/sequence-number` then increment locally.

Persist the next-expected sequence number in your bot's local state. If a POST fails with `code: "no_quorum"` and **all** per-validator errors look like network failures (timeouts, ECONNREFUSED, etc.), the chain didn't see the event — *decrement* the sequence number and retry. If even one validator returns a chain-level rejection, the chain did see it — keep the sequence advanced.

## Reference implementations

The dApp itself uses these endpoints for the user's own trading. See:

- `lib/council/submit-rfq-helper.ts` — full reference impl for `SubmitRfq`
- `lib/council/shadow-write.ts` — dispatcher for `PlaceQuote` / `AcceptQuote` / `CancelRfq` / `WithdrawQuote`
- `lib/council/event-bcs.ts` — canonical BCS encoders + payload type definitions
- `lib/council/sign-event.ts` — `composeSignBytes` + `encodeEnvelopeBcs`

The Rust validator side is in `council-rust/crates/protocol/src/auth.rs` (`verify_and_decode`) and `council-rust/crates/protocol/src/state.rs` (`check_delegate_policy`).
