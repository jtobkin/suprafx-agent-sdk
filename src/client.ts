/**
 * Thin HTTP client over the SupraFX dApp's public endpoints.
 *
 * Wraps the read + write surfaces documented in
 * `docs/INTEGRATING-AGENTS.md`. No auth required for reads; writes
 * carry their own ed25519 signature inside the BCS envelope (see
 * `./signer.ts`).
 *
 * Pure fetch — no global state, no caching beyond the chain-info
 * lookup. Safe to use from the MCP server, from a cookbook script,
 * or as a library inside a larger agent codebase.
 */

const DEFAULT_BASE = "https://suprafx.ai";

export interface SupraFxClientOptions {
  /**
   * Base URL of the SupraFX dApp. Defaults to `https://suprafx.ai`.
   * Override for staging or for direct validator HTTP submit.
   */
  baseUrl?: string;
  /** Per-request timeout in ms. Defaults to 15000. */
  timeoutMs?: number;
}

export interface ChainInfo {
  chainId: string;
  chainIdHashHex: string;
  threshold: number;
  /** Live venue also returns these; optional so older deployments parse. */
  validatorCount?: number;
  stateMachineVersion?: number;
}

export interface AssetInfo {
  chain_id: string;
  asset_symbol: string;
  contract_address: string | null;
  decimals: number;
}

export interface PlatformBalance {
  asset: string;
  available: number;
  locked_in_orders: number;
  locked_in_rfq: number;
  total: number;
}

/** Public delegate-policy response. Additional venue fields are preserved. */
export interface DelegatePolicy {
  active?: boolean;
  master?: string;
  master_address?: string;
  [key: string]: unknown;
}

export interface OrderbookRfq {
  id: string;
  taker_address: string;
  pair: string;
  size: number;
  remaining_size: number;
  source_chain: string;
  dest_chain: string;
  reference_price: number;
  status: string;
  settlement_mode: string;
  allow_partial_fills: boolean;
  min_fill_size: number;
  expires_at: string;
  created_at: string;
}

export interface SubmitResult {
  ok: boolean;
  batch?: number;
  event_hash_hex?: string;
  code?: string;
  detail?: string;
  per_validator?: unknown[];
}

/**
 * Stable, machine-readable error categories. An agent can branch on
 * `code` without parsing prose, and `action` names the one thing that
 * clears it. Mirrors the envelope Kraken ships on every command.
 */
export type SupraFxErrorCode =
  | "auth"
  | "rate_limit"
  | "validation"
  | "not_found"
  | "api"
  | "network"
  | "timeout"
  | "seq_desync"
  | "needs_acknowledgement"
  | "read_only";

export type SupraFxErrorAction =
  | "authenticate"
  | "backoff"
  | "fix_input"
  | "reconnect"
  | "configure_key"
  | "acknowledge"
  | "retry"
  | "report";

/** An error carrying a stable category and the action that clears it. */
export class SupraFxError extends Error {
  readonly code: SupraFxErrorCode;
  readonly action: SupraFxErrorAction;
  readonly status?: number;
  readonly detail?: unknown;
  constructor(
    code: SupraFxErrorCode,
    action: SupraFxErrorAction,
    message: string,
    opts: { status?: number; detail?: unknown } = {},
  ) {
    super(message);
    this.name = "SupraFxError";
    this.code = code;
    this.action = action;
    this.status = opts.status;
    this.detail = opts.detail;
  }
  /** The JSON body an MCP handler returns on failure. */
  toEnvelope(): {
    error: SupraFxErrorCode;
    action: SupraFxErrorAction;
    message: string;
    status?: number;
    detail?: unknown;
  } {
    return {
      error: this.code,
      action: this.action,
      message: this.message,
      ...(this.status != null ? { status: this.status } : {}),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };
  }
}

/** Map an HTTP status onto the stable category + its clearing action. */
function classifyStatus(status: number): {
  code: SupraFxErrorCode;
  action: SupraFxErrorAction;
} {
  if (status === 401 || status === 403) return { code: "auth", action: "authenticate" };
  if (status === 404) return { code: "not_found", action: "fix_input" };
  if (status === 429) return { code: "rate_limit", action: "backoff" };
  if (status >= 400 && status < 500) return { code: "validation", action: "fix_input" };
  return { code: "api", action: "retry" };
}

export interface OracleQuote {
  pair: string;
  conversionRate: number | null;
  updatedAt: number | null;
  /** Age of the quote in ms at read time. */
  ageMs: number | null;
}

export class SupraFxClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private cachedChainInfo: ChainInfo | null = null;
  private cachedClockOffset: { offsetMs: number; expiresAtMs: number } | null = null;

  constructor(opts: SupraFxClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  // ─── Reads ─────────────────────────────────────────────────────

  /**
   * Fetch the canonical chain-id hash and validator threshold.
   * Cached for the lifetime of the client — these values are
   * constant per chain genesis.
   */
  async getChainInfo(): Promise<ChainInfo> {
    if (this.cachedChainInfo) return this.cachedChainInfo;
    const j = await this.get<ChainInfo>("/api/council/chain-info");
    if (!j.chainIdHashHex) {
      throw new Error("getChainInfo: response missing chainIdHashHex");
    }
    this.cachedChainInfo = j;
    return j;
  }

  /**
   * Difference between the venue's HTTP clock and the local clock.
   * Best-effort only: expiry calculation must remain available when the
   * header or endpoint is unavailable.
   */
  async getVenueClockOffsetMs(): Promise<number> {
    const now = Date.now();
    if (this.cachedClockOffset && now < this.cachedClockOffset.expiresAtMs) {
      return this.cachedClockOffset.offsetMs;
    }

    let offsetMs = 0;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const r = await fetch(this.baseUrl + "/api/council/chain-info", {
          signal: ctrl.signal,
          headers: { accept: "application/json" },
        });
        const serverDateMs = Date.parse(r.headers.get("date") ?? "");
        if (Number.isFinite(serverDateMs)) {
          offsetMs = serverDateMs - Date.now();
        }
      } finally {
        clearTimeout(t);
      }
    } catch {
      // Clock alignment is advisory; never prevent a trade on failure.
    }

    this.cachedClockOffset = {
      offsetMs,
      expiresAtMs: Date.now() + 5 * 60_000,
    };
    return offsetMs;
  }

  /** Current committed batch height. Useful for `expires_at_batch` math. */
  async getCurrentBatch(): Promise<number> {
    const j = await this.get<{ ok: boolean; current_batch: number }>(
      "/api/council/current-batch",
    );
    return j.current_batch;
  }

  /**
   * Next strictly-monotonic sequence number this address must use
   * for its next signed event. `0` for a brand-new account.
   */
  async getSequenceNumber(address: string): Promise<number> {
    const a = address.startsWith("0x") ? address : "0x" + address;
    const j = await this.get<{ next_sequence_number: number }>(
      "/api/council/sequence-number?address=" + encodeURIComponent(a),
    );
    return j.next_sequence_number;
  }

  /** All supported assets with canonical chain id + decimals. */
  async listAssets(): Promise<AssetInfo[]> {
    const j = await this.get<{ assets?: AssetInfo[] }>("/api/assets");
    return j.assets ?? [];
  }

  /**
   * Available + locked balances for `address` (a master Supra account).
   * Returns an empty array if the address has no balance rows.
   */
  async getBalances(address: string): Promise<PlatformBalance[]> {
    const a = address.startsWith("0x") ? address : "0x" + address;
    const j = await this.get<{ balances?: PlatformBalance[] }>(
      "/api/platform/balances?address=" + encodeURIComponent(a),
    );
    return j.balances ?? [];
  }

  /** On-chain policy currently associated with a delegate address. */
  async getDelegatePolicy(address: string): Promise<DelegatePolicy | null> {
    const a = address.startsWith("0x") ? address : "0x" + address;
    const j = await this.get<{ policy?: DelegatePolicy | null }>(
      "/api/delegate-policy?delegate=" + encodeURIComponent(a),
    );
    return j.policy ?? null;
  }

  /**
   * Public orderbook: open RFQs. Filters as documented in
   * `INTEGRATING-AGENTS.md` §2.
   */
  async getOrderbook(filters: {
    pair?: string;
    status?: string;
    limit?: number;
  } = {}): Promise<OrderbookRfq[]> {
    const qs = new URLSearchParams({ scope: "platform" });
    if (filters.pair) qs.set("pair", filters.pair);
    if (filters.status) qs.set("status", filters.status);
    if (filters.limit) qs.set("limit", String(filters.limit));
    // RESPONSE SHAPE. `/api/suprafx/rfqs` answers
    // `{ success, data, count, hasMore, ... }` — the rows are under
    // `data`, NOT `rfqs`. Reading only `rfqs` made this silently return
    // an EMPTY array for every call (verified live 2026-09-14: the API
    // returned 3 matched RFQs, this method returned 0). That blinded
    // `get_orderbook` and made `place_quote` unable to find any parent
    // RFQ. Accept `data` first, keep `rfqs` as a fallback so an older or
    // proxied deployment still works.
    const j = await this.get<{
      data?: OrderbookRfq[];
      rfqs?: OrderbookRfq[];
    }>("/api/suprafx/rfqs?" + qs.toString());
    return j.data ?? j.rfqs ?? [];
  }

  /**
   * Venue oracle quote for `pair` (e.g. `"ETH/USDC"`), with the quote's
   * age computed at read time. Quote against THIS, never an external
   * price — and never against a stale one (see `ORACLE_STALE_MS`).
   */
  async getOracle(pair: string): Promise<OracleQuote> {
    const j = await this.get<{
      pair?: string;
      conversionRate?: number | null;
      updatedAt?: number | null;
    }>("/api/oracle?pair=" + encodeURIComponent(pair));
    const updatedAt = typeof j.updatedAt === "number" ? j.updatedAt : null;
    return {
      pair: j.pair ?? pair,
      conversionRate: typeof j.conversionRate === "number" ? j.conversionRate : null,
      updatedAt,
      ageMs: updatedAt != null ? Date.now() - updatedAt : null,
    };
  }

  // ─── Writes ────────────────────────────────────────────────────

  async submitEnvelope(
    endpoint:
      | "submit-rfq"
      | "place-quote"
      | "accept-quote"
      | "withdraw-quote"
      | "cancel-rfq",
    bodyFieldName: string,
    envelopeBcsHex: string,
  ): Promise<SubmitResult> {
    return await this.post<SubmitResult>("/api/council/" + endpoint, {
      [bodyFieldName]: envelopeBcsHex,
    });
  }

  // ─── Plumbing ──────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      let r: Response;
      try {
        r = await fetch(this.baseUrl + path, {
          signal: ctrl.signal,
          headers: { accept: "application/json" },
        });
      } catch (e) {
        // An AbortError here is our own timeout firing, not a caller cancel.
        if (ctrl.signal.aborted) {
          throw new SupraFxError(
            "timeout",
            "retry",
            `GET ${path} timed out after ${this.timeoutMs}ms`,
          );
        }
        throw new SupraFxError(
          "network",
          "retry",
          `GET ${path} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (!r.ok) {
        const { code, action } = classifyStatus(r.status);
        const body = await r.text().catch(() => "");
        throw new SupraFxError(
          code,
          action,
          `GET ${path} → ${r.status} ${r.statusText}`,
          { status: r.status, detail: body.slice(0, 400) || undefined },
        );
      }
      return (await r.json()) as T;
    } finally {
      clearTimeout(t);
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      let r: Response;
      try {
        r = await fetch(this.baseUrl + path, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (e) {
        if (ctrl.signal.aborted) {
          throw new SupraFxError(
            "timeout",
            "report",
            `POST ${path} timed out after ${this.timeoutMs}ms — the write may ` +
              `or may not have reached the venue; READ STATE BACK before retrying`,
          );
        }
        throw new SupraFxError(
          "network",
          "report",
          `POST ${path} failed: ${e instanceof Error ? e.message : String(e)} — ` +
            `the write may or may not have landed; READ STATE BACK before retrying`,
        );
      }
      if (r.status === 429) {
        throw new SupraFxError("rate_limit", "backoff", `POST ${path} → 429`, {
          status: 429,
        });
      }
      // Truth signal is body.ok per INTEGRATING-AGENTS §2 — Cloudflare
      // may strip 5xx bodies, so we don't trust status alone. Parse
      // both 2xx and 4xx bodies and let the caller inspect the code.
      const j = (await r.json().catch(() => ({}))) as T;
      return j;
    } finally {
      clearTimeout(t);
    }
  }
}
