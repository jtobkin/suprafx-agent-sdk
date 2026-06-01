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

export class SupraFxClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private cachedChainInfo: ChainInfo | null = null;

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
    const j = await this.get<{ rfqs?: OrderbookRfq[] }>(
      "/api/suprafx/rfqs?" + qs.toString(),
    );
    return j.rfqs ?? [];
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
      const r = await fetch(this.baseUrl + path, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      if (!r.ok) {
        throw new Error(`GET ${path} → ${r.status} ${r.statusText}`);
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
      const r = await fetch(this.baseUrl + path, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
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
