// Finds a published OpenAPI / Swagger description and normalizes its operations.
import YAML from "yaml";

const DOC_PATHS = [
  "/openapi.json", "/openapi.yaml", "/openapi.yml", "/swagger.json", "/swagger.yaml",
  "/v3/api-docs", "/v2/api-docs", "/api-docs", "/api-docs.json", "/api/openapi.json", "/api/swagger.json",
  "/api/v1/openapi.json", "/api/v3/openapi.json", "/swagger/v1/swagger.json", "/docs/openapi.json", "/.well-known/openapi.json", "/doc",
];
const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const MAX_SCHEMA_CHARS = 12_000;

/** @param {string} text @param {string} contentType */
function parseSpec(text, contentType) {
  let spec;
  try {
    spec = /ya?ml/i.test(contentType) || !/^\s*[{[]/.test(text) ? YAML.parse(text) : JSON.parse(text);
  } catch {
    return null;
  }
  return spec && typeof spec === "object" && (spec.openapi || spec.swagger) && spec.paths && typeof spec.paths === "object" ? spec : null;
}

/** @param {string} url @param {number} timeoutMs */
async function fetchText(url, timeoutMs) {
  try {
    const response = await fetch(url, { headers: { accept: "application/json, application/yaml, text/yaml, */*" }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (!response.ok) return null;
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 20 * 1024 * 1024) return null;
    return { text: await response.text(), contentType: response.headers.get("content-type") ?? "", url: response.url || url };
  } catch {
    return null;
  }
}

/**
 * Tries the URL itself, links found in a Swagger UI page, then well-known locations.
 * @param {string} url @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ specUrl: string, spec: any } | null>}
 */
export async function findOpenApi(url, { timeoutMs = 8000 } = {}) {
  const tried = new Set();
  /** @param {string} candidate */
  const attempt = async (candidate) => {
    if (tried.has(candidate)) return null;
    tried.add(candidate);
    const result = await fetchText(candidate, timeoutMs);
    if (!result) return null;
    const spec = parseSpec(result.text, result.contentType);
    if (spec) return { specUrl: result.url, spec };
    // A Swagger UI / Redoc page usually references its spec URL.
    if (/swagger-ui|redoc|openapi/i.test(result.text) && /html/i.test(result.contentType)) {
      const links = [...result.text.matchAll(/["'(]([^"'()\s]+?\.(?:json|ya?ml))["')]/g)].slice(0, 5);
      for (const [, link] of links) {
        const nested = new URL(link, result.url).toString();
        if (tried.has(nested)) continue;
        tried.add(nested);
        const linked = await fetchText(nested, timeoutMs);
        const linkedSpec = linked && parseSpec(linked.text, linked.contentType);
        if (linkedSpec) return { specUrl: linked.url, spec: linkedSpec };
      }
    }
    return null;
  };

  const start = new URL(url);
  const found = await attempt(start.toString());
  if (found) return found;
  const prefixes = new Set([""]);
  const firstSegment = start.pathname.split("/").filter(Boolean)[0];
  if (firstSegment) prefixes.add(`/${firstSegment}`);
  for (const prefix of prefixes) {
    const results = await Promise.all(DOC_PATHS.map((path) => attempt(`${start.origin}${prefix}${path}`)));
    const hit = results.find(Boolean);
    if (hit) return hit;
  }
  return null;
}

/** Resolves local JSON pointers ($ref: "#/...") with cycle and size guards. */
function makeResolver(spec) {
  /** @param {string} ref */
  const lookup = (ref) =>
    ref
      .slice(2)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce((node, key) => (node == null ? undefined : node[key]), spec);

  /** @param {any} node @param {number} depth @param {Set<string>} seen */
  const resolve = (node, depth = 0, seen = new Set()) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item) => resolve(item, depth, seen));
    if (typeof node.$ref === "string") {
      const ref = node.$ref;
      if (!ref.startsWith("#/") || seen.has(ref) || depth > 8) return { description: `See ${ref} in the API description` };
      return resolve(lookup(ref), depth + 1, new Set([...seen, ref]));
    }
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "example" || key === "examples" || key === "xml" || key.startsWith("x-")) continue;
      out[key] = resolve(value, depth, seen);
    }
    return out;
  };
  return resolve;
}

/** @param {any} schema */
function capSchema(schema) {
  if (!schema) return schema;
  return JSON.stringify(schema).length > MAX_SCHEMA_CHARS ? { type: "object", description: "Large schema omitted; see the API description." } : schema;
}

/** @param {any} spec @param {string} specUrl */
export function resolveBaseUrl(spec, specUrl) {
  const fallback = new URL(specUrl);
  if (spec.swagger) {
    const scheme = spec.schemes?.[0] ?? fallback.protocol.replace(":", "");
    return `${scheme}://${spec.host ?? fallback.host}${(spec.basePath ?? "").replace(/\/$/, "")}`;
  }
  const server = spec.servers?.[0];
  if (!server?.url) return fallback.origin;
  const filled = server.url.replace(/\{([^}]+)\}/g, (_, name) => server.variables?.[name]?.default ?? "");
  return new URL(filled, specUrl).toString().replace(/\/$/, "");
}

/** JSON Schema for a Swagger 2 non-body parameter ("file" is not a JSON Schema type). @param {any} param */
function swagger2Schema(param) {
  if (!param.type) return { type: "string" };
  if (param.type === "file") return { type: "string", description: "File upload (not supported: send the file content as text if the API allows it)." };
  return {
    type: param.type,
    ...(param.enum ? { enum: param.enum } : {}),
    ...(param.type === "array" ? { items: param.items?.type && param.items.type !== "file" ? { type: param.items.type } : { type: "string" } } : {}),
  };
}

/** @param {string} text */
const snake = (text) => text.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();

/**
 * @param {any} spec
 * @param {string} specUrl
 * @param {{ include?: string, maxTools?: number }} [options]
 */
export function normalizeOpenApi(spec, specUrl, { include, maxTools = 60 } = {}) {
  const resolve = makeResolver(spec);
  const filter = include ? new RegExp(include, "i") : null;
  const operations = [];
  const routes = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    const shared = item.parameters ?? [];
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const id = snake(op.operationId || `${method}_${path}`) || `${method}_root`;
      routes.push({ method: method.toUpperCase(), path, id, summary: (op.summary || op.description || "").slice(0, 160) });
      if (filter && !filter.test(`${id} ${path} ${op.summary ?? ""} ${(op.tags ?? []).join(" ")}`)) continue;

      const byKey = new Map();
      for (const raw of [...shared, ...(op.parameters ?? [])]) {
        const param = resolve(raw);
        if (param?.name && param.in) byKey.set(`${param.in}:${param.name}`, param);
      }
      const params = [];
      let body = null;
      const formFields = {};
      for (const param of byKey.values()) {
        if (param.in === "body") body = { contentType: "application/json", schema: capSchema(param.schema ?? {}) };
        else if (param.in === "formData") formFields[param.name] = { ...swagger2Schema(param), ...(param.description ? { description: param.description } : {}) };
        else if (["path", "query", "header"].includes(param.in))
          params.push({
            name: param.name, in: param.in, required: !!param.required || param.in === "path",
            schema: capSchema(param.schema ?? swagger2Schema(param)),
            description: (param.description ?? "").slice(0, 300),
          });
      }
      if (Object.keys(formFields).length) body = { contentType: "application/x-www-form-urlencoded", schema: { type: "object", properties: formFields } };
      if (op.requestBody) {
        const requestBody = resolve(op.requestBody);
        const content = requestBody?.content ?? {};
        const type = Object.keys(content).find((t) => /json/i.test(t)) ?? Object.keys(content).find((t) => /form-urlencoded/i.test(t)) ?? Object.keys(content)[0];
        if (type) body = { contentType: type, schema: capSchema(content[type]?.schema ?? {}), required: !!requestBody.required };
      }
      operations.push({
        id, method: method.toUpperCase(), path,
        summary: [op.summary, op.description].filter(Boolean).join(" — ").slice(0, 500),
        deprecated: !!op.deprecated, params, body,
      });
    }
  }
  const selected = operations.filter((o) => !o.deprecated).slice(0, maxTools);
  const warnings = [];
  if (routes.length > selected.length)
    warnings.push(`${routes.length} operations in total, ${selected.length} became tools (deprecated ones, the "include" filter or the tool limit exclude the rest). Use the __routes and __request tools to reach them.`);
  return { baseUrl: resolveBaseUrl(spec, specUrl), title: spec.info?.title ?? null, operations: selected, routes, warnings };
}
