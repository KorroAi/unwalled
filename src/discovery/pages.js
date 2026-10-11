// Server-rendered pages seen during discovery, turned into page templates: "/customers/537" and "/customers/512"
// become "/customers/{customer}". Only pages whose HTML itself carries content qualify (single-page app shells do not).
import { looksLikeId, nameParameters } from "./infer.js";
import { isSecretParam, isSecretSegment, looksSensitive, REDACTED } from "./secrets.js";

/** Pages that are about signing in or out, not data. */
const ACCOUNT_PAGE = /(^|\/)(login|logout|log-in|log-out|signin|sign-in|signout|sign-out|signup|sign-up|register|auth|oauth|sso|password|reset|session)(\/|$|\.)/i;
/** A sign-in page: a request answered by a redirection there means the session has ended. */
const SIGN_IN_PAGE = /(^|\/)(login|log-in|signin|sign-in|sso|auth)(\/|$|\.|\?)/i;

/** A sign-in page or form target ("/login", "/accounts/sign-in"). @param {string} pathname */
export const isSignInPath = (pathname) => SIGN_IN_PAGE.test(pathname);

/**
 * True when a call was redirected to the site's sign-in page (sessions that end send the browser there with a 200).
 * @param {string} requested @param {string} final
 */
export function redirectedToSignIn(requested, final) {
  try {
    const from = new URL(requested);
    const to = new URL(final);
    return from.href !== to.href && SIGN_IN_PAGE.test(to.pathname) && !SIGN_IN_PAGE.test(from.pathname);
  } catch {
    return false;
  }
}

/** Below this many characters of text in the server's HTML, a page is an app shell filled by JavaScript. */
export const MIN_PAGE_TEXT = 400;

/**
 * @typedef {{ url: string, textLength: number, tables: number }} PageDocument a document loaded during discovery
 * @typedef {{ origin: string, pathTemplate: string, pathParams: string[], pathExamples: Record<string, string>,
 *   query: Record<string, { example: string, values: string[] }>, title?: string, observed: number, tables: number }} PageTemplate
 */

/**
 * @param {PageDocument[]} documents @param {{ maxPages?: number }} [options]
 * @returns {PageTemplate[]}
 */
export function inferPages(documents, { maxPages = 10 } = {}) {
  /** @type {Map<string, PageTemplate>} */ const templates = new Map();
  for (const doc of documents) {
    if (doc.textLength < MIN_PAGE_TEXT) continue;
    let url;
    try {
      url = new URL(doc.url);
    } catch {
      continue;
    }
    // Account pages are not data; "__cf_chl" pages are a bot challenge being solved.
    if (!/^https?:$/.test(url.protocol) || ACCOUNT_PAGE.test(url.pathname) || /[?&]__cf_chl_/i.test(url.search)) continue;
    const raw = url.pathname.split("/");
    const segments = raw.map((segment, i) => {
      const value = decodeURIComponentSafe(segment);
      return segment && (looksLikeId(value) || isSecretSegment(value, decodeURIComponentSafe(raw[i - 1] ?? ""))) ? null : segment;
    });
    const { template, params } = nameParameters(segments);
    const key = `${url.origin}${template}`;
    const existing = templates.get(key);
    const entry = existing ?? { origin: url.origin, pathTemplate: template || "/", pathParams: params, pathExamples: {}, query: {}, observed: 0, tables: 0 };
    entry.observed++;
    entry.tables = Math.max(entry.tables, doc.tables);
    params.forEach((param, i) => {
      const position = segments.map((s, index) => (s === null ? index : -1)).filter((index) => index >= 0)[i];
      const value = decodeURIComponentSafe(raw[position] ?? "");
      if (!(param in entry.pathExamples) && !looksSensitive(value) && !isSecretSegment(value, raw[position - 1])) entry.pathExamples[param] = value;
    });
    for (const [name, value] of url.searchParams) {
      if (isSecretParam(name, value)) continue;
      const shown = looksSensitive(value) ? REDACTED : value.slice(0, 100);
      const q = (entry.query[name] ??= { example: shown, values: [] });
      if (!q.values.includes(shown) && q.values.length < 6) q.values.push(shown);
    }
    templates.set(key, entry);
  }
  // Three or more pages that differ only by their last segment ("/wiki/Lyon", "/wiki/Nantes", "/wiki/Lille") are one page
  // template with a parameter, as for API paths.
  /** @type {Map<string, PageTemplate[]>} */ const siblings = new Map();
  for (const t of templates.values()) {
    const parts = t.pathTemplate.split("/");
    const last = parts.at(-1) ?? "";
    if (parts.length < 3 || !last || last.startsWith("{")) continue;
    const key = `${t.origin}${parts.slice(0, -1).join("/")}/*`;
    siblings.set(key, [...(siblings.get(key) ?? []), t]);
  }
  for (const group of siblings.values()) {
    if (group.length < 3) continue;
    const parts = group[0].pathTemplate.split("/");
    const { template, params } = nameParameters([...parts.slice(0, -1).map((p) => (p.startsWith("{") ? null : p)), null]);
    const param = params.at(-1) ?? "page";
    const merged = {
      ...group[0], pathTemplate: template, pathParams: params,
      pathExamples: { ...group[0].pathExamples, [param]: decodeURIComponentSafe(parts.at(-1) ?? "") },
      observed: group.reduce((sum, t) => sum + t.observed, 0), tables: Math.max(...group.map((t) => t.tables)),
    };
    for (const t of group) templates.delete(`${t.origin}${t.pathTemplate}`);
    templates.set(`${merged.origin}${merged.pathTemplate}`, merged);
  }
  // Pages with tables first: they are the lists and records agents ask about.
  return [...templates.values()].sort((a, b) => b.tables - a.tables || b.observed - a.observed).slice(0, maxPages);
}

/** @param {string} text */
function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
