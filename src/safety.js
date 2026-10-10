// Guard rails around every request a generated tool sends: per-recipe policy, confirmation of risky calls,
// dry runs, per-host rate limiting and an audit log (method, redacted URL, status; never bodies or credentials).
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { redactUrl } from "./discovery/secrets.js";

const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * @typedef {object} Policy
 * @property {boolean} [readOnly] refuse every write (anything but reads)
 * @property {"none" | "destructive" | "writes"} [confirm] which calls need confirm=true
 * @property {string[]} [allowedHosts] hosts the recipe's tools may reach (default: any)
 * @property {number} [rateLimit] requests per second per host
 * @property {"auto" | "node" | "page"} [transport] how browser recipes send requests
 * @property {number} [cacheSeconds] reuse successful read responses for this long
 */

/**
 * Rules set by an administrator in the file named by UNWALLED_ORG_POLICY. They apply on top of every recipe's own policy
 * and nothing the agent does (configure_recipe, new recipes, imported recipes) can loosen them.
 * @typedef {object} OrgPolicy
 * @property {boolean} [readOnly] refuse every write, in every recipe
 * @property {string[]} [allowedHosts] the only hosts any tool may reach (subdomains included)
 * @property {"none" | "destructive" | "writes"} [confirm] minimum confirmation level
 * @property {string[]} [disabledTools] management tools that are hidden and refused (e.g. "ui", "discover")
 * @property {boolean} [audit] keep the audit log even when UNWALLED_AUDIT=0
 */

const CONFIRM_LEVELS = ["none", "destructive", "writes"];
const ORG_POLICY_KEYS = ["readOnly", "allowedHosts", "confirm", "disabledTools", "audit"];

/**
 * Reads and validates the organization policy. A policy file that is named but missing or invalid stops the server
 * instead of silently running without the rules.
 * @param {string | undefined} path @returns {OrgPolicy | null}
 */
export function loadOrgPolicy(path) {
  if (!path) return null;
  let policy;
  try {
    policy = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read the organization policy ${path}: ${/** @type {Error} */ (error).message}`);
  }
  const fail = (message) => {
    throw new Error(`Invalid organization policy ${path}: ${message}`);
  };
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) fail("expected a JSON object");
  const unknown = Object.keys(policy).filter((key) => !ORG_POLICY_KEYS.includes(key));
  if (unknown.length) fail(`unknown setting(s) ${unknown.join(", ")} (allowed: ${ORG_POLICY_KEYS.join(", ")})`);
  for (const key of ["readOnly", "audit"]) if (policy[key] !== undefined && typeof policy[key] !== "boolean") fail(`${key} must be true or false`);
  if (policy.confirm !== undefined && !CONFIRM_LEVELS.includes(policy.confirm)) fail(`confirm must be one of ${CONFIRM_LEVELS.join(", ")}`);
  for (const key of ["allowedHosts", "disabledTools"])
    if (policy[key] !== undefined && (!Array.isArray(policy[key]) || policy[key].some((v) => typeof v !== "string" || !v || /[/\s]/.test(v)))) fail(`${key} must be a list of names`);
  if (policy.allowedHosts) policy.allowedHosts = policy.allowedHosts.map((h) => h.toLowerCase());
  return policy;
}

/** @param {string[]} hosts @param {URL} url */
const hostAllowed = (hosts, url) => hosts.some((host) => url.host === host || url.hostname === host || url.hostname.endsWith(`.${host}`));

/** @param {"none" | "destructive" | "writes"} a @param {"none" | "destructive" | "writes" | undefined} b */
export const stricterConfirm = (a, b) => (b && CONFIRM_LEVELS.indexOf(b) > CONFIRM_LEVELS.indexOf(a) ? b : a);

/**
 * Whether the organization policy lets a tool reach this address. Returns the reason when it does not.
 * @param {OrgPolicy | null | undefined} org @param {URL} url
 */
export function orgHostBlock(org, url) {
  if (!org?.allowedHosts?.length || hostAllowed(org.allowedHosts, url)) return null;
  return `Blocked by the organization policy: ${url.host || url.protocol} is not an allowed host (${org.allowedHosts.join(", ")}).`;
}

/** One line for the agent: what the organization policy enforces. @param {OrgPolicy | null | undefined} org */
export function describeOrgPolicy(org) {
  if (!org) return "";
  const rules = [];
  if (org.readOnly) rules.push("read-only (writes are refused)");
  if (org.allowedHosts?.length) rules.push(`only these hosts: ${org.allowedHosts.join(", ")}`);
  if (org.confirm && org.confirm !== "none") rules.push(`confirmation required for ${org.confirm === "writes" ? "every write" : "destructive calls"}`);
  if (org.disabledTools?.length) rules.push(`disabled tools: ${org.disabledTools.join(", ")}`);
  return rules.length ? `An organization policy applies to every recipe and cannot be changed from here: ${rules.join("; ")}.` : "";
}

/** @typedef {"read" | "write" | "delete"} Intent */

/** @param {string} method @returns {Intent} */
export function intentOf(method) {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD" || upper === "OPTIONS") return "read";
  if (upper === "DELETE") return "delete";
  return "write";
}

/**
 * Decides whether a call may go out. Returns null when allowed, or the reason it is blocked.
 * @param {Policy} policy @param {{ intent: Intent, url: URL, confirmed: boolean }} call @param {"none" | "destructive" | "writes"} defaultConfirm
 * @param {OrgPolicy | null} [org] organization policy, applied first and never loosened by the recipe
 * @returns {{ blocked: boolean, reason: string } | null}
 */
export function checkPolicy(policy, { intent, url, confirmed }, defaultConfirm, org = null) {
  const orgBlock = orgHostBlock(org, url);
  if (orgBlock) return { blocked: true, reason: orgBlock };
  if (org?.readOnly && intent !== "read") return { blocked: true, reason: "Blocked by the organization policy: every recipe is read-only, writes are refused." };
  if (policy.allowedHosts?.length && !hostAllowed(policy.allowedHosts, url))
    return { blocked: true, reason: `Host ${url.host} is not in this recipe's allowed hosts (${policy.allowedHosts.join(", ")}).` };
  if (policy.readOnly && intent !== "read") return { blocked: true, reason: "This recipe is read-only (policy readOnly=true): writes are refused." };
  const confirm = stricterConfirm(policy.confirm ?? defaultConfirm, org?.confirm);
  const needsConfirmation = (confirm === "writes" && intent !== "read") || (confirm === "destructive" && intent === "delete");
  if (needsConfirmation && !confirmed)
    return { blocked: false, reason: `This ${intent === "delete" ? "destructive" : "write"} call needs confirmation: check the request below with the user, then call again with confirm=true.` };
  return null;
}

/** Spaces requests to the same host so that tools, macros and exploration never hammer a site. */
export class RateLimiter {
  constructor() {
    /** @type {Map<string, number>} */ this.next = new Map();
  }

  /** @param {string} host @param {number} perSecond */
  async wait(host, perSecond) {
    if (!perSecond || perSecond <= 0) return;
    const interval = 1000 / perSecond;
    const now = Date.now();
    const at = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, at + interval);
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  }
}

/** Responses that a retry may fix: rate limiting and temporary server or gateway errors. */
const RETRIABLE_STATUS = new Set([429, 502, 503, 504]);
const NETWORK_ERROR = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|TimeoutError|aborted/i;

/**
 * Whether a failed attempt should be retried. Reads are retried on temporary errors and network failures;
 * writes only when the server says it did not process them (429 Too Many Requests, 503 with Retry-After).
 * @param {{ status: number, headers?: Record<string, string> } | null} result @param {unknown} error @param {Intent} intent
 */
export function shouldRetry(result, error, intent) {
  if (error) return intent === "read" && NETWORK_ERROR.test(String(/** @type {any} */ (error)?.message ?? error));
  if (!result || !RETRIABLE_STATUS.has(result.status)) return false;
  if (intent === "read") return true;
  return result.status === 429 || (result.status === 503 && !!result.headers?.["retry-after"]);
}

/** Delay before the next attempt: Retry-After (seconds or date) when given, else exponential backoff with jitter; at most 30 s. @param {string | undefined} retryAfter @param {number} attempt */
export function retryDelay(retryAfter, attempt) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, 30_000);
  }
  return Math.min(500 * 2 ** attempt + Math.floor(Math.random() * 250), 30_000);
}

/** Short-lived cache of successful read responses, bounded in size. */
export class ResponseCache {
  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
    /** @type {Map<string, { at: number, result: any }>} */ this.entries = new Map();
  }

  /** @param {string} key @param {number} ttlSeconds */
  get(key, ttlSeconds) {
    const entry = this.entries.get(key);
    if (!entry || !(ttlSeconds > 0)) return null;
    if (Date.now() - entry.at > ttlSeconds * 1000) {
      this.entries.delete(key);
      return null;
    }
    return { ...entry.result, cachedAgeMs: Date.now() - entry.at };
  }

  /** @param {string} key @param {any} result */
  set(key, result) {
    this.entries.delete(key);
    this.entries.set(key, { at: Date.now(), result });
    while (this.entries.size > this.maxEntries) this.entries.delete(/** @type {string} */ (this.entries.keys().next().value));
  }

  /** @param {string} prefix */
  clear(prefix = "") {
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.entries.delete(key);
  }
}

/** Append-only JSON Lines log of the requests sent, rotated at 5 MB. */
export class AuditLog {
  /** @param {string | null} file */
  constructor(file) {
    this.file = file;
  }

  /** @param {Record<string, unknown> & { url?: string }} entry */
  write(entry) {
    if (!this.file) return;
    try {
      if (existsSync(this.file) && statSync(this.file).size > AUDIT_MAX_BYTES) renameSync(this.file, `${this.file}.1`);
      const line = { time: new Date().toISOString(), ...entry, ...(entry.url ? { url: safeUrl(entry.url) } : {}) };
      appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch {
      // Auditing must never break a call.
    }
  }
}

/** @param {string} url */
function safeUrl(url) {
  try {
    return redactUrl(url);
  } catch {
    return "(invalid url)";
  }
}

/**
 * Human-readable preview of a request, with credential values hidden. Used for dry runs and confirmations.
 * @param {{ method: string, url: string, headers?: Record<string, string>, body?: unknown }} request @param {string[]} secretHeaderNames
 */
export function previewRequest(request, secretHeaderNames) {
  const headers = Object.entries(request.headers ?? {}).map(([name, value]) => `${name}: ${secretHeaderNames.includes(name.toLowerCase()) ? "<stored secret>" : value}`);
  const body = request.body === undefined ? "" : `\nBody: ${typeof request.body === "string" ? request.body : JSON.stringify(request.body)}`.slice(0, 2000);
  return `${request.method} ${safeUrl(request.url)}${headers.length ? `\n${headers.join("\n")}` : ""}${body}`;
}
