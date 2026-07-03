# Deploy — run an agent persistently

Keeps the bullish SUPRA accumulator (`cookbook/04`) running in the
background with auto-restart on crash, via [pm2](https://pm2.keymetrics.io/).

**Safety:** the launcher defaults to **DRY_RUN**. It only trades for
real when *you* set `LIVE=1` in `~/.suprafx/accumulator.env`. Starting
pm2 is not the same as going live — flipping `LIVE=1` is.

## 1. One-time config (gitignored, on your machine)

Create `~/.suprafx/accumulator.env`:

```bash
MASTER_ADDRESS=0xYOUR_MASTER_STARKEY_ADDRESS
QUOTE_ASSETS=USDC,USDT,ETH
MAX_PREMIUM_BPS=25
# LIVE=1        # <-- uncomment ONLY when you're funded + caps enabled and ready to trade
```

The delegate key is read automatically from `~/.suprafx/delegate.json`
(mode 0600) — never put it in this file.

## 2. Start it

```bash
npm install -g pm2
pm2 start deploy/ecosystem.config.js
pm2 logs supra-accumulator          # watch "WOULD buy …" (dry) or "✓ bid to buy …" (live)
```

## 3. Go live

When you've funded the quote assets and enabled their delegate caps:

```bash
#  edit ~/.suprafx/accumulator.env → uncomment LIVE=1, then:
pm2 restart supra-accumulator
pm2 logs supra-accumulator
```

## 4. Survive reboot (optional)

```bash
pm2 save
pm2 startup        # run the sudo command it prints
```

## macOS caveats (why a laptop isn't ideal for 24/7)

- pm2 keeps the agent alive while the Mac is **awake**, but it **pauses
  on sleep**. To keep quoting overnight, prevent sleep:
  `caffeinate -is pm2 logs supra-accumulator` (or System Settings →
  Battery → prevent sleep on power adapter).
- On reboot it only comes back if you ran `pm2 save && pm2 startup`.
- For genuinely continuous operation, run the same setup on a small
  VPS / Railway / Fly instead — identical files, just an always-on host.

## Stop / status

```bash
pm2 stop supra-accumulator
pm2 status
pm2 delete supra-accumulator
```
