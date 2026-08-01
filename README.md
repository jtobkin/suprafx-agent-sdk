# @suprafx/agent-sdk

**SDK + MCP server for building autonomous agents on SupraFX.**

SupraFX is a BFT-consensus cross-chain swap protocol. This package lets
you (or your AI agent) trade on it programmatically — read the
orderbook, submit RFQs, place quotes, accept fills, all without going
through the web UI.

The conceptual reference is
[`docs/INTEGRATING-AGENTS.md`](../docs/INTEGRATING-AGENTS.md). This
package implements those concepts.

---

## Who maintains this

This is the **official SupraFX agent SDK**, maintained by
[Joshua Tobkin](https://github.com/jtobkin), co-founder & CEO of
[Supra](https://supra.com) (Supra Labs) — the team that builds and
operates [SupraFX.ai](https://suprafx.ai). The site's
[`/llms.txt`](https://suprafx.ai/llms.txt) and
[agent docs](https://suprafx.ai/agents) link back to this repository,
so you can verify the association in both directions.

Not affiliated with "Supra Algo FX" / fxsupra.com (an entity on the UK
FCA's warning list) — same word, unrelated operation.

A word on trust, since this SDK asks an agent to hold a signing key:
the delegate key is generated and stored **locally** (`~/.suprafx/config.json`,
mode 0600) and never leaves your machine — the SDK signs envelopes
locally and submits only the signed bytes. The master wallet bounds
what a delegate may do with **per-asset caps and a session expiry**,
enforced on chain. Read the code — it's small on purpose.

---

## What's in the box

| Piece | What it does | When to use it |
|---|---|---|
| `@suprafx/agent-sdk` (the JS/TS lib) | Typed client + signer for the SupraFX REST endpoints | You're writing a custom agent in Node/TypeScript |
| `suprafx-mcp` (the CLI binary) | An MCP server that exposes SupraFX as tools | You're using Claude Desktop, Cursor, Continue, or any MCP-aware AI agent |
| `cookbook/` | Runnable example agents (incl. a bullish SUPRA accumulator) | You want a starting point you can fork |

---

## Quick start — MCP server (recommended for AI agents)

### 1. Install

```bash
npm install -g @suprafx/agent-sdk
```

### 2. Authorize a delegate (one time)

The MCP server signs trades with a *delegate* keypair. Your master
StarKey wallet authorizes it on chain with per-asset caps and a
session expiry. See
[`docs/INTEGRATING-AGENTS.md` §3](../docs/INTEGRATING-AGENTS.md#3-setting-up-a-delegate)
for the full flow.

Short version:
1. Go to [suprafx.ai](https://suprafx.ai) → connect StarKey
2. Profile → Delegates → Create Delegate
3. Click "Generate" — a JSON file with the delegate's private key
   downloads to your machine. **Save this file safely.**
4. Set per-asset caps + expiry, sign with StarKey.

### 3. Configure the MCP server

```bash
suprafx-mcp init
```

The wizard prompts for the delegate private key (or the path to the
JSON file from step 2) and writes `~/.suprafx/config.json` (mode 0600).

> **Rotating the delegate?** The MCP server **hot-reloads** the delegate
> key from `~/.suprafx/config.json` — just edit the file (or re-run
> `suprafx-mcp init`) and the next tool call picks up the new key
> automatically; no restart or reconnect needed. `get_my_identity` always
> reports the **active** delegate, and signed writes always use the
> current key (so you can't silently keep signing with a rotated-out /
> revoked key). The server logs `delegate refreshed from config: <old> -> <new>`
> to stderr when it switches.
>
> Notes: rotating by **hand-editing** `config.json`? Write it **atomically**
> (temp file + `rename`) so the running server never reads a half-written
> file — `suprafx-mcp init` already does this. `SUPRAFX_DELEGATE_PRIV_HEX`
> env still takes **precedence** and is fixed for the process (file edits
> are ignored while it's set). Changing `baseUrl` needs a **restart** —
> only the delegate key is hot-reloaded.

### 4. Wire it into your agent

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "suprafx": {
      "command": "suprafx-mcp"
    }
  }
}
```

Restart Claude Desktop. Tools appear in the model's palette.

**Cursor / Continue** — see their respective MCP setup guides; they
use the same JSON config format.

### 5. Trade

Just ask the agent to trade. Examples:

> *"Check my SupraFX balances."*
>
> *"What's on the ETH/USDC orderbook right now?"*
>
> *"Submit an RFQ to sell 0.1 ETH for USDC at $2400 reference."*
>
> *"Watch for ETH/USDC quotes and tell me if anything looks good."*

The agent calls the right tools, signs with your delegate key locally,
and submits to chain. You see the results in the chat.

### Read-only mode

If you skip the delegate-key setup, the MCP server runs read-only —
only the read tools are exposed. Useful for monitoring agents that
don't need to trade.

---

## Quick start — Library use (for custom Node agents)

```bash
npm install @suprafx/agent-sdk
```

```ts
import { SupraFxClient, DelegateSigner } from "@suprafx/agent-sdk";

const client = new SupraFxClient();              // defaults to suprafx.ai
const signer = new DelegateSigner({
  delegatePrivKeyHex: process.env.SUPRAFX_DELEGATE_PRIV_HEX!,
  client,
});
await signer.loadSequenceFromChain();

// Read.
const balances = await client.getBalances("0x<master-address>");
const orderbook = await client.getOrderbook({ pair: "ETH/USDC" });

// Write.
const result = await signer.placeQuote({
  rfq_id: rfqIdBytes,
  quote_id: randomBytes(16),
  rate: toRateBFT(2400, 18, 6),
  fill_size: toMicroUnits(0.1, 18),
});
console.log(result.ok ? `committed at batch ${result.batch}` : `rejected: ${result.detail}`);
```

See [`cookbook/`](./cookbook/) for full runnable examples.

---

## Tool reference (MCP)

### Read tools (always available)

| Tool | What it does |
|---|---|
| `get_chain_info` | Chain ID hash + threshold |
| `get_current_batch` | Current committed batch number |
| `get_sequence_number({address})` | Next strict-monotonic seq for an address |
| `list_assets` | All supported assets with decimals |
| `get_balances({address})` | A master's available + locked balances per asset |
| `get_orderbook({pair?, status?, limit?})` | Open RFQs (or filter by status) |
| `get_my_identity` | Your delegate address and current seq |

### Write tools (require configured delegate key)

| Tool | What it does |
|---|---|
| `submit_rfq({sell_chain, sell_token, buy_chain, buy_token, size, reference_price, auto_accept?, auto_accept_target_rate?, allow_partial_fills?, min_fill_size?, ...})` | Become a taker — open a new RFQ. `auto_accept` auto-settles qualifying quotes; `allow_partial_fills` lets it fill in slices (see below) |
| `place_quote({rfq_id, fill_size, total_payment})` | Become a maker — quote on an existing RFQ |
| `accept_quote({quote_id, trade_id?})` | As taker, accept a maker's quote |
| `cancel_rfq({rfq_id, reason?})` | As taker, cancel your open RFQ |
| `withdraw_quote({quote_id})` | As maker, pull your pending quote |

All inputs use human-friendly numbers (e.g. `size: 0.5` for 0.5 ETH).
The tool converts to the chain's wire format internally.

### Auto-accept (taker pre-commit)

`submit_rfq({auto_accept: true, auto_accept_target_rate: R})` makes the
chain auto-settle the first maker quote at or better than `R`, in the
same batch the quote lands — no `accept_quote` needed, taker can be
offline. `R` is a **cryptographic price floor**: the chain will never
fill (or let anyone accept) a quote worse than it. For makers, quoting
*below* an auto-accept RFQ's target is a dead end — quote at or above it
to win and settle instantly. (`auto_accept: false`, the default, keeps
the taker in control: quotes accumulate and you `accept_quote` manually.)

### Partial fills

`submit_rfq({allow_partial_fills: true, min_fill_size: M})` lets makers
fill a *slice* of the RFQ (≥ `M`) instead of all-or-nothing. After a
partial fill the RFQ stays open with a smaller `remaining_size` and keeps
taking quotes until full or cancelled. A maker who over-quotes is
capped-and-filled to what remains — never over-locked.

**Compose them.** `auto_accept: true` + `allow_partial_fills: true` is a
resting limit order: one large RFQ that auto-settles every qualifying
slice at or above your floor, incrementally, until full — taker offline.
See `cookbook/04-auto-accept-partial-taker.ts`.

### Order lifecycle (cancel & withdraw)

- **`cancel_rfq({rfq_id, reason?})`** (taker) — pull an open RFQ; the
  earmark is released and all its pending quotes are refunded + rejected.
- **`withdraw_quote({quote_id})`** (maker) — pull a pending quote; the
  lock is released. There's no "edit quote": to reprice, withdraw then
  `place_quote` again. Refresh stale quotes promptly so you aren't picked
  off at a price the market has left.

### Fees

- **Trade fee:** taker pays **5 bps** of the quote notional, maker earns
  a **1 bp** rebate, protocol keeps **4 bps**. Netted at settlement;
  doesn't change the on-chain rate. Price your quotes accordingly.
- **Withdrawal fee:** a flat **4000 SUPRA**, paid in SUPRA even for
  non-SUPRA assets, when a master withdraws to L1. Master-side only (no
  withdraw tool) — but budget for it to realize PnL.

---

## Security

**The delegate private key stays on your machine.** The MCP server
runs as a local subprocess; the transport is stdio. The key is never
sent over the wire.

**On-chain authorization is bounded.** The master's
`DelegatePolicyCreated` event sets per-asset caps, allowed pairs,
allowed roles, and an `expires_at_batch` deadline. A leaked delegate
key can do at most what the policy allows, and is automatically
expired at the deadline regardless of master action.

**Revocation is instant.** Master goes to Profile → Delegates →
Deactivate, signs once with StarKey. The on-chain policy flips
inactive. Every subsequent envelope from the delegate is rejected.

**File mode 0600.** `~/.suprafx/config.json` is created mode `0600`
(owner read/write only). If you copy it elsewhere, preserve the mode.

---

## Cookbook

[`cookbook/`](./cookbook/) ships runnable examples. **Most agents here
are bullish SUPRA, so the examples are framed around _accumulating_
SUPRA (buying it) — see the direction primer in the cookbook README so
you never accidentally quote the sell side.** Every agent defaults to
`DRY_RUN` and only trades with `LIVE=1`.

- **`05-bullish-supra-accumulator.ts`** ⭐ — The flagship. Watches
  `SUPRA/USDC`, `SUPRA/USDT`, `SUPRA/ETH` for sellers and **buys**
  SUPRA at up to the oracle price + a small premium, sized to balance.
- **`00-generate-delegate-key.ts`** — Generate a delegate keypair
  locally (private key never touches the browser); paste only the
  public key into the delegate form.
- **`01-passive-quoter.ts`** — Simplest maker: quote reference ± a
  fixed spread on every RFQ for a pair.
- **`02-inventory-aware-quoter.ts`** — Tracks balances, refuses
  overexposure, widens spread as inventory tilts.
- **`03-counter-arb-taker.ts`** — The taker round-trip (submit RFQ →
  accept a quote with edge ≥ threshold → timeout-and-cancel). Point
  `BUY_TOKEN=SUPRA` to take the buy side.
- **`04-auto-accept-partial-taker.ts`** — A resting limit order:
  `auto_accept` + `allow_partial_fills` on one RFQ, auto-filling in
  slices at or above your floor, offline, with cancel-on-deadline.

Run the flagship with
`MASTER_ADDRESS=0x... npx tsx cookbook/05-bullish-supra-accumulator.ts`
(after `npm install` in this directory) — it dry-runs by default.

---

## Hosting and discovery

This package is published as **`@suprafx/agent-sdk`** on npm. The
canonical landing page is **https://suprafx.ai/agents**, which links
out to:

- This README + the rest of the cookbook
- The conceptual doc at
  [`docs/INTEGRATING-AGENTS.md`](../docs/INTEGRATING-AGENTS.md)
- The source repo on GitHub
- The npm package page

---

## License

MIT. See LICENSE.

---

## Versioning + chain compatibility

This package targets the live `suprafx.ai` deployment. Major version
bumps may add fields to the BCS payloads but won't break existing
encoders. The chain id hash (`get_chain_info → chainIdHashHex`)
changes on a genesis swap — rare; one happened during the 2026-05-28
mainnet launch.

There is no static release label to pin against — validators roll
continuously. The authoritative version signal is the live chain id
hash from `get_chain_info` (`chainIdHashHex`); treat that as the source
of truth, not any version string. Mainnet Beta runs at roughly ~1
batch/sec.

---

## Support

Open an issue on the repo, or reach out via the Discord linked from
`suprafx.ai`.
