/**
 * Commit lifecycle for SupraFX writes.
 *
 * THE PROBLEM THIS SOLVES. Every write endpoint answers from the dApp
 * *ingress*, not from chain state. `ok:true` means "the envelope was
 * accepted into the mempool" — the validators can still reject it at
 * apply time (inactive or unauthorized delegate, cap exhausted, wrong
 * pair, replayed sequence number) and the venue will never tell you.
 * An agent that trusts `ok` fires its next write against a position it
 * does not have.
 *
 * So every write here reports a LIFECYCLE, not a boolean:
 *
 *   submitted  → the envelope was built and POSTed
 *   in_mempool → ingress accepted it (`ok:true`) — NOT yet committed
 *   applied    → a state READ confirms it landed on chain
 *   rejected   → ingress refused it outright (`ok:false`)
 *   unknown    → ingress accepted it but the confirming read never
 *                showed it inside the poll window. NOT a failure and
 *                NOT a success — read state back before acting.
 *
 * `unknown` is deliberate. The honest answer to "did it land?" when the
 * poll window expires is "I do not know yet", and an agent needs to be
 * able to tell that apart from a clean rejection.
 */

import type { SupraFxClient, SubmitResult } from "../client.js";

export type CommitState =
  | "submitted"
  | "in_mempool"
  | "applied"
  | "rejected"
  | "unknown";

export interface CommitResult {
  /** Raw ingress signal. TRUE DOES NOT MEAN COMMITTED — read `lifecycle`. */
  ok: boolean;
  lifecycle: CommitState;
  /**
   * `true` only when a state read CONFIRMED the write landed.
   * `false` only when ingress rejected it.
   * `null` when ingress accepted it but the poll window expired without
   * confirmation — genuinely unknown, not a negative.
   */
  applied: boolean | null;
  /** The read that decided `lifecycle`, named so it can be re-run by hand. */
  verified_by: string;
  /** Language-neutral, claims nothing about locked funds it did not read. */
  note: string;
  batch?: number;
  event_hash_hex?: string;
  code?: string;
  detail?: string;
  /** How long the confirming poll ran. */
  polled_ms?: number;
}

/**
 * How long to wait for a write to be CONFIRMED on chain before reporting
 * `unknown`. Batches normally commit in a few seconds.
 *
 * Tunable via `SUPRAFX_APPLY_POLL_MS`:
 *   - raise it on a slow or congested venue so fewer writes end `unknown`
 *   - set it to `0` to skip confirmation entirely (every accepted write
 *     reports `unknown` immediately) — for tests, or for a latency-bound
 *     loop that does its own accounting
 */
export const DEFAULT_APPLY_POLL_MS = 12_000;
const APPLY_POLL_INTERVAL_MS = 1_200;

/**
 * Read LAZILY, on every call — not once at module load. A module-load
 * read is decided by import order, so a caller that sets the variable in
 * its own module body (a test, a wrapper script) would be ignored because
 * this module had already been evaluated.
 */
export function applyPollMs(): number {
  const raw = process.env.SUPRAFX_APPLY_POLL_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_APPLY_POLL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_APPLY_POLL_MS;
}

/** UUID comparison that cannot produce a casing false-negative.
 *
 *  The venue has returned RFQ and quote ids in mixed casing. Comparing a
 *  lower-cased local id against a raw API id made a LANDED write report
 *  `applied:false` — the single most dangerous kind of wrong answer,
 *  because the agent then retries a trade it already has. Both sides are
 *  normalized here, dashes included. */
export function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.replace(/-/g, "").trim().toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Poll `check` until it returns true, the budget expires, or it throws.
 * A throwing check is treated as "not yet" — a transient read failure
 * must not be reported as a rejected trade.
 */
async function pollForApply(
  check: () => Promise<boolean>,
  budgetMs: number = applyPollMs(),
): Promise<{ confirmed: boolean; elapsedMs: number }> {
  const started = Date.now();
  // A zero budget means "do not confirm" — report `unknown` at once
  // rather than doing one speculative read.
  if (budgetMs <= 0) return { confirmed: false, elapsedMs: 0 };
  // First check immediately: a fast batch may already have committed.
  for (;;) {
    try {
      if (await check()) return { confirmed: true, elapsedMs: Date.now() - started };
    } catch {
      // transient read failure — keep polling, never downgrade to "rejected"
    }
    if (Date.now() - started >= budgetMs) {
      return { confirmed: false, elapsedMs: Date.now() - started };
    }
    await new Promise((r) => setTimeout(r, APPLY_POLL_INTERVAL_MS));
  }
}

/**
 * Wrap a raw ingress `SubmitResult` in a lifecycle, confirming with
 * `check` when ingress accepted it.
 *
 * `verifiedBy` names the read an operator can re-run by hand to see the
 * same thing — the runbook leans on this.
 */
export async function withLifecycle(
  res: SubmitResult,
  opts: {
    verifiedBy: string;
    check: () => Promise<boolean>;
    budgetMs?: number;
    /** What the agent should read to settle an `unknown`. */
    tieBreaker: string;
  },
): Promise<CommitResult> {
  const base = {
    ok: !!res.ok,
    batch: res.batch,
    event_hash_hex: res.event_hash_hex,
    code: res.code,
    detail: res.detail,
  };

  if (!res.ok) {
    return {
      ...base,
      lifecycle: "rejected",
      applied: false,
      verified_by: "ingress",
      note:
        `Rejected at ingress${res.code ? ` (code: ${res.code})` : ""}. ` +
        `The envelope was refused before reaching consensus, so no ` +
        `sequence slot and no funds were committed by THIS call. ` +
        `If you are unsure of the account state, read it back: ${opts.tieBreaker}.`,
    };
  }

  const { confirmed, elapsedMs } = await pollForApply(opts.check, opts.budgetMs);

  if (confirmed) {
    return {
      ...base,
      lifecycle: "applied",
      applied: true,
      verified_by: opts.verifiedBy,
      note: `Confirmed on chain by reading ${opts.verifiedBy}.`,
      polled_ms: elapsedMs,
    };
  }

  // Ingress said yes; the confirming read never saw it. Say exactly that.
  //
  // What this note must NOT do is assert that no funds were locked. The
  // previous implementation hard-coded that claim, and it was wrong in
  // every case where the write actually landed and only the confirming
  // read was late or mis-compared. Never assert a lock state you did not
  // read.
  return {
    ...base,
    lifecycle: "unknown",
    applied: null,
    verified_by: opts.verifiedBy,
    note:
      `Accepted at ingress (ok:true) but NOT confirmed on chain within ` +
      `${Math.round(elapsedMs / 1000)}s by reading ${opts.verifiedBy}. ` +
      `This is UNKNOWN, not a failure — the write may still commit, and ` +
      `it may already have locked funds. Do NOT retry blindly. ` +
      `Read state back to settle it: ${opts.tieBreaker}.`,
    polled_ms: elapsedMs,
  };
}

/** Find an RFQ by id across the statuses a write can leave it in. */
export async function findRfq(
  client: SupraFxClient,
  rfqId: string,
): Promise<{ id: string; status: string; quotes?: RawQuote[] } | null> {
  for (const status of ["open", "matched", "cancelled", "expired"]) {
    const rows = (await client.getOrderbook({ status, limit: 200 })) as unknown as Array<
      { id: string; status: string; quotes?: RawQuote[] }
    >;
    const hit = rows.find((r) => sameId(r.id, rfqId));
    if (hit) return hit;
  }
  return null;
}

/** Quote rows the public orderbook embeds on each RFQ. */
export interface RawQuote {
  id: string;
  maker_address: string;
  rate: number;
  status: string;
  created_at: string;
}

/** Find a quote by id anywhere in the public orderbook. */
export async function findQuote(
  client: SupraFxClient,
  quoteId: string,
): Promise<{ quote: RawQuote; rfqId: string; rfqStatus: string } | null> {
  for (const status of ["open", "matched", "cancelled", "expired"]) {
    const rows = (await client.getOrderbook({ status, limit: 200 })) as unknown as Array<
      { id: string; status: string; quotes?: RawQuote[] }
    >;
    for (const r of rows) {
      const q = (r.quotes ?? []).find((x) => sameId(x.id, quoteId));
      if (q) return { quote: q, rfqId: r.id, rfqStatus: r.status };
    }
  }
  return null;
}
