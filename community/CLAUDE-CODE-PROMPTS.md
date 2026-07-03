# SupraFX × Claude Code — copy-paste prompts

Ready prompts for setting up a SupraFX trading agent with Claude Code or Cowork.
Pair these with **`SUPRAFX-AGENTS-FOR-CLAUDE-CODE.md`** (drop both in your folder)
and the official docs at **https://suprafx.ai/agents**.

> Reminder: Claude will **build, test, and dry-run** your agent — it will **not**
> execute live trades, sign with your wallet, or launch your live bot. Those
> steps are yours.

---

## 0. Kickoff (start here)

```
Read SUPRAFX-AGENTS-FOR-CLAUDE-CODE.md. Then:
1. Clone https://github.com/jtobkin/suprafx-agent-sdk and run npm install.
2. Do the read-only smoke test against the live chain and show me the results.
3. Tell me, in plain language, the prerequisites I personally have to do
   before any trading is possible.
Don't sign anything, don't trade, and never ask me to paste a private key
into the chat.
```

---

## 1. Read-only — "show me the live market, no key"

```
Using the suprafx-agent-sdk, show me the current SupraFX chain health
(chain-info, current batch) and the live open orderbook. Then tell me which
trading pairs are actually active right now and at what reference prices.
Read-only only — no keys, no funds, no signing.
```

---

## 2. Dry-run a strategy — "let me watch it think"

```
Run the counter-arb taker (cookbook/03) in DRY_RUN against an active pair you
found. Stream its decisions for ~60 seconds so I can see which quotes it would
accept and why. Do NOT set LIVE=1. Do NOT submit or accept anything.
```

Swap in the passive quoter:

```
Same idea, but dry-run the passive quoter (cookbook/01) on an active pair.
Explain each "would quote" decision and the spread math.
```

---

## 3. Pre-flight my delegate — "check before I trust it"

```
I've authorized a delegate on suprafx.ai and set its key in an env var called
SUPRAFX_DELEGATE_PRIV_HEX (already exported in my shell — do not read or print
it). Write and run a read-only check that confirms: the delegate policy is
active, its caps and allowed pairs, and that its sequence number is aligned.
Report what you find. Do not place any trades.
```

---

## 4. Build a hosted bot — "Vercel Cron + Supabase"

```
Build me a Vercel-Cron + Supabase version of the passive quoter:
- A scheduled function that polls open RFQs, applies the quoting strategy,
  and posts quotes via the SDK.
- Supabase tables for next_sequence_number, inventory snapshot, open quotes,
  and an audit log of every action.
- The delegate key read ONLY from an encrypted Vercel env var; never logged,
  never committed. Add .env and secrets to .gitignore.
- Conservative hard-coded size guards on top of the on-chain caps.
Set it up so I deploy and flip it live myself — you don't deploy or trade.
Explain the ~1-minute cron latency trade-off vs an always-on SSE worker.
```

---

## 5. Build an always-on bot — "real-time, my own host"

```
Build me a production-ish inventory-aware market maker from cookbook/02 that I
can run 24/7 on a VPS (or Railway/Fly): holds the SSE feed, tracks inventory,
widens spread as I tilt, refreshes/withdraws stale quotes, reconciles the
sequence number on errors, and health-checks that the chain is advancing and my
delegate is still active. Key from a local .env (gitignored). I launch it live.
```

---

## 6. Wire up the MCP server — "human-in-the-loop"

```
Walk me through installing @suprafx/agent-sdk globally and running
`suprafx-mcp init`, then add the suprafx MCP server to my Claude Desktop config.
Explain exactly where my delegate key is stored and confirm it's mode 0600 and
never networked. Then give me 5 example prompts I can use once it's connected.
```

---

## 7. Safety review — "audit before I go live"

```
Review my SupraFX bot before I run it live. Check: is the delegate key ever
logged, committed, or sent over the network? Are there size guards beyond the
on-chain caps? What happens on rate_limited / gate_rejected / network errors —
does the sequence number stay consistent? Is there a kill switch? List concrete
risks and fixes. Don't run it live.
```

---

## 8. Accumulate SUPRA (bullish flagship) ⭐

```
I'm bullish SUPRA and want to accumulate it. Using cookbook/05
(bullish-supra-accumulator), run it in DRY_RUN against the live book
with my master address so I can watch it evaluate real SUPRA sellers.
It should only bid to BUY SUPRA at up to the oracle price plus a small
premium (MAX_PREMIUM_BPS), paying USDC/USDT/ETH, sized to my balance.
Explain each "WOULD buy" line. Don't set LIVE=1 — I'll go live myself
once I've funded the quote assets and enabled their delegate caps.
```

Tune it:

```
Adjust the accumulator so it only buys SUPRA at or below the oracle
price (no premium), and only spends USDC. Then dry-run it again.
```

## 9. Explain a rejection — "why did it fail?"

```
My write got `ok: false`. Here's the response: <paste JSON>. Explain the code
and the detail string, tell me exactly what to fix, and whether my local
sequence number is now out of sync and how to reconcile it.
```
