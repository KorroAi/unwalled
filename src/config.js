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

/** @param {string} name @param {string[]} allowed @param {string} fallback */
function choiceFromEnv(name, allowed, fallback) {
  const raw = (process.env[name] || fallback).toLowerCase();
  if (!allowed.includes(raw)) throw new Error(`${name} must be one of ${allowed.join(", ")}, got "${raw}"`);
  return raw;
}

/** @param {string} name */
function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  return value;
}

export function loadConfig() {
  const home = resolve(process.env.UNIVERSAL_MCP_HOME || join(homedir(), ".universal-mcp"));
  return {
    home,
    recipesDir: join(home, "recipes"),
    profilesDir: join(home, "profiles"),
    secretsDir: join(home, "secrets"),
    /** Local per-recipe state (policy, discovery inputs, health): never shared. */
    stateDir: join(home, "state"),
    auditFile: process.env.UNIVERSAL_MCP_AUDIT === "0" ? null : join(home, "audit.log"),
    /** "chrome" | "msedge" | "chromium" | absolute path to a Chromium-based executable */
    browser: process.env.UNIVERSAL_MCP_BROWSER || "chrome",
    maxOutputChars: intFromEnv("UNIVERSAL_MCP_MAX_OUTPUT", 40_000),
    requestTimeoutMs: intFromEnv("UNIVERSAL_MCP_TIMEOUT_MS", 30_000),
    maxEndpoints: intFromEnv("UNIVERSAL_MCP_MAX_ENDPOINTS", 40),
    maxOpenApiTools: intFromEnv("UNIVERSAL_MCP_MAX_OPENAPI_TOOLS", 60),
    /** Calls that need confirm=true: "destructive" (DELETE, default), "writes" (anything but reads) or "none". */
    confirm: /** @type {"none" | "destructive" | "writes"} */ (choiceFromEnv("UNIVERSAL_MCP_CONFIRM", ["none", "destructive", "writes"], "destructive")),
    /** Automatic retries of temporary failures (429, 502, 503, 504, network errors). */
    retries: numberFromEnv("UNIVERSAL_MCP_RETRIES", 2),
    /** Requests per second per host (0 disables the limit). */
    rateLimit: numberFromEnv("UNIVERSAL_MCP_RATE_LIMIT", 5),
    /** "all": every generated tool is listed; "search": only search_tools/call_tool; "auto": search above toolThreshold tools. */
    toolMode: /** @type {"all" | "search" | "auto"} */ (choiceFromEnv("UNIVERSAL_MCP_TOOL_MODE", ["all", "search", "auto"], "auto")),
    toolThreshold: intFromEnv("UNIVERSAL_MCP_TOOL_THRESHOLD", 60),
    /** Secrets are encrypted at rest unless UNIVERSAL_MCP_PLAINTEXT_SECRETS=1. */
    encryptSecrets: process.env.UNIVERSAL_MCP_PLAINTEXT_SECRETS !== "1",
    schemaBudget: intFromEnv("UNIVERSAL_MCP_SCHEMA_CHARS", 3000),
    foldThreshold: process.env.UNIVERSAL_MCP_FOLD_THRESHOLD === "0" ? 0 : intFromEnv("UNIVERSAL_MCP_FOLD_THRESHOLD", 20),
  };
}

/** @typedef {ReturnType<typeof loadConfig>} Config */
