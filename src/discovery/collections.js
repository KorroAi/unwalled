// Converts API client collections (Postman v2.0/v2.1, Insomnia v4 exports) into OpenAPI 3,
// so they go through the same normalization as published API descriptions.

/** @param {any} doc */
export function isPostmanCollection(doc) {
  return !!doc && typeof doc === "object" && Array.isArray(doc.item) && /schema\.getpostman\.com|_postman_id/.test(JSON.stringify(doc.info ?? {}));
}

/** @param {any} doc */
export function isInsomniaExport(doc) {
  return !!doc && typeof doc === "object" && doc._type === "export" && Array.isArray(doc.resources);
}

/** @param {string} text */
const snake = (text) => text.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();

/** Replaces {{name}} with known values; unknown ones are kept. @param {string} text @param {Record<string, string>} vars */
export function substitute(text, vars) {
  return String(text ?? "").replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (match, name) => (vars[name] !== undefined ? vars[name] : match));
}

/** @param {unknown} value */
function exampleSchema(value, depth = 0) {
  if (depth > 8) return {};
  if (value === null) return {};
  if (Array.isArray(value)) return { type: "array", items: value.length ? exampleSchema(value[0], depth + 1) : {} };
  if (typeof value === "object") return { type: "object", properties: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, exampleSchema(v, depth + 1)])) };
  if (Number.isInteger(value)) return { type: "integer" };
  return { type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string" };
}

/**
 * Splits a request URL into origin and an OpenAPI path: ":id" and remaining "{{var}}" segments become path parameters.
 * @param {string} raw @returns {{ origin: string, path: string, pathParams: string[], query: [string, string][] } | null}
 */
function splitUrl(raw) {
  let text = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text.replace(/^\/+/, "")}`;
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(text);
  if (!match) return null;
  const pathParams = [];
  const path =
    (match[2] || "/")
      .split("/")
      .map((segment) => {
        const colon = /^:([A-Za-z_][\w-]*)$/.exec(segment);
        const variable = /^\{\{\s*([^}\s]+)\s*\}\}$/.exec(segment);
        const name = colon?.[1] ?? variable?.[1];
        if (!name) return segment;
        pathParams.push(name);
        return `{${name}}`;
      })
      .join("/") || "/";
  const query = match[3] ? [...new URLSearchParams(match[3].slice(1))] : [];
  return { origin: match[1], path, pathParams, query };
}

/**
 * @typedef {object} CollectedRequest
 * @property {string} name
 * @property {string} [folder]
 * @property {string} method
 * @property {string} url with variables substituted where known
 * @property {[string, string][]} query
 * @property {{ contentType: string, example: unknown, raw?: string } | null} body
 * @property {string} [description]
 */

/**
 * Builds an OpenAPI description from flat requests, keeping the most common origin as the server.
 * @param {string} title @param {CollectedRequest[]} requests
 */
export function toOpenApi(title, requests) {
  const parsed = requests.map((request) => ({ request, url: splitUrl(request.url) })).filter((r) => r.url);
  /** @type {Map<string, number>} */ const origins = new Map();
  for (const { url } of parsed) if (url) origins.set(url.origin, (origins.get(url.origin) ?? 0) + 1);
  const origin = [...origins].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "https://example.invalid";
  const warnings = [];
  /** @type {Record<string, Record<string, any>>} */ const paths = {};
  const usedIds = new Set();
  for (const { request, url } of parsed) {
    if (!url) continue;
    if (url.origin !== origin) {
      warnings.push(`"${request.name}" targets ${url.origin}, not ${origin}: reach it with the __request tool.`);
      continue;
    }
    if (/\{\{/.test(url.origin)) warnings.push(`Unresolved variable in the host ${url.origin}: pass "variables" or "base_url".`);
    const method = request.method.toLowerCase();
    if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) continue;
    let id = snake(`${request.folder ? `${request.folder}_` : ""}${request.name}`) || `${method}_${snake(url.path)}`;
    for (let n = 2; usedIds.has(id); n++) id = `${id.replace(/_\d+$/, "")}_${n}`;
    usedIds.add(id);
    const queryNames = new Map([...url.query, ...request.query]);
    const operation = {
      operationId: id,
      summary: request.name,
      description: request.description ?? "",
      parameters: [
        ...url.pathParams.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
        ...[...queryNames].map(([name, example]) => ({ name, in: "query", required: false, schema: { type: "string" }, description: example && !/\{\{/.test(example) ? `Example: ${example}` : "" })),
      ],
      ...(request.body
        ? { requestBody: { required: true, content: { [request.body.contentType]: { schema: { ...exampleSchema(request.body.example), ...(request.body.raw ? { description: `Example: ${request.body.raw.slice(0, 300)}` } : {}) } } } } }
        : {}),
      responses: { 200: { description: "OK" } },
    };
    // Two requests on the same method and path: keep the first, the other stays reachable through __request.
    if (paths[url.path]?.[method]) {
      warnings.push(`"${request.name}" duplicates ${request.method} ${url.path}.`);
      continue;
    }
    paths[url.path] = { ...(paths[url.path] ?? {}), [method]: operation };
  }
  return { spec: { openapi: "3.0.3", info: { title, version: "" }, servers: [{ url: origin }], paths }, warnings: [...new Set(warnings)].slice(0, 20) };
}

/** @param {any} body Postman body @returns {CollectedRequest["body"]} */
function postmanBody(body) {
  if (!body || body.disabled) return null;
  if (body.mode === "raw" && typeof body.raw === "string" && body.raw.trim()) {
    let example = body.raw;
    try {
      example = JSON.parse(body.raw);
    } catch {}
    const json = typeof example === "object" || body.options?.raw?.language === "json";
    return { contentType: json ? "application/json" : "text/plain", example, raw: body.raw };
  }
  if (body.mode === "urlencoded" || body.mode === "formdata") {
    const fields = Object.fromEntries((body[body.mode] ?? []).filter((f) => !f.disabled && f.type !== "file").map((f) => [f.key, f.value ?? ""]));
    return { contentType: "application/x-www-form-urlencoded", example: fields };
  }
  if (body.mode === "graphql" && body.graphql) {
    let variables = {};
    try {
      variables = typeof body.graphql.variables === "string" ? JSON.parse(body.graphql.variables || "{}") : (body.graphql.variables ?? {});
    } catch {}
    const example = { query: body.graphql.query, variables };
    return { contentType: "application/json", example, raw: JSON.stringify(example) };
  }
  return null;
}

/** @param {any} doc Postman collection @param {Record<string, string>} [extraVariables] */
export function postmanToOpenApi(doc, extraVariables = {}) {
  /** @type {Record<string, string>} */ const vars = {};
  for (const variable of doc.variable ?? []) if (variable?.key && !variable.disabled) vars[variable.key] = String(variable.value ?? "");
  Object.assign(vars, extraVariables);
  /** @type {CollectedRequest[]} */ const requests = [];
  /** @param {any[]} items @param {string | undefined} folder */
  const walk = (items, folder, depth = 0) => {
    if (depth > 20) return;
    for (const item of items ?? []) {
      if (Array.isArray(item?.item)) {
        walk(item.item, item.name, depth + 1);
        continue;
      }
      const request = typeof item?.request === "string" ? { url: item.request, method: "GET" } : item?.request;
      if (!request) continue;
      const rawUrl = typeof request.url === "string" ? request.url : (request.url?.raw ?? "");
      const query = (request.url?.query ?? []).filter((q) => q?.key && !q.disabled).map((q) => [q.key, substitute(q.value ?? "", vars)]);
      requests.push({
        name: item.name ?? `${request.method} ${rawUrl}`, folder, method: (request.method ?? "GET").toUpperCase(),
        url: substitute(rawUrl.split("?")[0], vars), query, body: postmanBody(request.body),
        description: typeof request.description === "string" ? request.description : request.description?.content,
      });
    }
  };
  walk(doc.item, undefined);
  return toOpenApi(doc.info?.name ?? "Postman collection", requests);
}

/** @param {any} doc Insomnia v4 export @param {Record<string, string>} [extraVariables] */
export function insomniaToOpenApi(doc, extraVariables = {}) {
  /** @type {Record<string, string>} */ const vars = {};
  for (const resource of doc.resources) {
    if (resource?._type === "environment" && resource.data && typeof resource.data === "object") {
      for (const [key, value] of Object.entries(resource.data)) if (typeof value !== "object") vars[key] = String(value);
    }
  }
  Object.assign(vars, extraVariables);
  const folders = new Map(doc.resources.filter((r) => r?._type === "request_group").map((r) => [r._id, r.name]));
  /** @type {CollectedRequest[]} */ const requests = [];
  for (const resource of doc.resources) {
    if (resource?._type !== "request" || !resource.url) continue;
    const mimeType = resource.body?.mimeType ?? "";
    /** @type {CollectedRequest["body"]} */ let body = null;
    if (typeof resource.body?.text === "string" && resource.body.text.trim()) {
      let example = resource.body.text;
      try {
        example = JSON.parse(resource.body.text);
      } catch {}
      body = { contentType: /json|graphql/i.test(mimeType) || typeof example === "object" ? "application/json" : mimeType || "text/plain", example, raw: resource.body.text };
    } else if (Array.isArray(resource.body?.params)) {
      body = { contentType: "application/x-www-form-urlencoded", example: Object.fromEntries(resource.body.params.filter((p) => !p.disabled && p.type !== "file").map((p) => [p.name, p.value ?? ""])) };
    }
    requests.push({
      name: resource.name ?? resource.url, folder: folders.get(resource.parentId), method: (resource.method ?? "GET").toUpperCase(),
      url: substitute(resource.url.replace(/\{\{\s*_\.([^}\s]+)\s*\}\}/g, "{{$1}}").split("?")[0], vars),
      query: (resource.parameters ?? []).filter((p) => p?.name && !p.disabled).map((p) => [p.name, substitute(p.value ?? "", vars)]),
      body, description: resource.description,
    });
  }
  const workspace = doc.resources.find((r) => r?._type === "workspace");
  return toOpenApi(workspace?.name ?? "Insomnia collection", requests);
}
