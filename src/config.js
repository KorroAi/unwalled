// Runtime configuration, read from environment variables.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** @param {string} name @param {number} fallback */
function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

export function loadConfig() {
  const home = resolve(process.env.UNIVERSAL_MCP_HOME || join(homedir(), ".universal-mcp"));
  return {
    home,
    recipesDir: join(home, "recipes"),
    profilesDir: join(home, "profiles"),
    secretsDir: join(home, "secrets"),
    /** "chrome" | "msedge" | "chromium" | absolute path to a Chromium-based executable */
    browser: process.env.UNIVERSAL_MCP_BROWSER || "chrome",
    maxOutputChars: intFromEnv("UNIVERSAL_MCP_MAX_OUTPUT", 40_000),
    requestTimeoutMs: intFromEnv("UNIVERSAL_MCP_TIMEOUT_MS", 30_000),
    maxEndpoints: intFromEnv("UNIVERSAL_MCP_MAX_ENDPOINTS", 40),
    maxOpenApiTools: intFromEnv("UNIVERSAL_MCP_MAX_OPENAPI_TOOLS", 60),
    cacheSeconds: process.env.UNIVERSAL_MCP_CACHE_SECONDS === "0" ? 0 : intFromEnv("UNIVERSAL_MCP_CACHE_SECONDS", 0),
  };
}

/** @typedef {ReturnType<typeof loadConfig>} Config */
