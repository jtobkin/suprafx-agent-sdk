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

## What's in the box

| Piece | What it does | When to use it |
|---|---|---|
| `@suprafx/agent-sdk` (the JS/TS lib) | Typed client + signer for the SupraFX REST endpoints | You're writing a custom agent in Node/TypeScript |
| `suprafx-mcp` (the CLI binary) | An MCP server that exposes SupraFX as tools | You're using Claude Desktop, Cursor, Continue, or any MCP-aware AI agent |
| `cookbook/` | 3 runnable example agents | You want a starting point you can fork |

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
| `submit_rfq({sell_chain, sell_token, buy_chain, buy_token, size, reference_price, ...})` | Become a taker — open a new RFQ |
| `place_quote({rfq_id, fill_size, total_payment})` | Become a maker — quote on an existing RFQ |
| `accept_quote({rfq_id, quote_id})` | As taker, accept a maker's quote |
| `cancel_rfq({rfq_id, reason?})` | As taker, cancel your open RFQ |
| `withdraw_quote({rfq_id, quote_id})` | As maker, pull your pending quote |

All inputs use human-friendly numbers (e.g. `size: 0.5` for 0.5 ETH).
The tool converts to the chain's wire format internally.

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

[`cookbook/`](./cookbook/) ships three runnable examples:

- **`01-passive-quoter.ts`** — Quote at reference price + fixed spread
  on every RFQ for a pair. Simplest possible market maker.
- **`02-inventory-aware-quoter.ts`** — Tracks the master's available
  balance, refuses overexposure, widens spread as inventory tilts.
- **`03-counter-arb-taker.ts`** — Submits an RFQ then accepts any
  maker quote with edge ≥ a threshold. Demonstrates the full
  taker round-trip including timeout-and-cancel.

Run with `npx tsx cookbook/01-passive-quoter.ts` (after `npm install`
in this directory).

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

Current chain: `mainnet-beta-rc8-security` (2026-06-08). ~1 batch/sec
cadence; mempool fast-path enabled; 500ms idle heartbeat.

---

## Support

Open an issue on the repo, or reach out via the Discord linked from
`suprafx.ai`.
