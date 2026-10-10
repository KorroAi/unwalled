// Sends requests for generated tools and formats responses for the agent.
import { pick } from "./pick.js";

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

  if (context) {
    const response = await context.request.fetch(url.toString(), { method: request.method, headers, data, timeout: timeoutMs, failOnStatusCode: false, maxRedirects: 10 });
    return { status: response.status(), statusText: response.statusText(), contentType: response.headers()["content-type"] ?? "", body: await response.body(), finalUrl: response.url() };
  }
  const response = await fetch(url, { method: request.method, headers, body: data, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  return { status: response.status, statusText: response.statusText, contentType: response.headers.get("content-type") ?? "", body: Buffer.from(await response.arrayBuffer()), finalUrl: response.url || url.toString() };
}

/**
 * @param {HttpResult} result
 * @param {{ pick?: string, maxChars: number }} options
 * @returns {{ text: string, isError: boolean }}
 */
export function formatResponse(result, { pick: pickExpression, maxChars }) {
  const isError = result.status >= 400;
  const header = `HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ""} — ${result.finalUrl}`;
  const isText = /json|text|xml|javascript|html|csv|graphql/i.test(result.contentType) || result.contentType === "";
  let bodyText;
  if (!result.body.length) bodyText = "(empty body)";
  else if (!isText) bodyText = `(binary body: ${result.body.length} bytes, ${result.contentType})`;
  else {
    bodyText = result.body.toString("utf8");
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {}
    if (json !== undefined) {
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
  return { text: `${header}\n${bodyText}${hint}`, isError };
}
