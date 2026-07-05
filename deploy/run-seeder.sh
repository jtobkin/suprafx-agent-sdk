#!/usr/bin/env bash
#
# Persistent launcher for the multi-market RFQ liquidity seeder (cookbook/06).
#
# - Loads the delegate private key from ~/.suprafx/delegate.json (never printed).
# - Sources optional overrides from ~/.suprafx/seeder.env
#   (MASTER_ADDRESS, RFQ_USD_SIZE, SUPRA_EDGE_BPS, MIN_DEPTH, MOVE_CANCEL_BPS,
#    POLL_MS, LIVE).
# - Defaults to DRY_RUN. It only posts RFQs for real if you set LIVE=1.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [ -f "$HOME/.suprafx/seeder.env" ]; then
  set -a; . "$HOME/.suprafx/seeder.env"; set +a
fi

if [ ! -f "$HOME/.suprafx/delegate.json" ]; then
  echo "missing ~/.suprafx/delegate.json — run cookbook/00-generate-delegate-key.ts first" >&2
  exit 1
fi
export SUPRAFX_DELEGATE_PRIV_HEX="$(jq -r .privateKey "$HOME/.suprafx/delegate.json")"

: "${MASTER_ADDRESS:?set MASTER_ADDRESS in ~/.suprafx/seeder.env}"
export MASTER_ADDRESS
# LIVE intentionally NOT defaulted on. Unset => DRY_RUN.

echo "[deploy] starting seeder (LIVE=${LIVE:-<unset → DRY_RUN>})"
exec npx tsx cookbook/06-liquidity-seeder.ts
