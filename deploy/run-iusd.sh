#!/usr/bin/env bash
#
# Persistent launcher for the iAsset standing-order desk (cookbook/07).
#
# - Loads the delegate private key from ~/.suprafx/delegate.json (never printed).
# - Sources optional overrides from ~/.suprafx/iusd.env
#   (MASTER_ADDRESS, USD_SIZE, DISCOUNT_BPS, MOVE_CANCEL_BPS, POLL_MS, LIVE).
# - Defaults to DRY_RUN. It only posts RFQs for real if you set LIVE=1.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [ -f "$HOME/.suprafx/iusd.env" ]; then
  set -a; . "$HOME/.suprafx/iusd.env"; set +a
fi

if [ ! -f "$HOME/.suprafx/delegate.json" ]; then
  echo "missing ~/.suprafx/delegate.json — run cookbook/00-generate-delegate-key.ts first" >&2
  exit 1
fi
export SUPRAFX_DELEGATE_PRIV_HEX="$(jq -r .privateKey "$HOME/.suprafx/delegate.json")"

: "${MASTER_ADDRESS:?set MASTER_ADDRESS in ~/.suprafx/iusd.env}"
export MASTER_ADDRESS
# LIVE intentionally NOT defaulted on. Unset => DRY_RUN.

echo "[deploy] starting iusd desk (LIVE=${LIVE:-<unset → DRY_RUN>}) size=\$${USD_SIZE:-25} discount=${DISCOUNT_BPS:-500}bps"
exec npx tsx cookbook/07-iusd-desk.ts
