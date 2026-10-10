// Sends requests for generated tools and formats responses for the agent.
// Three transports: Node fetch (HAR / OpenAPI recipes), the browser profile's request API (shares cookies),
// and fetch() run inside an open page of the site (real browser network stack, same origin, same TLS fingerprint).
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { pick } from "./pick.js";
import { convertToJson } from "./formats.js";
import { describeProtobuf } from "./protobuf.js";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * @typedef {object} OutgoingRequest
 * @property {string} method
 * @property {string} url
 * @property {Record<string, string>} [headers]
 * @property {unknown} [body]
 * @property {"json" | "form" | "text" | "multipart" | "base64" | "none"} [bodyKind]
 * @property {Record<string, string>} [files] multipart file fields: field name -> absolute file path
 * @property {import("../safety.js").Intent} [intent]
 * @property {number} [timeoutMs] per-call timeout overriding the configured one
 */

/**
 * @typedef {object} HttpResult
 * @property {number} status
 * @property {string} statusText
 * @property {string} contentType
 * @property {Buffer} body
 * @property {string} finalUrl
 * @property {Record<string, string>} [headers]
 * @property {string} [transport]
 * @property {number} [cachedAgeMs] set when the response comes from the cache
 */

/** @param {Record<string, string> | undefined} files */
function readFiles(files) {
  return Object.entries(files ?? {}).map(([field, path]) => {
    if (!isAbsolute(path)) throw new Error(`File for "${field}" must be an absolute path: ${path}`);
    const size = statSync(path).size;
    if (size > MAX_UPLOAD_BYTES) throw new Error(`File ${path} is too large (${size} bytes, limit ${MAX_UPLOAD_BYTES})`);
    return { field, name: basename(path), buffer: readFileSync(path) };
  });
}

/** @param {OutgoingRequest} request */
function bodyKindOf(request) {
  if (request.files && Object.keys(request.files).length) return "multipart";
  return request.bodyKind ?? (request.body === undefined ? "none" : "json");
}

/** @param {unknown} value */
const asText = (value) => (typeof value === "string" ? value : JSON.stringify(value));

/** @param {OutgoingRequest} request @returns {{ data: string | Buffer | undefined, contentType: string | undefined }} */
function encodeBody(request) {
  const kind = bodyKindOf(request);
  if (kind === "multipart") return { data: undefined, contentType: undefined }; // built per transport
  if (request.body === undefined || kind === "none") return { data: undefined, contentType: undefined };
  if (kind === "form") {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (request.body ?? {}))) form.append(key, asText(value));
    return { data: form.toString(), contentType: "application/x-www-form-urlencoded" };
  }
  if (kind === "text") return { data: String(request.body), contentType: "text/plain;charset=UTF-8" };
  if (kind === "base64") return { data: Buffer.from(String(request.body), "base64"), contentType: "application/octet-stream" };
  return { data: JSON.stringify(request.body), contentType: "application/json" };
}

/** @param {OutgoingRequest} request */
function baseHeaders(request, contentType) {
  const headers = { accept: "application/json, */*;q=0.8", ...(request.headers ?? {}) };
  if (contentType && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = contentType;
  if (bodyKindOf(request) === "multipart") for (const key of Object.keys(headers)) if (key.toLowerCase() === "content-type") delete headers[key]; // boundary set by the encoder
  return headers;
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
  const headers = baseHeaders(request, contentType);
  const multipart = bodyKindOf(request) === "multipart";

  if (context) {
    /** @type {Record<string, any> | undefined} */ let form;
    if (multipart) {
      form = {};
      for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (request.body ?? {}))) form[key] = asText(value);
      for (const file of readFiles(request.files)) form[file.field] = { name: file.name, mimeType: "application/octet-stream", buffer: file.buffer };
    }
    const response = await context.request.fetch(url.toString(), {
      method: request.method, headers, ...(form ? { multipart: form } : { data }), timeout: timeoutMs, failOnStatusCode: false, maxRedirects: 10,
    });
    return {
      status: response.status(), statusText: response.statusText(), contentType: response.headers()["content-type"] ?? "", body: await response.body(),
      finalUrl: response.url(), headers: response.headers(), transport: "browser-request",
    };
  }
  /** @type {any} */ let body = data;
  if (multipart) {
    body = new FormData();
    for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (request.body ?? {}))) body.append(key, asText(value));
    for (const file of readFiles(request.files)) body.append(file.field, new Blob([file.buffer]), file.name);
  }
  const response = await fetch(url, { method: request.method, headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  return {
    status: response.status, statusText: response.statusText, contentType: response.headers.get("content-type") ?? "", body: Buffer.from(await response.arrayBuffer()),
    finalUrl: response.url || url.toString(), headers: Object.fromEntries(response.headers), transport: "node",
  };
}

// Headers a page's fetch() may not set (the browser adds its own).
const FORBIDDEN_IN_PAGE = /^(cookie|cookie2|host|origin|referer|user-agent|connection|content-length|accept-encoding|accept-charset|date|dnt|expect|keep-alive|te|trailer|transfer-encoding|upgrade|via|sec-.*|proxy-.*)$/i;

/**
 * Runs the request with fetch() inside a page of the site: the browser's own network stack, cookies,
 * service workers and TLS fingerprint are used. Only used when the user opted the recipe in (policy.transport "auto" or "page").
 * @param {import("playwright-core").Page} page @param {OutgoingRequest} request @param {{ timeoutMs: number }} options
 * @returns {Promise<HttpResult>}
 */
export async function sendInPage(page, request, { timeoutMs }) {
  const url = new URL(request.url);
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Only http(s) URLs are allowed, got ${url.protocol}`);
  const { data, contentType } = encodeBody(request);
  const headers = Object.fromEntries(Object.entries(baseHeaders(request, contentType)).filter(([name]) => !FORBIDDEN_IN_PAGE.test(name)));
  const multipart = bodyKindOf(request) === "multipart";
  const payload = {
    url: url.toString(), method: request.method, headers, timeoutMs,
    body: data === undefined ? null : Buffer.isBuffer(data) ? { base64: data.toString("base64") } : { text: data },
    multipart: multipart
      ? {
          fields: Object.entries(/** @type {Record<string, unknown>} */ (request.body ?? {})).map(([k, v]) => [k, asText(v)]),
          files: readFiles(request.files).map((f) => ({ field: f.field, name: f.name, base64: f.buffer.toString("base64") })),
        }
      : null,
  };
  const result = await page.evaluate(async (p) => {
    const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    /** @type {any} */ let body;
    if (p.multipart) {
      body = new FormData();
      for (const [k, v] of p.multipart.fields) body.append(k, v);
      for (const f of p.multipart.files) body.append(f.field, new Blob([fromBase64(f.base64)]), f.name);
    } else if (p.body) body = p.body.base64 ? fromBase64(p.body.base64) : p.body.text;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), p.timeoutMs);
    try {
      const response = await fetch(p.url, { method: p.method, headers: p.headers, body, credentials: "include", redirect: "follow", signal: controller.signal });
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), finalUrl: response.url, base64: btoa(binary) };
    } finally {
      clearTimeout(timer);
    }
  }, payload);
  return {
    status: result.status, statusText: result.statusText, contentType: result.headers["content-type"] ?? "", body: Buffer.from(result.base64, "base64"),
    finalUrl: result.finalUrl || url.toString(), headers: result.headers, transport: "page",
  };
}

/** Bot-protection interstitial (Cloudflare, Akamai, DataDome, captcha pages). @param {HttpResult} result */
export function isChallenge(result) {
  if (![403, 429, 503].includes(result.status)) return false;
  const headers = result.headers ?? {};
  if (headers["cf-mitigated"] === "challenge" || headers["x-datadome"] || headers["x-amzn-waf-action"]) return true;
  const text = /html|text/i.test(result.contentType) ? result.body.subarray(0, 20_000).toString("utf8") : "";
  return /just a moment|cf-chl|challenge-platform|attention required|captcha|are you a robot|access denied.*akamai|px-captcha|datadome/i.test(text);
}

/** Readable text from an HTML page (server-rendered sites have no JSON API). @param {string} html */
export function htmlToText(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const text = html
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `${label} [${href}]`)
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/header|\/footer)\b[^>]*>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return title ? `# ${title}\n${text}` : text;
}

/**
 * @param {HttpResult} result
 * @param {{ pick?: string, maxChars: number, saveTo?: string, raw?: boolean }} options
 * @returns {{ text: string, isError: boolean, status: number, json?: unknown }} status and the full parsed JSON (before pick) for callers such as pagination
 */
export function formatResponse(result, { pick: pickExpression, maxChars, saveTo, raw = false }) {
  const isError = result.status >= 400;
  const header = `HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ""} — ${result.finalUrl}${result.cachedAgeMs !== undefined ? ` (cached, ${Math.round(result.cachedAgeMs / 1000)}s old)` : ""}`;
  if (saveTo && !isError) {
    if (!isAbsolute(saveTo)) return { text: `${header}\nsave_to must be an absolute path.`, isError: true, status: result.status };
    writeFileSync(saveTo, result.body);
    return { text: `${header}\nSaved ${result.body.length} bytes (${result.contentType || "unknown type"}) to ${saveTo}`, isError: false, status: result.status };
  }
  const isText = /json|text|xml|javascript|html|csv|graphql|event-stream/i.test(result.contentType) || result.contentType === "";
  // Protobuf and gRPC-web bodies are decoded without schema into JSON keyed by field number.
  const decoded = !isText && result.body.length ? describeProtobuf(result.body, result.contentType) : undefined;
  let bodyText;
  /** @type {unknown} */ let parsed;
  if (!result.body.length) bodyText = "(empty body)";
  else if (!isText && decoded === undefined) bodyText = `(binary body: ${result.body.length} bytes, ${result.contentType}; pass save_to to write it to a file)`;
  else {
    // CSV and XML (RSS, Atom, SOAP...) are converted to JSON so that pick and pagination work on them.
    const text = decoded ?? result.body.toString("utf8");
    bodyText = decoded ?? (isError || raw ? undefined : convertToJson(text, result.contentType)) ?? text;
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
    } else if (/html/i.test(result.contentType) && !raw) bodyText = htmlToText(bodyText);
  }
  if (bodyText.length > maxChars) bodyText = `${bodyText.slice(0, maxChars)}\n… [truncated: ${bodyText.length} characters in total; use "pick" or raise "max_chars"]`;
  let hint = "";
  if (isChallenge(result))
    hint =
      "\nHint: a bot-protection challenge answered. If the user is allowed to automate this site, they can opt this recipe into in-page requests " +
      '(configure_recipe {"policy": {"transport": "auto"}}), or call login to solve the challenge in a visible window.';
  else if (result.status === 401 || result.status === 403)
    hint = "\nHint: the session or credentials may have expired. Use the login tool (browser recipes) or set_credentials, then retry.";
  else if (result.status === 404 || result.status === 410) hint = "\nHint: if this endpoint used to work, the site may have changed: run check_recipe (with repair=true) to rediscover it.";
  return { text: `${header}\n${bodyText}${hint}`, isError, status: result.status, ...(parsed !== undefined ? { json: parsed } : {}) };
}
