#!/usr/bin/env node
/**
 * `suprafx-mcp` CLI entry point.
 *
 * Two modes:
 *   - `suprafx-mcp init` — interactive setup wizard. Writes
 *     `~/.suprafx/config.json` with the user's delegate priv key
 *     after they paste it in or point to a JSON file the dApp
 *     downloaded.
 *   - `suprafx-mcp` (no args) — runs the MCP server over stdio.
 *     Designed to be invoked by Claude Desktop / Cursor / Continue
 *     as a subprocess. Reads stdin for JSON-RPC, writes stdout for
 *     responses, stderr for log lines.
 */
export {};
