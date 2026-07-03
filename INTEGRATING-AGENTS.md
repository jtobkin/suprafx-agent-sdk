# Integrating Agents with SupraFX

This document is the canonical reference for building an autonomous agent
(market maker, trader, arbitrageur, or anything else) on top of SupraFX.

SupraFX is BFT-consensus settlement infrastructure for cross-chain swaps.
The public endpoints at `https://suprafx.ai` are stable and designed for
programmatic access. An agent that signs locally and POSTs to these
endpoints is a first-class participant on the chain — the same path the
official web dApp uses for every trade.

If you only want to run a market maker, skip ahead to §7.

---

## 1. Mental model

**Master account.** The Supra wallet (e.g. StarKey) that controls the
funds. Holds the L1 deposits, signs identity events
(`LinkedAddressVerified`), pays withdrawal fees. Authorizes delegates.

**Delegate account.** A separate ed25519 keypair the master has authorized
on chain via a `DelegatePolicyCreated` event. Holds NO funds — its
balance row is always empty. Can sign trade events that LOCK and MOVE
the master's balance, subject to per-asset caps.

**The chain enforces what a delegate can do.** Each authorized delegate
has:
- a list of allowed roles (`Maker`, `Taker`)
- an optional pair allowlist (empty = any pair)
- a per-asset map of `(max_trade_size, max_earmark_total)` caps
- an `expires_at_batch` deadline (after which every signed event is
  rejected, even if the master never sends a revoke)
- an `active` flag (master can flip to `false` at any time via the
  Delegates tab in `/profile`)

This is the security model. A leaked delegate key can do at most what
the on-chain policy allows, and is automatically expired by the
`expires_at_batch` deadline. There is no key on your machine that can
drain master funds beyond those bounds.

**Settlement modes.** SupraFX supports two:

- `Platform` — fills settle in the internal ledger. Fast (sub-second
  finality after the chain commits the matched batch). Funds remain
  custodied by the council until withdraw. Recommended for high-frequency
  trading and the common case.
- `OnChain` — fills produce on-chain L1 settlement instructions. Slower
  (depends on L1 confirmation depth) but trustless settlement on the
  source/destination chains. Recommended for large cross-chain
  swaps where the user wants L1 finality.

You specify the mode per RFQ. Quotes inherit from the RFQ.

**Auto-accept (taker pre-commit).** A taker can submit an RFQ with
`auto_accept = true` and an `auto_accept_target_rate`. The chain then
settles the FIRST maker quote whose rate is at or better than that
target **automatically, in the same batch the quote lands** — no
separate `AcceptQuote` is sent, and the taker can be completely offline.
Two consequences every agent must internalize:

- **For takers:** the target rate is a *cryptographic price floor*. The
  chain will never auto-fire (and will never let anyone manually accept)
  a quote worse than it — even if your session key is compromised. Set
  it to the worst rate you're willing to take. `auto_accept = true` with
  `auto_accept_target_rate = 0` is rejected at submit time.
- **For makers:** quoting *below* an auto-accept RFQ's target is a dead
  end — the chain refuses to accept it (manual or auto). To win an
  auto-accept RFQ, quote at or above its target; you then settle
  instantly with no taker round-trip. The target is public on the RFQ
  payload (`auto_accept_target_rate`).

`auto_accept = false` (the default) keeps the taker in control: quotes
just accumulate on the book and the taker decides when (and whether) to
`AcceptQuote`. Use `false` when you want to shop quotes; use `true` when
you want hands-off execution at a known floor. See §6 for the full set
of strategies these primitives unlock.

**Partial fills.** By default an RFQ is all-or-nothing: a quote must fill
the entire remaining size or it's rejected. Set `allow_partial_fills =
true` (and a `min_fill_size`) to let makers fill a *slice*:

- A maker may quote a `fill_size` anywhere from `min_fill_size` up to the
  RFQ's remaining size. If a maker over-quotes (asks for more than
  remains), the chain **caps-and-fills** to the remaining size — it never
  over-locks the maker.
- After a partial fill the RFQ **stays open** with a decremented
  `remaining_size`, accepting further quotes until it's fully filled (or
  cancelled). `min_fill_size` is your dust guard — it's the smallest
  slice you'll accept, enforced on the *actual* settled amount.
- This is what lets a single large RFQ be filled by many small makers.

**Auto-accept + partial fills (compose them).** The two combine into the
most powerful passive-taker pattern: submit one large RFQ with
`auto_accept = true`, a target floor, AND `allow_partial_fills = true`.
Now **every** maker quote that clears your floor (and meets
`min_fill_size`) auto-settles its slice the instant it lands, and the
RFQ keeps absorbing more until it's full — all with the taker offline,
no per-fill clicks, every fill guaranteed at or better than your price.
It's a resting limit order that fills incrementally against the maker
crowd.

**Fees.** Two deterministic fees apply. Model both or your PnL will be
wrong.

- *Trade fee.* Every settled trade charges the **taker 5 bps (0.05%)**
  of the quote-asset notional and pays the **maker a 1 bp (0.01%)
  rebate**; the protocol keeps the **4 bps** difference. The taker fee
  is netted out of what the taker receives at settlement — it does NOT
  change the on-chain `rate`, only the settled amounts. As a taker,
  quote a rate that clears your costs plus the 5 bps; as a maker, fold
  the +1 bp rebate into your edge.
- *Withdrawal fee.* Moving funds OFF the platform to an L1 chain costs a
  flat **4000 SUPRA**, enforced on-chain and **always paid in SUPRA** —
  even when withdrawing a non-SUPRA asset. The master must hold ≥ 4000
  SUPRA available (plus the principal if withdrawing SUPRA itself), or
  the withdrawal is rejected. This is a master/dApp action, not an agent
  trade — there is no withdraw tool in the SDK — but the humans behind
  your agent need to budget for it to realize PnL. Trading never
  triggers it.

**Asset semantics.** Every asset on SupraFX is identified by a 32-byte
`AssetId`, derived deterministically from `(canonical_chain_id,
token_bytes)`. The canonical chain id is the bridge identifier
(`eth-mainnet`, `supra-mainnet`, etc.). The token bytes are the L1
contract address (20 bytes for EVM, 32 for Supra), or zero for native.
See `lib/council/derive-ids.ts` for the registry and exact derivation.

**Pair semantics.** A pair is a 32-byte hash of
`(base_asset_id, quote_asset_id)` in that order. `(ETH, USDC)` is a
different pair than `(USDC, ETH)`. The "base" is what the taker gives
up; the "quote" is what the taker receives.

---

## Gotchas (hard-won — read before you build)

Non-obvious things that cost real debugging time:

1. **The orderbook "feed" is poll-oriented, not a durable stream.**
   `GET /api/orderbook/feed?pairs=…` emits a single `connected` event
   carrying `{"pollInterval":1000}` and does **not** hold an open SSE
   stream — a long-lived `EventSource` will "error and reconnect" every
   ~60s and miss RFQs in the gaps. **Poll the REST orderbook instead:**
   `GET /api/suprafx/rfqs?scope=platform&status=open&limit=100` every
   ~1–2s, diffing against RFQ ids you've already handled.

2. **Prices come from `/api/oracle`, not from the RFQ.** Use
   `GET /api/oracle?pair=SUPRA/USDC` → `conversionRate` = **quote per
   base** (e.g. USDC per SUPRA). The RFQ's own `reference_price` can be
   `0` on some directions, so don't rely on it for pricing. This is the
   same oracle the dApp shows (it wraps Supra's native feed).

3. **Direction is encoded by pair order — to BUY an asset, quote the
   pair where it's the _base_.** `BASE/QUOTE` = taker sells BASE,
   receives QUOTE; the maker pays QUOTE and receives BASE. So to
   accumulate SUPRA you quote `SUPRA/<quote>` RFQs (someone selling
   SUPRA), paying the quote asset. Quoting `<quote>/SUPRA` does the
   opposite — it sells your SUPRA.

4. **Delegate caps are deny-by-default, per asset.** An asset with no
   cap (or a cap of `0`) cannot be traded at all (fail-closed). The
   **maker locks the QUOTE asset; the taker locks the BASE asset** — so
   enable + fund a cap for every asset you actually *pay*, not just the
   one you want to receive.

5. **The delegate private key is single-copy.** If you use the site's
   "Generate", the key JSON downloads **only after** the master
   signature commits on chain, and there is no re-download. The more
   robust path: generate the ed25519 keypair locally (see
   `cookbook/00-generate-delegate-key.ts`), paste only the **public**
   key into the delegate form — the secret never touches the browser.

6. **`body.ok` is the truth signal, not the HTTP status.** A write can
   return HTTP 200 with `{ ok: false, code, detail }`. Always branch on
   `body.ok`; read `detail` for the human-readable reason. See the error
   catalog in §7.

---

## 2. The dApp endpoints

All hosted at `https://suprafx.ai`. No authentication for reads; writes
are authenticated by the embedded ed25519 signature in the envelope.

### Read endpoints

| Endpoint | What it returns |
|---|---|
| `GET /api/council/chain-info` | `{chainId, chainIdHashHex, threshold}` — needed to compose sign-bytes |
| `GET /api/council/chain-id` | Same `chain_id_hash_hex` (legacy alias) |
| `GET /api/council/current-batch` | Current committed batch height — useful for `expires_at_batch` math |
| `GET /api/council/sequence-number?address=0x...` | The next strictly-monotonic sequence number this delegate must use |
| `GET /api/assets` | Supported assets with canonical chain id, symbol, contract address, decimals |
| `GET /api/platform/balances?address=0x<master>` | Master's available + locked balances per asset |
| `GET /api/suprafx/rfqs?scope=platform&status=open` | Public orderbook RFQs |
| `GET /api/suprafx/rfqs?scope=platform&status=open&pair=ETH/USDC` | Filter by pair |
| `GET /api/orderbook/feed?pairs=ETH/USDC,WBTC/USDC` | Server-Sent Events stream of orderbook updates |

The SSE feed at `/api/orderbook/feed` is the recommended way to drive a
market maker. Event types:

- `rfq_created` — a new RFQ landed on the book
- `quote_placed` — someone quoted on an existing RFQ
- `rfq_updated` — RFQ status changed (matched, expired, cancelled)
- `heartbeat` — keepalive every 10s

### Write endpoints

All write endpoints accept a BCS-encoded `SignedEventEnvelope` (the
embedded ed25519 signature is the auth). The dApp validates and forwards
to the validator HTTP shims in parallel; the response tells you whether
the chain accepted, rejected, or deferred.

| Action | Endpoint | Body field |
|---|---|---|
| Submit an RFQ (= become a taker) | `POST /api/council/submit-rfq` | `submit_rfq_envelope_bcs_hex` |
| Quote on an existing RFQ (= become a maker) | `POST /api/council/place-quote` | `place_quote_envelope_bcs_hex` |
| Accept a quote (taker confirms a maker's quote) | `POST /api/council/accept-quote` | `accept_quote_envelope_bcs_hex` |
| Withdraw a pending quote (maker pulls offer) | `POST /api/council/withdraw-quote` | `withdraw_quote_envelope_bcs_hex` |
| Cancel an RFQ (taker pulls) | `POST /api/council/cancel-rfq` | `cancel_rfq_envelope_bcs_hex` |

Response shape, all endpoints:

```json
{
  "ok": true,
  "batch": 117783,
  "event_hash_hex": "..."
}
```

or on a structured rejection:

```json
{
  "ok": false,
  "code": "gate_rejected",
  "detail": "submit_rfq: no balance row for funds_owner/base_asset <hex>",
  "per_validator": [ ... ]
}
```

The truth signal is `body.ok`, not the HTTP status code. Cloudflare in
front of the dApp may rewrite 5xx bodies to empty; the dApp's submit
route therefore returns HTTP 200 for all structured outcomes.

---

## 3. Setting up a delegate

The master authorizes the delegate ONCE via the web dApp. After that the
agent runs autonomously.

**Step-by-step (master side, in the dApp UI):**

1. Connect StarKey at `https://suprafx.ai` (master wallet).
2. Open `/profile → Delegates`.
3. Click **Create Delegate**.
4. Either click **Generate** (the dApp creates a keypair, returns the
   private key as a downloadable JSON file you save locally), or paste
   a public key you generated externally.
5. Set the per-asset caps, allowed roles, allowed pairs.
6. Sign with StarKey. The `DelegatePolicyCreated` event commits.

**On the agent side, you now have:**

- The delegate's 32-byte ed25519 private key (hex).
- The delegate's Supra address: `sha3_256(public_key || 0x00)`.
- The master's address (the connected StarKey at signing time).

**Sanity checks the agent should do at startup:**

```ts
// Verify the policy is on chain + still active.
const r = await fetch(
  `https://suprafx.ai/api/delegate-policy?delegate=0x<delegate-address>`,
);
const { policy } = await r.json();
if (!policy || !policy.active) {
  throw new Error("delegate policy not active on chain — re-bootstrap via dApp");
}

// Verify the sequence number the agent has stored matches chain expectation.
const seq = await fetch(
  `https://suprafx.ai/api/council/sequence-number?address=0x<delegate-address>`,
).then(r => r.json());
if (seq.next_sequence_number < myLocalNextSeq) {
  throw new Error("local seq is ahead of chain — drift bug, reconcile");
}
```

---

## 4. Signing the envelope

This is the canonical recipe for every write endpoint. The dApp uses
the same code paths in `lib/council/event-bcs.ts` and
`lib/council/sign-event.ts` — vendor them, or recreate them following
the schemas documented inline.

```ts
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { encodeUserEvent } from "./lib/council/event-bcs";
import { encodeEnvelopeBcs, composeSignBytes } from "./lib/council/sign-event";

const DELEGATE_PRIV = hexToBytes("...your 32-byte ed25519 seed...");
const DELEGATE_PUB  = ed25519.getPublicKey(DELEGATE_PRIV);
const DELEGATE_ADDR = sha3_256(new Uint8Array([...DELEGATE_PUB, 0x00]));

const SUPRAFX_BASE = "https://suprafx.ai";

// 1) chain id hash (cache for the lifetime of the agent)
const chainInfo = await fetch(`${SUPRAFX_BASE}/api/council/chain-info`)
  .then(r => r.json());
const chainIdHash = hexToBytes(chainInfo.chainIdHashHex);

// 2) next sequence number for THIS delegate (re-fetch on cold start,
//    increment locally after every accepted send)
const seqResp = await fetch(
  `${SUPRAFX_BASE}/api/council/sequence-number?address=0x${bytesToHex(DELEGATE_ADDR)}`,
).then(r => r.json());
let userSeq = BigInt(seqResp.next_sequence_number);

// 3) build the event (PlaceQuote shown; see event-bcs.ts for every shape)
const eventBcs = encodeUserEvent({
  kind: "PlaceQuote",
  payload: {
    maker: DELEGATE_ADDR,
    rfq_id: hexToBytes("...16 bytes of the target RFQ..."),
    quote_id: randomBytes(16),
    rate: BigInt("...BFT-scaled rate, see encodeRateBFT..."),
    fill_size: BigInt("...base-asset micro-units..."),
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

if (result.ok === true) {
  userSeq = userSeq + 1n;     // advance local counter
} else {
  // ingest-time rejection — sequence NOT consumed. Inspect code + detail.
}
```

### Number encodings

Two different scales appear in events. Get them wrong and the chain
rejects with confusing errors.

- **Amounts** (`size`, `fill_size`, `min_fill_size`): base-asset micro
  units. For a 6-decimal asset, `1.5 USDC = 1_500_000n`. For 18-decimal
  ETH, `1.5 ETH = 1_500_000_000_000_000_000n`. Use
  `toMicroUnits(human, decimals)` from `lib/council/asset-registry.ts`.

- **Rates** (`rate`, `reference_price`, `auto_accept_target_rate`):
  BFT-scaled. Mathematically `human_rate × 10^18 × 10^quote_decimals
  / 10^base_decimals`. Use
  `toRateBFT(human, base_decimals, quote_decimals)` from
  `lib/council/asset-registry.ts`. The BFT factor (`10^18`) is the
  protocol-wide price precision; the asymmetric chain-decimal factor
  keeps the rate dimensionally consistent across asset pairs with
  different decimals (USDC at 6 vs ETH at 18).

### Sequence numbers in practice

Persist `userSeq` in your agent's local state. Reset semantics:

- On a successful `POST` (status 200, `body.ok === true`) → `userSeq++`.
- On a `body.ok === false` with `code: "gate_rejected"` or `auth_failed`
  → the chain SAW it but rejected. Treat as consumed: `userSeq++`. (One
  bad envelope still burns a sequence number.)
- On a `body.ok === false` with `code: "missing_envelope"`,
  `decode_error`, `rate_limited` → ingest-time rejection BEFORE the
  envelope reached the mempool. NOT consumed: `userSeq` unchanged. Retry
  fine.
- On a network error (no response, timeout, ECONNREFUSED) → uncertain.
  Re-fetch `/api/council/sequence-number` and reconcile before sending
  the next envelope. Do NOT speculatively advance.

The chain rejects `user_sequence_number` mismatches silently at vote
time — the dApp may see HTTP 200 from mempool but the trade never
commits. The pre-flight balance check (introduced 2026-06-02) catches
the common balance-related cause of this; sequence drift is the other
common cause.

---

## 5. Reading state efficiently

For decisions, your agent needs current state. Pick the right tool.

**Live orderbook (Recommended for market makers):** subscribe to
`GET /api/orderbook/feed?pairs=...` as Server-Sent Events. Each event
carries the full RFQ or quote payload. Low latency, no polling needed.

```ts
const es = new EventSource(
  "https://suprafx.ai/api/orderbook/feed?pairs=ETH/USDC,WBTC/USDC",
);
es.addEventListener("rfq_created", (e) => {
  const rfq = JSON.parse(e.data);
  // decide whether to quote
});
es.addEventListener("rfq_updated", (e) => {
  // status change — withdraw your stale quote if necessary
});
```

**Snapshot orderbook:** `GET /api/suprafx/rfqs?scope=platform&status=open`.
Use at startup to load existing RFQs the agent didn't see live.

**Balances:** `GET /api/platform/balances?address=0x<master>`. Cached
in the dApp mirror; updated within ~3-5s of chain commits. Authoritative
chain state is on the validators but the mirror is fine for trade-time
decisions.

**Sequence numbers:** `GET /api/council/sequence-number?address=0x<delegate>`.
Cheap, returns the next strictly-monotonic value the delegate must
use. Refresh on startup, on uncertainty, and after long network gaps.

**Chain info:** `GET /api/council/chain-info`. Returns `chainIdHashHex`
and `threshold`. Cache for the lifetime of the agent — these are
constant per chain.

---

## 6. Core actions & strategies

You now have every primitive. This section ties them into the strategy
toolkit — the complete set of things an agent can do on SupraFX. There
are no hidden order types: `auto_accept`, `allow_partial_fills`, and the
cancel/withdraw pulls are the entire surface.

### The five write actions

| Action | Tool / event | Role | Effect |
|---|---|---|---|
| Open an RFQ | `submit_rfq` / `SubmitRfq` | taker | Earmarks the sell asset; posts a request to the book |
| Quote an RFQ | `place_quote` / `PlaceQuote` | maker | Locks the quote asset; offers a fill (auto-settles if the RFQ is auto-accept and you clear its floor) |
| Accept a quote | `accept_quote` / `AcceptQuote` | taker | Settles a chosen maker quote (not needed for auto-accept RFQs) |
| Cancel an RFQ | `cancel_rfq` / `CancelRfq` | taker | Pulls your open RFQ; releases the earmark; refunds + rejects its pending quotes |
| Withdraw a quote | `withdraw_quote` / `WithdrawQuote` | maker | Pulls your pending quote; releases its lock |

### Managing open orders (cancel & withdraw)

Lifecycle control is half of every real strategy. The two pull-actions:

- **`cancel_rfq` (taker).** Cancels an *open* RFQ you own. The earmarked
  sell balance returns to `available`, and every pending quote on it is
  rejected and refunded. Use it on a timeout, on a price move that makes
  your RFQ stale, or to free balance for a better opportunity. A
  fully-filled RFQ can't be cancelled (nothing is open). Takes an
  optional `reason` (logged on chain).
- **`withdraw_quote` (maker).** Pulls a *pending* quote you placed; the
  quote-asset lock returns to `available`. This is your reprice button —
  there is no "edit quote": to move your price you `withdraw_quote` then
  `place_quote` again at the new rate. Withdraw stale quotes promptly so
  you're not filled at a price the market has already left.

Both are owner-gated (only the funds owner / an authorized delegate can
pull) and both commit in ~1-2 seconds.

### The quote-refresh loop (makers)

The canonical maker maintenance loop:

1. `place_quote` at your current fair value.
2. Watch the SSE feed + oracle. When your quote drifts past tolerance,
   `withdraw_quote`.
3. `place_quote` again at the new price.
4. On fill, rebalance inventory and repeat.

Skipping step 2 is how makers get picked off — a quote you forgot to
withdraw is a free option you wrote for the market.

### The strategy menu

The primitives compose into the core strategies:

| Strategy | How |
|---|---|
| **Passive market maker** | `place_quote` on incoming RFQs at reference ± spread; refresh on drift. (`cookbook/01`, `02`) |
| **Aggressive taker / arb** | `submit_rfq` (`auto_accept = false`), watch quotes, `accept_quote` the best edge, `cancel_rfq` on timeout. (`cookbook/03`) |
| **Hands-off limit order** | `submit_rfq` with `auto_accept = true` + a target floor — fills automatically at your price or better, taker offline. |
| **Incremental fill (resting order)** | the same, plus `allow_partial_fills = true` + a `min_fill_size` — one large RFQ absorbs many small fills at/above your floor until full. (`cookbook/04`) |
| **Liquidity working (maker)** | quote partial `fill_size`s across many open RFQs to work into a position without sweeping any single book. |

Every one of these is just the five write actions arranged differently.

## 7. A minimal market maker

This skeleton demonstrates the full loop: read the orderbook, decide,
quote.

```ts
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import EventSource from "eventsource";
import {
  encodeUserEvent,
  encodeEnvelopeBcs,
  composeSignBytes,
} from "./suprafx-sdk";  // your vendored copy of the council libs
import { toMicroUnits, toRateBFT } from "./suprafx-sdk/amounts";

const DELEGATE_PRIV = hexToBytes(process.env.DELEGATE_PRIV!);
const DELEGATE_PUB  = ed25519.getPublicKey(DELEGATE_PRIV);
const DELEGATE_ADDR = sha3_256(new Uint8Array([...DELEGATE_PUB, 0x00]));
const BASE = "https://suprafx.ai";

let chainIdHash: Uint8Array;
let nextSeq: bigint;

async function bootstrap() {
  const ci = await fetch(`${BASE}/api/council/chain-info`).then(r => r.json());
  chainIdHash = hexToBytes(ci.chainIdHashHex);

  const seq = await fetch(
    `${BASE}/api/council/sequence-number?address=0x${bytesToHex(DELEGATE_ADDR)}`,
  ).then(r => r.json());
  nextSeq = BigInt(seq.next_sequence_number);
}

function decide(rfq: any): { wantsToQuote: boolean, rate?: number, fillSize?: number } {
  // Your strategy goes here. This stub quotes at reference price for the
  // full size. Real market makers maintain an inventory + spread book and
  // compute (rate, fill_size) accordingly.
  if (rfq.pair === "ETH/USDC" && parseFloat(rfq.reference_price) > 0) {
    return {
      wantsToQuote: true,
      rate: parseFloat(rfq.reference_price) * 1.001,  // 10 bps over reference
      fillSize: parseFloat(rfq.size),
    };
  }
  return { wantsToQuote: false };
}

async function placeQuote(rfq: any, rate: number, fillSize: number) {
  const baseDecimals = rfq.base_decimals;   // included in /orderbook/feed
  const quoteDecimals = rfq.quote_decimals;

  const eventBcs = encodeUserEvent({
    kind: "PlaceQuote",
    payload: {
      maker: DELEGATE_ADDR,
      rfq_id: hexToBytes(rfq.rfq_id_16b_hex),
      quote_id: randomBytes(16),
      rate: toRateBFT(rate, baseDecimals, quoteDecimals),
      fill_size: toMicroUnits(fillSize, baseDecimals),
      user_sequence_number: nextSeq,
    },
  });
  const sig = ed25519.sign(composeSignBytes(chainIdHash, eventBcs), DELEGATE_PRIV);
  const envelopeBcs = encodeEnvelopeBcs({
    event_bcs: eventBcs,
    signer_pubkey: DELEGATE_PUB,
    signer_sig: sig,
  });

  const r = await fetch(`${BASE}/api/council/place-quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ place_quote_envelope_bcs_hex: bytesToHex(envelopeBcs) }),
  }).then(r => r.json());

  if (r.ok) {
    nextSeq = nextSeq + 1n;
    console.log(`quote placed: batch=${r.batch} hash=${r.event_hash_hex}`);
  } else {
    console.warn(`quote rejected: code=${r.code} detail=${r.detail}`);
    if (r.code === "gate_rejected" || r.code === "auth_failed") nextSeq = nextSeq + 1n;
    // ingest-time rejections (rate_limited / decode_error) don't consume seq
  }
}

async function main() {
  await bootstrap();
  const es = new EventSource(`${BASE}/api/orderbook/feed?pairs=ETH/USDC`);
  es.addEventListener("rfq_created", async (e) => {
    const rfq = JSON.parse(e.data);
    const d = decide(rfq);
    if (d.wantsToQuote) await placeQuote(rfq, d.rate!, d.fillSize!);
  });
}

main().catch(console.error);
```

This is intentionally minimal. Real market makers add:

- Inventory tracking (don't quote what you can't deliver)
- Spread strategy (rate as a function of size, depth, volatility)
- Quote refresh / withdraw on stale price
- Position monitoring (`/api/platform/balances` polling)
- Risk limits (cap concurrent earmarks below the policy's
  `max_earmark_total`)

---

## 8. Error catalog

Every write endpoint returns `{ok, code, detail, per_validator}` on
non-success. Most common rejections an agent will see:

| `code` | What it means | Action |
|---|---|---|
| `missing_envelope` | Body didn't include the expected `*_envelope_bcs_hex` field | Fix request shape |
| `decode_error` | BCS or hex couldn't be parsed | Inspect bytes; re-encode |
| `rate_limited` | dApp ingress rate limit hit | Back off + retry |
| `auth_failed` | Signature, pubkey-derive, or policy lookup failed | Check delegate key, chain id hash, sequence number |
| `gate_rejected` | Chain state machine refused (insufficient balance, expired policy, bad pair, etc.). `detail` carries the reason | Inspect `detail`; usually a balance or cap issue |
| `no_quorum` | Validators disagreed or timed out | Network issue. Re-fetch sequence + retry |

Specific `detail` strings that often catch agents off guard:

- `submit_rfq: no balance row for funds_owner/base_asset <hex>` — the
  master has no balance row for the asset you're trying to sell.
  Either they never deposited it, or the deposit credited under a
  foreign account id without a verified link. Fix on the master side.
- `place_quote: no balance for funds_owner/quote_asset <hex>` — same,
  but maker side.
- `delegate has been deactivated by master` — master revoked. Stop.
- `delegate policy expired at batch N` — the on-chain expiry passed.
  Master re-bootstraps via the Delegates tab.
- `delegate not authorized to trade asset <hex> (no per-asset cap set)` —
  master didn't include this asset in the delegate's caps. Re-bootstrap
  with the missing asset.
- `trade size N exceeds delegate max M for asset <hex>` — per-trade cap.
  Reduce size.
- `projected earmark total N would exceed delegate cap M for asset <hex>` —
  cumulative open-earmark cap. Either reduce or wait for existing
  open RFQs/quotes to settle.
- `user_sequence_number (place_quote)` (replay) — the chain has
  already consumed this seq, or it's behind the high-water mark.
  Re-fetch `/api/council/sequence-number` and reconcile.

---

## 9. Operational notes

**Rate limits.** The dApp ingress rate-limits POSTs to the council
endpoints at a level that comfortably supports a single agent making
~1 trade/sec sustained. If you need higher throughput, contact
ops — direct validator HTTP submit is supported for vetted use cases.

**Session expiry.** Delegate sessions expire at the on-chain
`expires_at_batch` set by the master at bootstrap. Default is
~6 months at the current ~1 batch/sec cadence (`SESSION_LIFETIME_BATCHES
= 12_000_000`). Renew by having the master bootstrap a new delegate
before expiry — the old delegate keeps working until the deadline.

**Revocation.** The master can revoke at any time via `/profile →
Delegates → Deactivate`. Once committed (~2 seconds), every signed
event from the revoked delegate fails the policy gate.

**Multi-delegate.** A master can have multiple active delegates. Useful
for separating concerns (one for market making, one for hedging, etc.).
Each delegate has its own sequence-number space.

**Self-trade prevention.** The chain refuses a `PlaceQuote` whose maker
resolves to the same master as the RFQ's taker. You can't quote your
own RFQ. Two delegates owned by the same master can't trade with each
other either.

**Settlement timing.** A `Platform`-mode RFQ + accepted quote settles in
the batch that includes the accepting event — the `AcceptQuote` for a
manual accept, or the **`PlaceQuote` itself** for an auto-accept RFQ
(the chain auto-fires in-place; no `AcceptQuote` is ever sent). Funds
become available in `/api/platform/balances` ~3-5 seconds after that
batch commits (the reverse-projection latency).

**Chain health.** `GET /api/council/current-batch` is the simplest
health probe. If batch numbers are advancing, the chain is alive.
At roughly ~1 batch/sec the indicator advances quickly.

---

## 10. Where the canonical code lives

The dApp's own trading flows use the same endpoints documented here.
Authoritative reference implementations:

- `lib/council/event-bcs.ts` — BCS encoders + payload types for every
  event (`SubmitRfq`, `PlaceQuote`, `AcceptQuote`, `CancelRfq`,
  `WithdrawQuote`, `DelegatePolicyCreated`, `DelegatePolicyRevoked`)
- `lib/council/sign-event.ts` — `composeSignBytes` and
  `encodeEnvelopeBcs`
- `lib/council/derive-ids.ts` — asset id + pair id derivation; the
  TOKEN_REGISTRY contains every listed asset
- `lib/council/asset-registry.ts` — `toMicroUnits`, `toRateBFT`,
  decimal helpers
- `lib/council/submit-rfq-helper.ts` — full reference impl of a
  `SubmitRfq` round-trip
- `lib/council/shadow-write.ts` — dispatcher used by the dApp for
  `PlaceQuote` / `AcceptQuote` / `CancelRfq` / `WithdrawQuote`

The validator-side authority lives in `council-rust`:

- `crates/protocol/src/auth.rs` (`verify_and_decode`) — envelope
  validation
- `crates/protocol/src/policy.rs` (`check_delegate_policy`) — per-asset
  caps, allowed roles, expiry
- `crates/protocol/src/state.rs` (`apply_submit_rfq`,
  `apply_place_quote`, etc.) — apply-time gates

If a behavior surprises you and the dApp code doesn't match this doc,
the dApp code is right. File an issue.

---

## 11. Versioning

This document tracks the live `suprafx.ai` **Mainnet Beta** deployment.
There is no static release label to pin against — validators are rolled
continuously, so the authoritative version signal is the **chain id
hash** from `GET /api/council/chain-info` (`chainIdHashHex`). Treat that
as the source of truth, not any version string in prose or in this doc.

New deploys may ADD fields to the BCS payloads but will not break
existing encoders (BCS is append-only at the struct tail). If a
previously-working envelope suddenly returns `decode_error`, refetch
chain-info and update your vendored encoders against the schemas in
`event-bcs.ts`.

The chain id hash changes only on a chain genesis swap (rare; one
happened during the 2026-05-28 mainnet launch). If your agent caches it,
refetch on a `no_quorum` burst — that's the only signal an agent
typically sees.
