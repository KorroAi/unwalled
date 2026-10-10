// Runtime configuration, read from environment variables.
import { join, resolve } from "node:path";
import { ENV_PREFIX, defaultHome, env } from "./env.js";

/** @param {string} name @param {number} fallback */
function intFromEnv(name, fallback) {
  const raw = env(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${ENV_PREFIX}${name} must be a positive integer, got "${raw}"`);
  return value;
}

/** @param {string} name @param {string[]} allowed @param {string} fallback */
function choiceFromEnv(name, allowed, fallback) {
  const raw = (env(name) || fallback).toLowerCase();
  if (!allowed.includes(raw)) throw new Error(`${ENV_PREFIX}${name} must be one of ${allowed.join(", ")}, got "${raw}"`);
  return raw;
}

/** @param {string} name */
function numberFromEnv(name, fallback) {
  const raw = env(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${ENV_PREFIX}${name} must be a non-negative number, got "${raw}"`);
  return value;
}

export function loadConfig() {
  const home = resolve(env("HOME") || defaultHome());
  return {
    home,
    recipesDir: join(home, "recipes"),
    profilesDir: join(home, "profiles"),
    secretsDir: join(home, "secrets"),
    /** Local per-recipe state (policy, discovery inputs, health): never shared. */
    stateDir: join(home, "state"),
    auditFile: env("AUDIT") === "0" ? null : join(home, "audit.log"),
    /** "chrome" | "msedge" | "chromium" | absolute path to a Chromium-based executable */
    browser: env("BROWSER") || "chrome",
    maxOutputChars: intFromEnv("MAX_OUTPUT", 40_000),
    requestTimeoutMs: intFromEnv("TIMEOUT_MS", 30_000),
    maxEndpoints: intFromEnv("MAX_ENDPOINTS", 40),
    maxOpenApiTools: intFromEnv("MAX_OPENAPI_TOOLS", 60),
    /** Calls that need confirm=true: "destructive" (DELETE, default), "writes" (anything but reads) or "none". */
    confirm: /** @type {"none" | "destructive" | "writes"} */ (choiceFromEnv("CONFIRM", ["none", "destructive", "writes"], "destructive")),
    /** Automatic retries of temporary failures (429, 502, 503, 504, network errors). */
    retries: numberFromEnv("RETRIES", 2),
    /** Requests per second per host (0 disables the limit). */
    rateLimit: numberFromEnv("RATE_LIMIT", 5),
    /** "all": every generated tool is listed; "search": only search_tools/call_tool; "auto": search above toolThreshold tools. */
    toolMode: /** @type {"all" | "search" | "auto"} */ (choiceFromEnv("TOOL_MODE", ["all", "search", "auto"], "auto")),
    toolThreshold: intFromEnv("TOOL_THRESHOLD", 60),
    /** Secrets are encrypted at rest unless UNWALLED_PLAINTEXT_SECRETS=1. */
    encryptSecrets: env("PLAINTEXT_SECRETS") !== "1",
    schemaBudget: intFromEnv("SCHEMA_CHARS", 3000),
    foldThreshold: env("FOLD_THRESHOLD") === "0" ? 0 : intFromEnv("FOLD_THRESHOLD", 20),
  };
}

/** @typedef {ReturnType<typeof loadConfig>} Config */
