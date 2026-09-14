/**
 * Config loader for the MCP server. Resolves the delegate key from
 * (in priority order):
 *   1. `SUPRAFX_DELEGATE_PRIV_HEX` env var
 *   2. `~/.suprafx/config.json` file with `{ "delegatePrivKeyHex": "..." }`
 *   3. (none) — read-only mode
 *
 * The private key is loaded into memory once at startup and never
 * written back. It does NOT leave the host running `suprafx-mcp` —
 * MCP transports are stdio (local subprocess) so the key stays
 * with the agent operator's machine.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ResolvedConfig {
  baseUrl?: string;
  delegatePrivKeyHex: string | null;
  configPath: string | null;
  /**
   * The operator's MASTER StarKey address.
   *
   * Balances, locks and open orders all live on the master, not on the
   * delegate — the delegate has no balances of its own. Without this the
   * agent has to be hand-fed the address every session and loses it on
   * any context reset. Persisted here so it survives a restart.
   */
  masterAddress: string | null;
}

/** `SUPRAFX_ALLOW_DANGEROUS=1` (or `--allow-dangerous`) drops the
 *  per-call acknowledgement requirement on money tools. */
export function resolveMode(argv: string[] = process.argv): "guarded" | "autonomous" {
  if (argv.includes("--allow-dangerous")) return "autonomous";
  const v = (process.env.SUPRAFX_ALLOW_DANGEROUS ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" ? "autonomous" : "guarded";
}

/** `--tools=read` / `SUPRAFX_TOOLS=read,cancel` — which classes to expose. */
export function resolveToolGroups(argv: string[] = process.argv): Set<string> {
  const flag = argv.find((a) => a.startsWith("--tools="))?.slice("--tools=".length);
  const raw = flag ?? process.env.SUPRAFX_TOOLS ?? "";
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // Default: everything the configured key entitles you to.
  if (parts.length === 0) return new Set(["read", "trade", "cancel"]);
  const out = new Set<string>(["read"]); // reads are never withheld
  for (const p of parts) {
    if (p === "all" || p === "write") {
      out.add("trade");
      out.add("cancel");
    } else if (p === "read" || p === "trade" || p === "cancel") {
      out.add(p);
    }
  }
  return out;
}

function normalizeAddress(a: string | undefined | null): string | null {
  if (!a) return null;
  const t = a.trim();
  if (t.length === 0) return null;
  return t.startsWith("0x") ? t.toLowerCase() : "0x" + t.toLowerCase();
}

export function loadConfig(): ResolvedConfig {
  const envKey = process.env.SUPRAFX_DELEGATE_PRIV_HEX;
  const baseUrl =
    process.env.SUPRAFX_BASE_URL && process.env.SUPRAFX_BASE_URL.length > 0
      ? process.env.SUPRAFX_BASE_URL
      : undefined;
  const envMaster = normalizeAddress(process.env.SUPRAFX_MASTER_ADDRESS);
  if (envKey && envKey.length > 0) {
    return {
      baseUrl,
      delegatePrivKeyHex: envKey,
      configPath: "env",
      masterAddress: envMaster,
    };
  }
  const cfgPath = join(homedir(), ".suprafx", "config.json");
  if (existsSync(cfgPath)) {
    try {
      const raw = readFileSync(cfgPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        delegatePrivKeyHex?: string;
        baseUrl?: string;
        masterAddress?: string;
      };
      const master = envMaster ?? normalizeAddress(parsed.masterAddress);
      if (parsed.delegatePrivKeyHex && parsed.delegatePrivKeyHex.length > 0) {
        return {
          baseUrl: parsed.baseUrl ?? baseUrl,
          delegatePrivKeyHex: parsed.delegatePrivKeyHex,
          configPath: cfgPath,
          masterAddress: master,
        };
      }
      return {
        baseUrl: parsed.baseUrl ?? baseUrl,
        delegatePrivKeyHex: null,
        configPath: cfgPath,
        masterAddress: master,
      };
    } catch (e) {
      process.stderr.write(
        `[suprafx-mcp] warning: failed to parse ${cfgPath}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  return {
    baseUrl,
    delegatePrivKeyHex: null,
    configPath: null,
    masterAddress: envMaster,
  };
}
