// Sends requests for generated tools and formats responses for the agent.
import { pick } from "./pick.js";
import { convertToJson } from "./formats.js";
import { describeProtobuf } from "./protobuf.js";

/**
 * @typedef {object} OutgoingRequest
 * @property {string} method
 * @property {string} url
 * @property {Record<string, string>} [headers]
 * @property {unknown} [body]
 * @property {"json" | "form" | "text" | "none"} [bodyKind]
 */

/**
 * @typedef {object} HttpResult
 * @property {number} status
 * @property {string} statusText
 * @property {string} contentType
 * @property {Buffer} body
 * @property {string} finalUrl
 */

/** @param {OutgoingRequest} request */
function encodeBody(request) {
  const kind = request.bodyKind ?? (request.body === undefined ? "none" : "json");
  if (request.body === undefined || kind === "none") return { data: undefined, contentType: undefined };
  if (kind === "form") {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (request.body ?? {}))) form.append(key, typeof value === "string" ? value : JSON.stringify(value));
    return { data: form.toString(), contentType: "application/x-www-form-urlencoded" };
  }
  if (kind === "text") return { data: String(request.body), contentType: "text/plain;charset=UTF-8" };
  return { data: JSON.stringify(request.body), contentType: "application/json" };
}

/**
 * @param {OutgoingRequest} request
 * @param {{ timeoutMs: number, context?: import("playwright-core").BrowserContext }} options
 * With a browser context, the request shares the profile's cookies.
 * @returns {Promise<HttpResult>}
 */
export async function sendRequest(request, { timeoutMs, context }) {
  const url = new URL(request.url);
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Only http(s) URLs are allowed, got ${url.protocol}`);
  const { data, contentType } = encodeBody(request);
  const headers = { accept: "application/json, */*;q=0.8", ...(request.headers ?? {}) };
  if (contentType && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = contentType;

  const once = async () => {
    if (context) {
      const response = await context.request.fetch(url.toString(), { method: request.method, headers, data, timeout: timeoutMs, failOnStatusCode: false, maxRedirects: 10 });
      const result = { status: response.status(), statusText: response.statusText(), contentType: response.headers()["content-type"] ?? "", body: await response.body(), finalUrl: response.url() };
      return { result, retryAfter: response.headers()["retry-after"] };
    }
    const response = await fetch(url, { method: request.method, headers, body: data, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    const result = { status: response.status, statusText: response.statusText, contentType: response.headers.get("content-type") ?? "", body: Buffer.from(await response.arrayBuffer()), finalUrl: response.url || url.toString() };
    return { result, retryAfter: response.headers.get("retry-after") ?? undefined };
  };
  // Rate limits and temporary outages: idempotent requests are retried (at most twice), honouring Retry-After up to a limit.
  const idempotent = ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"].includes(request.method.toUpperCase());
  for (let attempt = 0; ; attempt++) {
    const { result, retryAfter } = await once();
    if (!idempotent || attempt >= MAX_RETRIES || !RETRY_STATUS.has(result.status)) return result;
    const delay = retryDelayMs(retryAfter, attempt);
    if (delay === null) return result;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 10_000;
const RETRY_STATUS = new Set([429, 502, 503, 504]);

/**
 * Delay before retrying: Retry-After (seconds or HTTP date) when present, otherwise 0.5 s then 1.5 s.
 * Returns null when the server asks to wait longer than the limit (the caller gets the response instead).
 * @param {string | undefined} retryAfter @param {number} attempt
 */
export function retryDelayMs(retryAfter, attempt, now = Date.now()) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(ms)) return ms > MAX_RETRY_DELAY_MS ? null : Math.max(ms, 0);
  }
  return attempt === 0 ? 500 : 1500;
}

/**
 * @param {HttpResult} result
 * @param {{ pick?: string, maxChars: number }} options
 * @returns {{ text: string, isError: boolean, status: number, json?: unknown }} status and the full parsed JSON (before pick) for callers such as pagination
 */
export function formatResponse(result, { pick: pickExpression, maxChars }) {
  const isError = result.status >= 400;
  const header = `HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ""} — ${result.finalUrl}`;
  const isText = /json|text|xml|javascript|html|csv|graphql|event-stream/i.test(result.contentType) || result.contentType === "";
  // Protobuf and gRPC-web bodies are decoded without schema into JSON keyed by field number.
  const decoded = !isText && result.body.length ? describeProtobuf(result.body, result.contentType) : undefined;
  let bodyText;
  /** @type {unknown} */ let parsed;
  if (!result.body.length) bodyText = "(empty body)";
  else if (!isText && decoded === undefined) bodyText = `(binary body: ${result.body.length} bytes, ${result.contentType})`;
  else {
    // CSV and XML (RSS, Atom, SOAP...) are converted to JSON so that pick and pagination work on them.
    const raw = decoded ?? result.body.toString("utf8");
    bodyText = decoded ?? (isError ? undefined : convertToJson(raw, result.contentType)) ?? raw;
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {}
    if (json !== undefined) {
      parsed = json;
      if (pickExpression && !isError) {
        const selected = pick(json, pickExpression);
        bodyText = selected === undefined ? `(pick "${pickExpression}" matched nothing; full body follows)\n${JSON.stringify(json)}` : JSON.stringify(selected, null, 1);
      } else bodyText = JSON.stringify(json);
    }
  }
  if (bodyText.length > maxChars) bodyText = `${bodyText.slice(0, maxChars)}\n… [truncated: ${bodyText.length} characters in total; use "pick" or raise "max_chars"]`;
  let hint = "";
  if (result.status === 401 || result.status === 403)
    hint = "\nHint: the session or credentials may have expired. Use the login tool (browser recipes) or set_credentials, then retry.";
  return { text: `${header}\n${bodyText}${hint}`, isError, status: result.status, ...(parsed !== undefined ? { json: parsed } : {}) };
}
