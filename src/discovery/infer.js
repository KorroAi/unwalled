// Turns raw observed HTTP exchanges into reusable endpoint descriptions:
// path templates with named parameters, typed query parameters, inferred body schemas,
// GraphQL operations, and secrets (auth headers) split away from the shareable recipe.
import { describeShape, inferSchema } from "../tools/schema.js";

/**
 * @typedef {object} Observation
 * @property {string} method
 * @property {string} url
 * @property {number} status
 * @property {Record<string, string>} requestHeaders lowercase header names
 * @property {string | null} requestBody
 * @property {unknown} [responseJson] parsed JSON body, undefined when not JSON
 */

const TRACKER_HOSTS =
  /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|facebook\.(com|net)|sentry\.io|segment\.(io|com)|hotjar\.(com|io)|mixpanel\.com|amplitude\.com|clarity\.ms|datadoghq\.(com|eu)|browser-intake-datadoghq\.com|nr-data\.net|newrelic\.com|intercom\.io|cloudflareinsights\.com|plausible\.io|posthog\.com|fullstory\.com|bugsnag\.com|launchdarkly\.com|optimizely\.com|tiktok\.com|bat\.bing\.com|linkedin\.com|snapchat\.com)$/i;
const TRACKER_PATHS = /\/(collect|beacon|telemetry|analytics|track|events?|log|metrics|rum|pixel|ping)(\/|$|\?)/i;

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey)$|token|secret|session|auth|signature|password|csrf|xsrf/i;
const DROPPED_HEADER =
  /^(:.*|accept-encoding|accept-language|user-agent|referer|origin|sec-.*|connection|host|content-length|content-type|priority|cache-control|pragma|dnt|upgrade-insecure-requests|te|if-none-match|if-modified-since|range|x-forwarded-.*)$/i;

// Query parameters and body fields whose values must never be written into a shareable recipe.
const SENSITIVE_FIELD = /^(key|sig|sid|auth|otp|pwd|passwd|code_verifier)$|token|secret|password|signature|session|api[_-]?key|apikey|credential/i;

/** Copy of a JSON value with sensitive fields replaced by "REDACTED". @param {unknown} value @returns {unknown} */
export function redact(value, depth = 0) {
  if (depth > 20) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, SENSITIVE_FIELD.test(key) && (item === null || typeof item !== "object") ? "REDACTED" : redact(item, depth + 1)]),
    );
  }
  return value;
}

/** @param {string} address */
export function redactUrl(address) {
  const url = new URL(address);
  for (const key of [...url.searchParams.keys()]) if (SENSITIVE_FIELD.test(key)) url.searchParams.set(key, "REDACTED");
  return url.toString();
}

/** Redacts sensitive "name=value" pairs in a text (form-encoded) body. @param {string} text */
export function redactText(text) {
  try {
    const params = new URLSearchParams(text);
    if ([...params.keys()].some((key) => SENSITIVE_FIELD.test(key))) {
      for (const key of [...params.keys()]) if (SENSITIVE_FIELD.test(key)) params.set(key, "REDACTED");
      return params.toString();
    }
  } catch {}
  return text;
}

/** @param {string} host */
export function isTracker(host) {
  return TRACKER_HOSTS.test(host);
}

/** Approximate registrable domain ("api.shop.co.uk" -> "shop.co.uk"). @param {string} hostname */
export function registrableDomain(hostname) {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":") || !hostname.includes(".")) return hostname;
  const labels = hostname.split(".");
  const secondLevel = labels.at(-2) ?? "";
  const count = labels.at(-1)?.length === 2 && secondLevel.length <= 3 && labels.length > 2 ? 3 : 2;
  return labels.slice(-count).join(".");
}

/**
 * @param {Record<string, string>} headers
 * @param {{ secretCookies: boolean }} options cookies are secrets for HAR replay; a browser profile manages them itself
 */
export function splitHeaders(headers, { secretCookies }) {
  /** @type {Record<string, string>} */ const keep = {};
  /** @type {Record<string, string>} */ const secret = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (name.startsWith(":")) continue; // HTTP/2 pseudo-headers (":authority" is not an auth header)
    if (name === "cookie") {
      if (secretCookies) secret[name] = value;
    } else if (SENSITIVE_HEADER.test(name)) secret[name] = value;
    else if (!DROPPED_HEADER.test(name)) keep[name] = value;
  }
  return { keep, secret };
}

/** @param {string | null} text @param {string} contentType */
export function parseBody(text, contentType = "") {
  if (text === null || text === undefined || text === "") return { kind: "none", value: undefined };
  if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
    try {
      return { kind: "json", value: JSON.parse(text) };
    } catch {}
  }
  if (/x-www-form-urlencoded/i.test(contentType)) return { kind: "form", value: Object.fromEntries(new URLSearchParams(text)) };
  return { kind: "text", value: text };
}

/** @param {string} segment */
export function looksLikeId(segment) {
  return (
    /^\d+$/.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
    /^[0-9a-f]{12,}$/i.test(segment) ||
    (segment.length >= 10 && /\d/.test(segment) && /[a-z]/i.test(segment) && /^[\w-]+$/.test(segment) && !/^v\d+$/i.test(segment))
  );
}

/** @param {string} text */
const snake = (text) =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

/** @param {string} word */
function singular(word) {
  if (/ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(ss|us|is)$/i.test(word)) return word;
  if (/(x|ch|sh|ses)$/i.test(word) && /es$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word)) return word.slice(0, -1);
  return word;
}

/** @param {string} value */
function scalarType(value) {
  if (/^-?\d{1,15}$/.test(value)) return "integer";
  if (/^-?\d*\.\d+$/.test(value)) return "number";
  if (/^(true|false)$/.test(value)) return "boolean";
  return "string";
}

/** Signature of a response used to decide whether two URLs are the same resource. @param {unknown} json */
function responseSignature(json) {
  if (json === undefined) return "none";
  if (Array.isArray(json)) return `[${json.length ? responseSignature(json[0]) : ""}]`;
  if (json && typeof json === "object") return Object.keys(json).sort().join(",");
  return typeof json;
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

// ---------------------------------------------------------------- GraphQL

/** @param {any} payload */
const isGraphqlPayload = (payload) =>
  !!payload && typeof payload === "object" && !Array.isArray(payload) && (typeof payload.query === "string" || !!payload.extensions?.persistedQuery);

/** @param {Observation} obs @returns {any[] | null} GraphQL payloads carried by this request */
function graphqlPayloads(obs) {
  const url = new URL(obs.url);
  if (obs.method === "GET" && (url.searchParams.has("query") || url.searchParams.has("extensions")) && /graphql|gql/i.test(url.pathname)) {
    const parse = (key) => {
      const raw = url.searchParams.get(key);
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    };
    return [{ query: url.searchParams.get("query") ?? undefined, operationName: url.searchParams.get("operationName") ?? undefined, variables: parse("variables"), extensions: parse("extensions") }];
  }
  if (obs.method !== "POST") return null;
  const body = parseBody(obs.requestBody, obs.requestHeaders["content-type"] ?? "");
  if (body.kind !== "json") return null;
  if (Array.isArray(body.value) && body.value.length && body.value.every(isGraphqlPayload)) return body.value;
  return isGraphqlPayload(body.value) ? [body.value] : null;
}

/** @param {string | undefined} query */
export function graphqlOperationInfo(query) {
  if (!query) return { type: "unknown", name: undefined };
  const cleaned = query.replace(/#[^\n]*/g, "").trim();
  if (cleaned.startsWith("{")) return { type: "query", name: undefined };
  const match = /^(query|mutation|subscription)\b\s*([A-Za-z_][A-Za-z0-9_]*)?/.exec(cleaned);
  return match ? { type: match[1], name: match[2] } : { type: "unknown", name: undefined };
}

// ---------------------------------------------------------------- navigation variables

/**
 * Values the user navigated to or typed. A free value (query string, typed text) matches any path
 * segment; a value taken from a page path only matches after the same parent segment
 * (page "/crates/serde" matches API "/api/v1/crates/serde", but page "/search" never turns "/api/search" into a parameter).
 * @param {string[]} pageUrls @param {string[]} [typedTexts]
 */
export function navigationVariables(pageUrls, typedTexts = []) {
  const values = new Set(typedTexts.filter((t) => t && t.length <= 200));
  const pairs = new Set();
  for (const address of pageUrls) {
    let url;
    try {
      url = new URL(address);
    } catch {
      continue;
    }
    for (const value of url.searchParams.values()) if (value && value.length <= 200) values.add(value);
    const segments = url.pathname.split("/").filter(Boolean).map(safeDecode);
    segments.forEach((segment, index) => {
      if (index > 0) pairs.add(`${singular(segments[index - 1]).toLowerCase()} ${segment}`);
    });
  }
  return { values, pairs };
}

/** @typedef {ReturnType<typeof navigationVariables>} NavigationVariables */

/** @param {string} segment */
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** @param {string[]} segments @param {number} index @param {NavigationVariables} variables */
function isVariable(segments, index, variables) {
  const segment = segments[index];
  if (variables.values.has(segment)) return true;
  const previous = segments[index - 1];
  return !!previous && variables.pairs.has(`${singular(previous).toLowerCase()} ${segment}`);
}

// ---------------------------------------------------------------- REST path templates

/**
 * Groups URL paths into templates. A segment becomes a parameter when it looks like an id,
 * equals a value seen during navigation, or varies between URLs that return the same kind of response.
 * @param {{ key: string, segments: string[], signature: string }[]} items
 * @param {NavigationVariables} variables
 */
function buildTemplates(items, variables) {
  /** @type {Map<string, { prefix: string, segments: (string|null)[], signature: string, members: number[] }>} */
  let patterns = new Map();
  items.forEach((item, index) => {
    const segments = item.segments.map((s, i) => (s && (looksLikeId(s) || isVariable(item.segments, i, variables)) ? null : s));
    const id = `${item.key}|${segments.map((s) => s ?? "{}").join("/")}`;
    const existing = patterns.get(id);
    if (existing) existing.members.push(index);
    else patterns.set(id, { prefix: item.key, segments, signature: item.signature, members: [index] });
  });

  for (let changed = true; changed; ) {
    changed = false;
    const list = [...patterns.values()];
    for (const pattern of list) {
      const length = pattern.segments.length;
      for (let position = 0; position < length && !changed; position++) {
        // A segment followed by a parameter names a collection ("/crates/{crate}"): never a parameter itself.
        if (pattern.segments[position] === null || pattern.segments[position + 1] === null) continue;
        const wildKey = (p) => `${p.prefix}|${p.signature}|${p.segments.map((s, i) => (i === position ? "{}" : (s ?? "{}"))).join("/")}`;
        const target = wildKey(pattern);
        const group = list.filter((p) => p.segments.length === length && p.segments[position] !== null && wildKey(p) === target);
        const isLast = position === length - 1;
        if (group.length < (isLast ? 3 : 2)) continue;
        const merged = { prefix: pattern.prefix, signature: pattern.signature, segments: pattern.segments.map((s, i) => (i === position ? null : s)), members: group.flatMap((p) => p.members) };
        patterns = new Map([...patterns].filter(([, p]) => !group.includes(p)));
        const id = `${merged.prefix}|${merged.segments.map((s) => s ?? "{}").join("/")}`;
        const existing = patterns.get(id);
        if (existing) existing.members.push(...merged.members);
        else patterns.set(id, merged);
        changed = true;
      }
      if (changed) break;
    }
  }
  return [...patterns.values()];
}

/** @param {(string|null)[]} segments */
function nameParameters(segments) {
  const names = [];
  const path = segments.map((segment, index) => {
    if (segment !== null) return segment;
    const previous = segments[index - 1];
    let name = previous && /^[a-zA-Z][a-zA-Z_-]*$/.test(previous) ? snake(singular(previous)) : `param${names.length + 1}`;
    if (!name || /^(api|v\d+)$/.test(name)) name = `param${names.length + 1}`;
    while (names.includes(name)) name += "_2";
    names.push(name);
    return `{${name}}`;
  });
  return { template: path.join("/"), params: names };
}

// ---------------------------------------------------------------- main entry

/**
 * @param {Observation[]} observations
 * @param {{ variables?: NavigationVariables, maxEndpoints?: number, secretCookies?: boolean }} [options]
 */
export function inferEndpoints(observations, { variables = navigationVariables([]), maxEndpoints = 40, secretCookies = false } = {}) {
  /** @type {Record<string, Record<string, string>>} */ const secrets = {};
  const warnings = [];
  const usable = observations.filter((obs) => {
    try {
      const url = new URL(obs.url);
      return obs.status > 0 && obs.status < 400 && /^https?:$/.test(url.protocol) && !isTracker(url.hostname) && !(TRACKER_PATHS.test(url.pathname) && obs.responseJson === undefined);
    } catch {
      return false;
    }
  });

  // Secrets: sensitive headers, plus sensitive query parameters stored as "?name".
  for (const obs of usable) {
    const url = new URL(obs.url);
    const { secret } = splitHeaders(obs.requestHeaders, { secretCookies });
    for (const [name, value] of url.searchParams) if (SENSITIVE_FIELD.test(name)) secret[`?${name}`] = value;
    if (Object.keys(secret).length) secrets[url.host] = { ...(secrets[url.host] ?? {}), ...secret };
  }

  // GraphQL operations
  /** @type {Map<string, any>} */ const operations = new Map();
  const rest = [];
  for (const obs of usable) {
    const payloads = graphqlPayloads(obs);
    if (!payloads) {
      rest.push(obs);
      continue;
    }
    const url = new URL(obs.url);
    const endpoint = `${url.origin}${url.pathname}`;
    payloads.forEach((payload, index) => {
      const info = graphqlOperationInfo(payload.query);
      const name = payload.operationName || info.name;
      const hash = payload.extensions?.persistedQuery?.sha256Hash;
      const key = `${obs.method} ${endpoint} ${name ?? hash ?? payload.query}`;
      const response = Array.isArray(obs.responseJson) ? obs.responseJson[index] : obs.responseJson;
      const op = operations.get(key) ?? {
        kind: "graphql", method: obs.method, url: endpoint, operationName: name ?? null, operationType: info.type,
        query: payload.query ?? null, extensions: payload.extensions ?? null, headers: splitHeaders(obs.requestHeaders, { secretCookies }).keep,
        variableSamples: [], responseSamples: [], observed: 0,
      };
      op.observed++;
      if (payload.variables !== undefined) op.variableSamples.push(payload.variables);
      if (response !== undefined) op.responseSamples.push(response);
      operations.set(key, op);
    });
  }

  // REST endpoints
  const items = rest.map((obs) => {
    const url = new URL(obs.url);
    return {
      key: `${obs.method} ${url.origin}`,
      segments: url.pathname.split("/").map(safeDecode),
      signature: responseSignature(obs.responseJson),
    };
  });
  const endpoints = buildTemplates(items, variables).map((pattern) => {
    const members = pattern.members.map((i) => rest[i]);
    const first = members[0];
    const url = new URL(first.url);
    const { template, params } = nameParameters(pattern.segments);
    /** @type {Record<string, { type: string, example: string, seen: number }>} */ const query = {};
    const bodies = [];
    let bodyKind = "none";
    const headers = {};
    for (const obs of members) {
      for (const [name, value] of new URL(obs.url).searchParams) {
        if (SENSITIVE_FIELD.test(name)) continue; // injected from the stored secrets at call time
        const entry = query[name] ?? { type: scalarType(value), example: truncate(value, 100), seen: 0 };
        if (entry.type !== scalarType(value)) entry.type = "string";
        entry.seen++;
        query[name] = entry;
      }
      const body = parseBody(obs.requestBody, obs.requestHeaders["content-type"] ?? "");
      if (body.kind !== "none") {
        bodyKind = body.kind;
        bodies.push(body.value);
      }
      Object.assign(headers, splitHeaders(obs.requestHeaders, { secretCookies }).keep);
    }
    const responses = members.map((obs) => obs.responseJson).filter((v) => v !== undefined).slice(0, 5);
    return {
      kind: "rest",
      method: first.method,
      origin: url.origin,
      pathTemplate: template,
      pathParams: params,
      query,
      bodyKind,
      bodySchema: bodies.length ? inferSchema(bodyKind === "text" ? bodies.map(String) : bodies) : null,
      bodyExample: bodies.length ? truncate(typeof bodies[0] === "string" ? redactText(bodies[0]) : JSON.stringify(redact(bodies[0])), 500) : null,
      headers,
      responseShape: responses.length ? truncate(describeShape(inferSchema(responses)), 700) : "no JSON body",
      exampleUrl: truncate(redactUrl(first.url), 300),
      observed: members.length,
    };
  });

  const graphql = [...operations.values()].map(({ variableSamples, responseSamples, ...op }) => ({
    ...op,
    query: op.query,
    variablesSchema: variableSamples.length ? inferSchema(variableSamples) : { type: "object" },
    variablesExample: variableSamples.length ? truncate(JSON.stringify(redact(variableSamples[0])), 400) : null,
    responseShape: responseSamples.length ? truncate(describeShape(inferSchema(responseSamples.slice(0, 5))), 700) : "unknown",
  }));

  const all = [...graphql, ...endpoints].sort((a, b) => b.observed - a.observed);
  if (all.length > maxEndpoints) warnings.push(`Kept the ${maxEndpoints} most frequent of ${all.length} endpoints (UNIVERSAL_MCP_MAX_ENDPOINTS).`);
  const kept = all.slice(0, maxEndpoints);
  if (!kept.length) {
    warnings.push(
      observations.length
        ? "Traffic was captured but no reusable API call remained after filtering (errors, trackers)."
        : "No API call was observed. The page may be server-rendered, or the data appears only after interaction: pass actions, use interactive mode, or log in first.",
    );
  }
  return {
    endpoints: kept.filter((e) => e.kind === "rest"),
    graphql: kept.filter((e) => e.kind === "graphql"),
    secrets,
    warnings,
    stats: { observed: observations.length, usable: usable.length },
  };
}
