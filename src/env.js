// Environment variables are named UNWALLED_<NAME>. The project used to be called universal-mcp:
// the former UNIVERSAL_MCP_<NAME> spelling is still read so existing setups keep working.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENV_PREFIX = "UNWALLED_";
export const LEGACY_ENV_PREFIX = "UNIVERSAL_MCP_";

/** @param {string} name variable name without its prefix, e.g. "HOME" */
export function env(name) {
  const value = process.env[ENV_PREFIX + name];
  return value !== undefined ? value : process.env[LEGACY_ENV_PREFIX + name];
}

/** Default data directory: ~/.unwalled, or ~/.universal-mcp when only that one exists. */
export function defaultHome() {
  const home = join(homedir(), ".unwalled");
  const legacy = join(homedir(), ".universal-mcp");
  return !existsSync(home) && existsSync(legacy) ? legacy : home;
}
