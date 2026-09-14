/**
 * Session preflight: the checks that decide whether it is safe to trade
 * right now, run as a first-class MCP tool instead of living in prose.
 *
 * Every check answers with a status and, when it is not `ok`, the ACTION
 * that clears it — so an agent can branch on the result instead of
 * parsing a paragraph. Run it on connect, and again after any surprise.
 */

import type { SupraFxClient } from "../client.js";
import type { DelegateSigner } from "../signer.js";
import { registeredAssetId, canonicalChain } from "../derive-ids.js";

/** A quote older than this must not be traded against. */
export const ORACLE_STALE_MS = 120_000;

export type CheckStatus = "ok" | "warn" | "fail" | "skipped";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** The one thing that clears a non-ok check. */
  action?: string;
}

export interface PreflightResult {
  ready_to_trade: boolean;
  read_path_ok: boolean;
  mode: "read_only" | "guarded" | "autonomous";
  checks: Check[];
  summary: string;
}

export interface PreflightOptions {
  client: SupraFxClient;
  signer: DelegateSigner | null;
  masterAddress: string | null;
  mode: "read_only" | "guarded" | "autonomous";
  /** Pair to check oracle freshness against, e.g. "ETH/USDC". */
  pair?: string;
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightResult> {
  const { client, signer, masterAddress, mode } = opts;
  const checks: Check[] = [];
  const push = (c: Check) => checks.push(c);

  // ── 1. Venue reachable, and which chain is it ────────────────────
  let chainOk = false;
  try {
    const ci = await client.getChainInfo();
    chainOk = true;
    push({
      name: "venue_reachable",
      status: "ok",
      detail: `chain ${ci.chainId}, threshold ${ci.threshold}${
        ci.validatorCount ? ` of ${ci.validatorCount}` : ""
      }`,
    });
  } catch (e) {
    push({
      name: "venue_reachable",
      status: "fail",
      detail: msg(e),
      action: "The venue did not answer. Stop, retry once, then report — do not trade.",
    });
  }

  // ── 2. Is the VENUE advancing, or only the L1? ───────────────────
  //
  // A stalled venue batch while the L1 keeps living looks exactly like a
  // healthy chain from a single read. Sample the batch height twice.
  if (chainOk) {
    try {
      const a = await client.getCurrentBatch();
      await new Promise((r) => setTimeout(r, 3_000));
      const b = await client.getCurrentBatch();
      if (b > a) {
        push({
          name: "venue_advancing",
          status: "ok",
          detail: `batch ${a} → ${b} in 3s`,
        });
      } else {
        push({
          name: "venue_advancing",
          status: "warn",
          detail: `batch height did not move in 3s (still ${a})`,
          action:
            "The venue may be batching slowly or stalled. Sample again before " +
            "trading; if it stays flat, stop trading and report — writes will " +
            "accept at ingress and never commit.",
        });
      }
    } catch (e) {
      push({ name: "venue_advancing", status: "warn", detail: msg(e) });
    }
  }

  // ── 3. Do the venue's own assets derive to REGISTERED ids? ───────
  //
  // `list_assets` returns short chain ids ("ethereum", "supra"); the
  // AssetId derivation is keyed on canonical ones ("eth-mainnet"). If
  // this check fails, every trade on that asset gate-rejects silently.
  try {
    const assets = await client.listAssets();
    const bad = assets.filter((a) => !registeredAssetId(a.chain_id, a.asset_symbol));
    if (assets.length === 0) {
      push({
        name: "assets_resolvable",
        status: "fail",
        detail: "list_assets returned nothing",
        action: "Read path is broken. Reconnect, then report.",
      });
    } else if (bad.length === 0) {
      push({
        name: "assets_resolvable",
        status: "ok",
        detail: `${assets.length}/${assets.length} venue assets derive to registered ids`,
      });
    } else {
      push({
        name: "assets_resolvable",
        status: "warn",
        detail: `${bad.length} of ${assets.length} not in the token registry: ${bad
          .map((a) => `${canonicalChain(a.chain_id)}/${a.asset_symbol}`)
          .join(", ")}`,
        action:
          "Do not trade the unlisted assets — their derived id is a placeholder " +
          "the validator gate rejects. Update @suprafx/agent-sdk and report.",
      });
    }
  } catch (e) {
    push({ name: "assets_resolvable", status: "warn", detail: msg(e) });
  }

  // ── 4. Oracle freshness ──────────────────────────────────────────
  if (opts.pair) {
    try {
      const o = await client.getOracle(opts.pair);
      if (o.conversionRate == null) {
        push({
          name: "oracle_fresh",
          status: "fail",
          detail: `no conversionRate for ${opts.pair}`,
          action: "Do not quote this pair — you have no fair value.",
        });
      } else if (o.ageMs != null && o.ageMs > ORACLE_STALE_MS) {
        push({
          name: "oracle_fresh",
          status: "fail",
          detail: `${opts.pair} quote is ${Math.round(o.ageMs / 1000)}s old (limit ${
            ORACLE_STALE_MS / 1000
          }s)`,
          action: "Do not quote against a stale oracle. Wait for a fresh tick.",
        });
      } else {
        push({
          name: "oracle_fresh",
          status: "ok",
          detail: `${opts.pair} = ${o.conversionRate}${
            o.ageMs != null ? `, ${Math.round(o.ageMs / 1000)}s old` : ""
          }`,
        });
      }
    } catch (e) {
      push({ name: "oracle_fresh", status: "warn", detail: msg(e) });
    }
  } else {
    push({
      name: "oracle_fresh",
      status: "skipped",
      detail: "no pair given — pass `pair` to check fair-value freshness",
    });
  }

  // ── 5. Custody: is a delegate key loaded, and is a master known? ──
  if (!signer) {
    push({
      name: "custody",
      status: "skipped",
      detail: "read-only: no delegate key configured",
      action: "Configure a delegate key to trade (see `get_setup_status`).",
    });
  } else {
    push({
      name: "custody",
      status: "ok",
      detail: `signing as delegate ${signer.addressHex}. This key CANNOT withdraw funds — withdrawals are master-signed.`,
    });
    if (!masterAddress) {
      push({
        name: "master_address_known",
        status: "warn",
        detail: "no master address configured — balance reads need it",
        action:
          "Ask the operator for their master StarKey address and set " +
          "SUPRAFX_MASTER_ADDRESS (or `masterAddress` in ~/.suprafx/config.json).",
      });
    } else {
      push({
        name: "master_address_known",
        status: "ok",
        detail: masterAddress,
      });
    }
  }

  // ── 6. Sequence: local counter vs chain ──────────────────────────
  if (signer) {
    try {
      const chainSeq = BigInt(await client.getSequenceNumber(signer.addressHex));
      const localSeq = signer.getNextSeq();
      if (chainSeq === localSeq) {
        push({
          name: "sequence_in_sync",
          status: "ok",
          detail: `local and chain both expect seq ${localSeq}`,
        });
      } else {
        push({
          name: "sequence_in_sync",
          status: "fail",
          detail: `local seq ${localSeq}, chain expects ${chainSeq}`,
          action:
            "seq_desync — reconnect the MCP server to re-anchor. Until then " +
            "writes accept at ingress and are silently dropped as replays.",
        });
      }
    } catch (e) {
      push({ name: "sequence_in_sync", status: "warn", detail: msg(e) });
    }
  }

  // ── 7. Funded? And is anything already locked? ───────────────────
  if (masterAddress) {
    try {
      const balances = await client.getBalances(masterAddress);
      const funded = balances.filter((b) => b.total > 0);
      const locked = balances.filter(
        (b) => (b.locked_in_rfq ?? 0) > 0 || (b.locked_in_orders ?? 0) > 0,
      );
      if (funded.length === 0) {
        push({
          name: "funded",
          status: "warn",
          detail: "master has no balances",
          action:
            "Deposit from the dApp (operator step). A brand-new wallet's first " +
            "deposit can take minutes to credit — wait and re-check, do not loop.",
        });
      } else {
        push({
          name: "funded",
          status: "ok",
          detail: funded
            .map((b) => `${b.asset}: ${b.available} available / ${b.total} total`)
            .join("; "),
        });
      }
      if (locked.length > 0) {
        push({
          name: "existing_locks",
          status: "warn",
          detail: locked
            .map(
              (b) =>
                `${b.asset}: ${b.locked_in_rfq} locked_in_rfq, ${b.locked_in_orders} locked_in_orders`,
            )
            .join("; "),
          action:
            "Funds are already committed. Run `list_my_open_orders` to see which " +
            "order each lock belongs to before assuming it is a ghost-lock.",
        });
      }
    } catch (e) {
      push({ name: "funded", status: "warn", detail: msg(e) });
    }
  }

  // ── 8. Stale own RFQs still holding collateral ───────────────────
  if (masterAddress) {
    try {
      const stale: string[] = [];
      for (const status of ["open", "expired"]) {
        const rows = await client.getOrderbook({ status, limit: 200 });
        for (const r of rows) {
          if (r.taker_address?.toLowerCase() !== masterAddress.toLowerCase()) continue;
          const expired =
            status === "expired" ||
            (r.expires_at ? Date.parse(r.expires_at) < Date.now() : false);
          if (expired) stale.push(`${r.id} (${r.pair}, ${status})`);
        }
      }
      push({
        name: "stale_own_rfqs",
        status: stale.length === 0 ? "ok" : "warn",
        detail:
          stale.length === 0
            ? "no expired RFQs of yours are still listed"
            : `${stale.length} expired RFQ(s) still listed: ${stale.join(", ")}`,
        action:
          stale.length === 0
            ? undefined
            : "Each may still hold collateral. `cancel_rfq` them, then re-read get_balances.",
      });
    } catch (e) {
      push({ name: "stale_own_rfqs", status: "warn", detail: msg(e) });
    }
  }

  const failures = checks.filter((c) => c.status === "fail");
  const readPathOk = checks.some((c) => c.name === "venue_reachable" && c.status === "ok");
  const readyToTrade = !!signer && failures.length === 0;

  return {
    ready_to_trade: readyToTrade,
    read_path_ok: readPathOk,
    mode,
    checks,
    summary: readyToTrade
      ? `Ready to trade in ${mode} mode. ${checks.filter((c) => c.status === "warn").length} warning(s).`
      : !signer
        ? "Read-only: reads verified, no delegate key configured so nothing can move money."
        : `NOT ready to trade — ${failures.length} failing check(s): ${failures
            .map((c) => c.name)
            .join(", ")}.`,
  };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
