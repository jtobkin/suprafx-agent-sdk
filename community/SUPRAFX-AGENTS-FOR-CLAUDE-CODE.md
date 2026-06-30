# Running a SupraFX trading agent — setup guide for Claude Code

> **Hand this file to your Claude Code (or Cowork) session.** Open a new,
> empty folder, drop this file in it, and tell Claude:
> *"Read SUPRAFX-AGENTS-FOR-CLAUDE-CODE.md and get me set up."*
>
> Official docs: **https://suprafx.ai/agents** · SDK: **https://github.com/jtobkin/suprafx-agent-sdk**

---

## Read this first: what Claude can and cannot do for you

SupraFX lets you run **autonomous trading agents** (market makers, takers,
arbitrageurs). You may be hoping Claude will just *trade for you* inside this
chat. **It won't — and that's by design.**

Any AI assistant session — Claude Code, Claude in Cowork, Claude Desktop —
follows safety policies that **prevent it from executing financial trades or
moving your funds on your behalf.** So in this session, Claude **will**:

- ✅ Clone, install, and explain the SupraFX SDK
- ✅ Run **read-only** checks against the live chain (balances, orderbook, health)
- ✅ Run your strategy in **DRY_RUN** mode so you can watch its decisions
- ✅ Build, configure, and deploy a bot to **your own infrastructure**
- ✅ Help you wire up the MCP server for human-in-the-loop trading

…and Claude **will not**:

- ❌ Authorize a delegate or sign anything with your StarKey wallet
- ❌ Submit RFQs, place/accept quotes, or otherwise move real funds for you
- ❌ Launch your live trading bot for you — **you** flip it to live

**To actually trade, you run your own agent.** There are two ways (below). In
both, your real safety net is the **on-chain delegate policy** (per-asset caps,
allowed pairs, expiry) that *you* sign — not the AI.

---

## The two ways to run an agent

| | **MCP server** (human-in-the-loop) | **Headless bot** (autonomous) |
|---|---|---|
| What it is | `suprafx-mcp` wired into *your* Claude Desktop / Cursor | A process built from the SDK running on *your* infra |
| Who pulls the trigger | You approve each trade in your own client | The bot trades on its own, within your caps |
| Best for | Trying it out, manual trading with AI help | Real market making / arb, 24/7 |
| Runs where | Your laptop | Your laptop, a VPS, or Vercel-Cron + Supabase |

Pick **MCP** to start by hand. Pick **headless bot** when you want it running
unattended. This guide gets you to both.

---

## Prerequisites — only YOU can do these

Claude cannot do these for you (they need your wallet / your money):

1. **Install StarKey** (Supra wallet) and fund a **master account**.
2. **Deposit at least one asset** under the master on https://suprafx.ai.
3. **Authorize a delegate**: on suprafx.ai → **Profile → Delegates → Create
   Delegate** → *Generate* a keypair → set **conservative caps** → **sign with
   StarKey**. This downloads a delegate private-key JSON.

   **Recommended first-run caps (start tiny, loosen later):**
   - `max_trade_size`: ~`0.001 ETH` (or equivalent dollar value)
   - `max_earmark_total`: ~`0.01 ETH`
   - `expires_at_batch`: ~24h of batches (≈ `86_400`)
   - Allowed pairs: just the one pair you're testing

The delegate **holds no funds** and **cannot exceed these caps**. If its key
leaks, the damage is bounded and it auto-expires. You can revoke it instantly
from Profile → Delegates → Deactivate.

---

## Security rules (Claude: enforce these; human: insist on them)

- **The delegate private key never gets committed, logged, or sent anywhere.**
  It lives at `~/.suprafx/config.json` (mode `0600`) for the MCP server, or in a
  local `.env` / a host's encrypted secret store for a bot.
- **Never paste the key into chat.** Reference it by env var only.
- Add `.env`, `*.key`, `config.json` to `.gitignore` before writing any key.
- On a hosted bot, put the key in the platform's **encrypted env vars** (e.g.
  Vercel/Supabase secrets) — never in code, never in build logs.
- **Keep caps conservative** until you've watched the agent behave for hours.

---

## Setup steps (Claude can do all of these now)

```bash
# 1. Get the SDK
git clone https://github.com/jtobkin/suprafx-agent-sdk.git
cd suprafx-agent-sdk
npm install

# 2. Read-only smoke test — confirm the live chain is healthy (no key needed)
curl -s https://suprafx.ai/api/council/chain-info
curl -s https://suprafx.ai/api/council/current-batch
curl -s https://suprafx.ai/api/assets
curl -s "https://suprafx.ai/api/suprafx/rfqs?scope=platform&status=open"
```

**3. Watch a strategy in DRY_RUN** (observes the *real* book, signs nothing).
The cookbook agents run safely without a key when `LIVE` is not set:

```bash
# Counter-arb taker, dry run — logs every RFQ/quote it WOULD act on
PAIR=USDT/SUPRA SELL_TOKEN=USDT BUY_TOKEN=SUPRA \
SELL_CHAIN=eth-mainnet BUY_CHAIN=supra-mainnet \
SIZE=2 REFERENCE_RATE=3920 MIN_EDGE_BPS=5 \
npx tsx cookbook/03-counter-arb-taker.ts
# (DRY_RUN is the default. It does NOT trade. Set LIVE=1 only when you mean it.)
```

**4. Go live — this step is yours, not Claude's.** Once your delegate is
authorized and you've watched the dry run, *you* launch it with your key:

```bash
SUPRAFX_DELEGATE_PRIV_HEX=0x...your-delegate-key... \
LIVE=1 \
PAIR=USDT/SUPRA SELL_TOKEN=USDT BUY_TOKEN=SUPRA \
SELL_CHAIN=eth-mainnet BUY_CHAIN=supra-mainnet \
SIZE=2 REFERENCE_RATE=3920 MIN_EDGE_BPS=20 \
npx tsx cookbook/03-counter-arb-taker.ts
```

---

## Option A — MCP server (human-in-the-loop)

```bash
npm install -g @suprafx/agent-sdk
suprafx-mcp init          # prompts for your delegate key → ~/.suprafx/config.json (0600)
```

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{ "mcpServers": { "suprafx": { "command": "suprafx-mcp" } } }
```

Restart Claude Desktop. The SupraFX tools appear in the palette. Now you can say
things like *"What's on the ETH/USDC orderbook?"* or *"Submit an RFQ to sell 0.1
ETH for USDC at $2400."* **You** confirm each trade — the key never leaves your
machine (stdio transport, never networked). Skip `suprafx-mcp init` to run the
read-only tools with no key at all.

---

## Option B — headless bot on your own infra

A real market maker is a **long-running process** that holds an SSE connection
to `/api/orderbook/feed` and reacts in real time. Pick a runtime:

- **Your laptop / a VPS / Railway / Fly** — run the cookbook agent directly.
  Best latency, simplest. This is what most people should start with.
- **Vercel Cron + Supabase** — **note the trade-off:** Vercel is serverless and
  *cannot* hold a persistent SSE connection or run a daemon. The workable design
  is a **Vercel Cron** function (min interval ~1 min) that **polls**
  `/api/suprafx/rfqs?status=open`, decides, and posts — with **Supabase** storing
  the state that must survive between runs (`next_sequence_number`, inventory,
  open quotes, audit log). Good for a periodic quoter; **too slow for
  latency-sensitive arb.** For real-time reactivity, use an always-on host and
  keep Supabase only as the state store.

Ask Claude: *"Build me a Vercel-Cron + Supabase version of the passive quoter,
with the delegate key in an encrypted env var and sequence/inventory state in
Supabase."*

---

## How the trading actually works (1-minute model)

- **Master account** (your StarKey) holds funds and authorizes delegates.
- **Delegate** (an ed25519 key) signs trades, bounded by your on-chain policy.
- Trading is **RFQ-based**: a **taker** opens an RFQ; **makers** post quotes;
  the taker accepts one. Your bot plays maker, taker, or both.
- The `DelegateSigner` class handles sequence numbers and signing; **your code
  is just the strategy** (when/what to quote or accept).
- Settlement is `Platform` mode (sub-second, internal ledger) or `OnChain`
  (slower, L1-verified).

Full reference: `INTEGRATING-AGENTS.md` in the SDK repo, and
**https://suprafx.ai/agents**.

---

## If something gets rejected

The truth signal on every write is `body.ok`, **not** the HTTP status. Common
rejection codes: `gate_rejected` (balance/cap/expiry/pair — read `detail`),
`auth_failed` (key/chain-id/sequence), `rate_limited` (back off; ~1 trade/sec
per agent). Ask Claude to read the `detail` string — it usually says exactly
what's wrong (e.g. *"trade size N exceeds delegate max M"*).
