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
}

export function loadConfig(): ResolvedConfig {
  const envKey = process.env.SUPRAFX_DELEGATE_PRIV_HEX;
  const baseUrl =
    process.env.SUPRAFX_BASE_URL && process.env.SUPRAFX_BASE_URL.length > 0
      ? process.env.SUPRAFX_BASE_URL
      : undefined;
  if (envKey && envKey.length > 0) {
    return { baseUrl, delegatePrivKeyHex: envKey, configPath: "env" };
  }
  const cfgPath = join(homedir(), ".suprafx", "config.json");
  if (existsSync(cfgPath)) {
    try {
      const raw = readFileSync(cfgPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        delegatePrivKeyHex?: string;
        baseUrl?: string;
      };
      if (parsed.delegatePrivKeyHex && parsed.delegatePrivKeyHex.length > 0) {
        return {
          baseUrl: parsed.baseUrl ?? baseUrl,
          delegatePrivKeyHex: parsed.delegatePrivKeyHex,
          configPath: cfgPath,
        };
      }
      return {
        baseUrl: parsed.baseUrl ?? baseUrl,
        delegatePrivKeyHex: null,
        configPath: cfgPath,
      };
    } catch (e) {
      process.stderr.write(
        `[suprafx-mcp] warning: failed to parse ${cfgPath}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  return { baseUrl, delegatePrivKeyHex: null, configPath: null };
}
