/**
 * Owner failure-alert client for the SupraFX bots.
 *
 * Posts ONLY failures (severity "error" | "critical") to the owner alert
 * dashboard:  POST {BASE}/api/alerts/bot  with  Authorization: Bearer <secret>.
 * Contract: see docs/BOT-ALERTS.md in the suprafx repo. Successes / heartbeats
 * are rejected by the endpoint (400) by design — this is not a log sink.
 *
 * Design rules baked in here so callers can't get them wrong:
 *   - Never throws. Alerting must never crash a trading loop. All failures to
 *     post are swallowed (warned locally, never fatal).
 *   - Never logs the secret or the Authorization header. The owner reads these
 *     alerts in a browser; assume screenshots. (Rule 7.)
 *   - Deduplicates. The same `kind` from the same `source` is posted at most
 *     once, then at most once per hour until its `title` changes. A page of
 *     identical rows is the same as no alert. (Contract §1.)
 *   - No secret configured => no-op (warn once). Bots must run fine without it.
 *
 * Secret comes from BOT_ALERT_SECRET in the environment (sourced from
 * ~/.suprafx/alerts.env by the deploy launchers). Never commit it.
 */

export type Severity = "error" | "critical";

export interface BotAlert {
  source: string; // which bot, e.g. "supra-seeder" — how the owner tells them apart
  kind: string; // short stable slug for grouping, e.g. "rfq_never_landed"
  title: string; // one line, <=200 chars, specific
  severity: Severity; // "error" or "critical" ONLY
  detail?: string; // free text, no secrets/keys/seeds
  context?: Record<string, unknown>; // small structured blob (<8KB), no secrets
}

const BASE_URL = () => process.env.SUPRAFX_BASE_URL ?? "https://suprafx.ai";
// Prefer an explicit full endpoint if the deploy sets one (BOT_ALERT_URL),
// else derive it from the base. Both resolve to /api/alerts/bot in practice.
const ALERT_URL = () => process.env.BOT_ALERT_URL ?? `${BASE_URL()}/api/alerts/bot`;
const SECRET = () => process.env.BOT_ALERT_SECRET ?? "";
const DEDUP_MS = Number(process.env.ALERT_DEDUP_MS ?? 3_600_000); // 1h
const POST_TIMEOUT_MS = Number(process.env.ALERT_TIMEOUT_MS ?? 4000);

// key -> { lastMs, lastTitle }
const lastPosted = new Map<string, { at: number; title: string }>();
let warnedNoSecret = false;

/**
 * Post a failure alert. Resolves to true if the endpoint accepted it, false if
 * it was deduped / skipped / failed. NEVER throws.
 */
export async function postAlert(a: BotAlert): Promise<boolean> {
  try {
    if (a.severity !== "error" && a.severity !== "critical") {
      console.warn(`[alert] refusing non-failure severity "${a.severity}" for ${a.kind} (only error/critical allowed)`);
      return false;
    }
    const secret = SECRET();
    if (!secret) {
      if (!warnedNoSecret) {
        console.warn("[alert] BOT_ALERT_SECRET not set — failure alerts are disabled (set it in ~/.suprafx/alerts.env to enable).");
        warnedNoSecret = true;
      }
      return false;
    }

    const title = String(a.title ?? "").slice(0, 200);
    const key = `${a.source}:${a.kind}`;
    const prev = lastPosted.get(key);
    const now = Date.now();
    // Dedup: same kind+source suppressed for DEDUP_MS unless the title changed.
    if (prev && prev.title === title && now - prev.at < DEDUP_MS) return false;

    // Keep context under the 8KB server cap; drop it (not the whole alert) if oversize.
    let context = a.context;
    let detail = a.detail;
    if (context) {
      try {
        if (JSON.stringify(context).length > 8000) {
          detail = (detail ? detail + " " : "") + "[context dropped: >8KB]";
          context = undefined;
        }
      } catch {
        context = undefined;
      }
    }

    const body = JSON.stringify({
      source: a.source,
      kind: a.kind,
      title,
      severity: a.severity,
      ...(detail ? { detail } : {}),
      ...(context ? { context } : {}),
    });

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
    try {
      const res = await fetch(ALERT_URL(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body,
        signal: ctrl.signal,
      });
      if (res.ok) {
        lastPosted.set(key, { at: now, title });
        return true;
      }
      // Never echo the secret or headers — only the status.
      console.warn(`[alert] endpoint rejected ${a.kind}: HTTP ${res.status}`);
      return false;
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    console.warn(`[alert] could not post ${a?.kind ?? "?"}: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Dead-man switch. Install once at startup. On an uncaught crash or a
 * termination signal, best-effort post a `bot_halted` critical BEFORE dying
 * ("post critical before you die if you can" — contract §2g), then exit.
 */
export function installDeadman(source: string): void {
  let dying = false;
  const die = async (why: string, code: number) => {
    if (dying) return;
    dying = true;
    await postAlert({
      source,
      kind: "bot_halted",
      severity: "critical",
      title: `${source} halted: ${why}`.slice(0, 200),
      detail: why,
    });
    process.exit(code);
  };
  process.on("uncaughtException", (e) => {
    console.error(`[${source}] uncaughtException:`, e);
    void die(`uncaughtException: ${e?.message ?? e}`, 1);
  });
  process.on("unhandledRejection", (e: unknown) => {
    console.error(`[${source}] unhandledRejection:`, e);
    void die(`unhandledRejection: ${(e as Error)?.message ?? String(e)}`, 1);
  });
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => void die(`received ${sig}`, 0));
  }
}
