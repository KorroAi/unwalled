// Builds MCP tool definitions from a recipe.
import { createHash } from "node:crypto";
import { buildRpcTools } from "../discovery/jsonrpc.js";
import { buildStreamTools } from "../realtime/tools.js";
import { formatResponse } from "./http.js";
import { withCache } from "./cache.js";
import { withPagination } from "./paginate.js";

const TOOL_NAME_MAX = 64;
const DESCRIPTION_MAX = 1200;

/**
 * @typedef {object} GeneratedTool
 * @property {string} name
 * @property {string} description
 * @property {Record<string, any>} inputSchema
 * @property {Record<string, any>} annotations
 * @property {(args: Record<string, any>) => Promise<{ text: string, isError: boolean }>} run
 */

/**
 * @typedef {object} Runtime
 * @property {(recipe: any, request: import("./http.js").OutgoingRequest) => Promise<import("./http.js").HttpResult>} send
 * @property {number} maxOutputChars
 * @property {number} [cacheSeconds] default cache duration of read-only tools (0 = off)
 * @property {import("../realtime/tools.js").StreamRuntime["streamAuth"]} [streamAuth]
 */

/** @param {string} text */
const sanitize = (text) => text.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
const shortHash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 6);
const clip = (text, max = DESCRIPTION_MAX) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Unique, valid tool names: [a-zA-Z0-9_-], at most 64 characters. */
export function toolNamer(prefix) {
  const used = new Set();
  /** @param {string} suffix */
  return (suffix) => {
    let name = `${prefix}__${sanitize(suffix) || "call"}`;
    if (name.length > TOOL_NAME_MAX) name = `${name.slice(0, TOOL_NAME_MAX - 7)}_${shortHash(name)}`;
    while (used.has(name)) name = `${name.slice(0, TOOL_NAME_MAX - 7)}_${shortHash(name + used.size)}`;
    used.add(name);
    return name;
  };
}

const PROPERTY_KEY = /^[a-zA-Z0-9_.-]{1,64}$/;
const SUBSCHEMA_KEYS = new Set(["items", "additionalProperties", "anyOf", "oneOf", "allOf", "not", "prefixItems"]);

/**
 * Claude's API rejects tool schemas whose property names fall outside [a-zA-Z0-9_.-]{1,64};
 * a single "page[size]" would break every tool. Such properties are removed from "properties",
 * listed in the description, and still accepted through additionalProperties.
 * @param {any} schema @returns {any}
 */
export function safeSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 16) return schema;
  if (Array.isArray(schema)) return schema.map((item) => safeSchema(item, depth + 1));
  const out = {};
  const dropped = [];
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value && typeof value === "object") {
      out.properties = {};
      for (const [name, sub] of Object.entries(value)) {
        if (PROPERTY_KEY.test(name)) out.properties[name] = safeSchema(sub, depth + 1);
        else dropped.push(name);
      }
    } else if (SUBSCHEMA_KEYS.has(key)) out[key] = safeSchema(value, depth + 1);
    else out[key] = value;
  }
  if (Array.isArray(out.required)) {
    out.required = out.required.filter((name) => PROPERTY_KEY.test(name));
    if (!out.required.length) delete out.required;
  }
  if (dropped.length) {
    out.additionalProperties = true;
    out.description = `${out.description ? `${out.description} ` : ""}Also accepts: ${dropped.slice(0, 20).map((n) => JSON.stringify(n)).join(", ")}.`;
  }
  return out;
}

const OUTPUT_PROPERTIES = {
  pick: {
    type: "string",
    description:
      'Optional: keep only part of a JSON response, e.g. "items[*].name", "data.user,meta.total", "items[0:5]", "items[?price>10].name", ' +
      '"items[?status=open][?name~lamp]" (~ = contains), "items.#" (count).',
  },
  max_chars: { type: "integer", minimum: 20, description: "Optional: maximum characters returned (default from server configuration)." },
};

/** @param {string} method */
const annotationsFor = (method, title) => ({
  title,
  readOnlyHint: method === "GET" || method === "HEAD",
  destructiveHint: method === "DELETE",
  idempotentHint: ["GET", "HEAD", "PUT", "DELETE"].includes(method),
  openWorldHint: true,
});

/** @param {Record<string, any> | null | undefined} schema */
function asObjectSchema(schema) {
  if (schema && schema.type === "object") return { ...schema, additionalProperties: schema.additionalProperties ?? true };
  return { type: "object", additionalProperties: true };
}

/** @param {Record<string, unknown> | undefined} query @param {URL} url */
function applyQuery(url, query) {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
    else url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
}

/** @param {string} template @param {Record<string, unknown>} values @param {string[]} names */
function fillPath(template, values, names) {
  const missing = names.filter((name) => values?.[name] === undefined || values?.[name] === "");
  if (missing.length) throw new Error(`Missing path parameter(s): ${missing.join(", ")}`);
  return template.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(String(values[name])));
}

/** @param {Runtime} runtime @param {any} recipe @param {import("./http.js").OutgoingRequest} request @param {Record<string, any>} args */
async function execute(runtime, recipe, request, args) {
  const result = await runtime.send(recipe, request);
  return formatResponse(result, { pick: args.pick, maxChars: args.max_chars ?? runtime.maxOutputChars });
}

/** @param {any} recipe @param {Runtime} runtime @param {(s: string) => string} name @returns {GeneratedTool[]} */
function restTools(recipe, runtime, name) {
  return recipe.endpoints.map((endpoint) => {
    /** @type {Record<string, any>} */ const properties = { ...OUTPUT_PROPERTIES };
    const required = [];
    if (endpoint.pathParams.length) {
      properties.path = {
        type: "object",
        description: "Path parameters.",
        properties: Object.fromEntries(endpoint.pathParams.map((p) => [p, { type: "string" }])),
        required: endpoint.pathParams,
      };
      required.push("path");
    }
    const queryEntries = Object.entries(endpoint.query);
    properties.query = {
      type: "object",
      description: queryEntries.length ? "Query string parameters (all optional; observed values shown as examples)." : "Optional query string parameters.",
      properties: Object.fromEntries(queryEntries.map(([key, q]) => [key, { type: q.type, description: `Example: ${q.example} (seen ${q.seen}×)` }])),
      additionalProperties: true,
    };
    if (!["GET", "HEAD"].includes(endpoint.method)) {
      properties.body =
        endpoint.bodyKind === "text"
          ? { type: "string", description: `Request body. Example: ${endpoint.bodyExample ?? "none"}` }
          : { ...(endpoint.bodySchema ?? {}), description: `Request body (${endpoint.bodyKind === "form" ? "form-encoded" : "JSON"}). Example: ${endpoint.bodyExample ?? "none"}` };
    }
    const label = `${endpoint.method} ${endpoint.origin}${endpoint.pathTemplate}`;
    return {
      name: name(`${endpoint.method.toLowerCase()}_${endpoint.pathTemplate.replace(/[{}]/g, "")}`),
      description: clip(`[${recipe.name}] ${label} — observed ${endpoint.observed}×. Example: ${endpoint.exampleUrl}. Response: ${endpoint.responseShape}`),
      inputSchema: { type: "object", properties, required },
      annotations: annotationsFor(endpoint.method, label),
      run: async (args) => {
        const url = new URL(endpoint.origin + fillPath(endpoint.pathTemplate, args.path ?? {}, endpoint.pathParams));
        applyQuery(url, args.query);
        return execute(runtime, recipe, { method: endpoint.method, url: url.toString(), headers: endpoint.headers, body: args.body, bodyKind: endpoint.bodyKind === "none" ? "json" : endpoint.bodyKind }, args);
      },
    };
  });
}

/** @param {any} op @param {Record<string, any>} variables @param {string | undefined} queryOverride */
function graphqlRequest(op, variables, queryOverride) {
  const payload = {
    ...(op.operationName ? { operationName: op.operationName } : {}),
    ...(queryOverride ?? op.query ? { query: queryOverride ?? op.query } : {}),
    variables: variables ?? {},
    ...(op.extensions && !queryOverride ? { extensions: op.extensions } : {}),
  };
  if (op.method === "GET") {
    const url = new URL(op.url);
    for (const [key, value] of Object.entries(payload)) url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
    return { method: "GET", url: url.toString(), headers: op.headers };
  }
  return { method: "POST", url: op.url, headers: op.headers, body: payload, bodyKind: /** @type {const} */ ("json") };
}

/** @param {any} recipe @param {Runtime} runtime @param {(s: string) => string} name @returns {GeneratedTool[]} */
function graphqlTools(recipe, runtime, name) {
  const tools = recipe.graphql.map((op) => {
    const label = `GraphQL ${op.operationType} ${op.operationName ?? "(anonymous)"}`;
    return {
      name: name(`gql_${op.operationName ?? `${op.operationType}_${shortHash(op.query ?? JSON.stringify(op.extensions))}`}`),
      description: clip(
        `[${recipe.name}] ${label} at ${op.url} — observed ${op.observed}×. Variables example: ${op.variablesExample ?? "none"}. Response: ${op.responseShape}.` +
          (op.query ? ` Query: ${op.query.replace(/\s+/g, " ").slice(0, 400)}` : " Persisted query (the server knows it by hash)."),
      ),
      inputSchema: {
        type: "object",
        properties: {
          variables: { ...asObjectSchema(op.variablesSchema), description: "GraphQL variables." },
          query: { type: "string", description: "Optional: replace the captured GraphQL document (sent without the persisted-query hash)." },
          ...OUTPUT_PROPERTIES,
        },
      },
      // Persisted queries have an unknown type: only a known "query" is read-only.
      annotations: { ...annotationsFor(op.operationType === "query" ? "GET" : "POST", label) },
      run: async (args) => execute(runtime, recipe, graphqlRequest(op, args.variables, args.query), args),
    };
  });
  if (recipe.graphql.length) {
    const endpoints = [...new Set(recipe.graphql.map((op) => op.url))];
    tools.push({
      name: name("graphql"),
      description: clip(`[${recipe.name}] Run any GraphQL document against ${endpoints.join(", ")}.`),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "GraphQL document." },
          variables: { type: "object", additionalProperties: true },
          operationName: { type: "string" },
          endpoint: { type: "string", enum: endpoints, description: `Defaults to ${endpoints[0]}.` },
          ...OUTPUT_PROPERTIES,
        },
        required: ["query"],
      },
      annotations: annotationsFor("POST", `${recipe.name} GraphQL`),
      run: async (args) => {
        const op = recipe.graphql.find((o) => o.url === (args.endpoint ?? endpoints[0])) ?? recipe.graphql[0];
        return execute(runtime, recipe, graphqlRequest({ ...op, method: "POST", operationName: args.operationName ?? null, extensions: null }, args.variables, args.query), args);
      },
    });
  }
  return tools;
}

/** @param {any} recipe @param {Runtime} runtime @param {(s: string) => string} name @returns {GeneratedTool[]} */
function openApiTools(recipe, runtime, name) {
  const tools = recipe.operations.map((op) => {
    /** @type {Record<string, any>} */ const properties = { ...OUTPUT_PROPERTIES };
    const required = [];
    for (const location of ["path", "query", "header"]) {
      const params = op.params.filter((p) => p.in === location);
      if (!params.length) continue;
      const requiredNames = params.filter((p) => p.required).map((p) => p.name);
      properties[location] = {
        type: "object",
        description: `${location[0].toUpperCase()}${location.slice(1)} parameters.`,
        properties: Object.fromEntries(params.map((p) => [p.name, { ...p.schema, ...(p.description ? { description: p.description } : {}) }])),
        ...(requiredNames.length ? { required: requiredNames } : {}),
      };
      if (requiredNames.length) required.push(location);
    }
    if (op.body) {
      properties.body = { ...(op.body.schema ?? {}), description: `Request body (${op.body.contentType}).` };
      if (op.body.required) required.push("body");
    }
    const label = `${op.method} ${op.path}`;
    return {
      name: name(op.id),
      description: clip(`[${recipe.name}] ${label}${op.summary ? ` — ${op.summary}` : ""}`),
      inputSchema: { type: "object", properties, required },
      annotations: annotationsFor(op.method, label),
      run: async (args) => {
        const pathNames = op.params.filter((p) => p.in === "path").map((p) => p.name);
        const url = new URL(recipe.baseUrl.replace(/\/$/, "") + fillPath(op.path, args.path ?? {}, pathNames));
        applyQuery(url, args.query);
        const headers = Object.fromEntries(Object.entries(args.header ?? {}).map(([k, v]) => [k, String(v)]));
        const bodyKind = !op.body ? "none" : /form-urlencoded/i.test(op.body.contentType) ? "form" : /json/i.test(op.body.contentType) ? "json" : "text";
        return execute(runtime, recipe, { method: op.method, url: url.toString(), headers, body: args.body, bodyKind }, args);
      },
    };
  });
  tools.push({
    name: name("routes"),
    description: clip(`[${recipe.name}] List all ${recipe.routes.length} routes of ${recipe.title ?? "the API"} (optional text filter), including those without a dedicated tool.`),
    inputSchema: { type: "object", properties: { filter: { type: "string" } } },
    annotations: { title: `${recipe.name} routes`, readOnlyHint: true, openWorldHint: false },
    run: async ({ filter = "" }) => {
      const needle = String(filter).toLowerCase();
      const lines = recipe.routes.filter((r) => `${r.method} ${r.path} ${r.id} ${r.summary}`.toLowerCase().includes(needle)).map((r) => `${r.method} ${r.path} — ${r.summary || r.id}`);
      return { text: lines.length ? lines.join("\n") : "No route matches.", isError: false };
    },
  });
  return tools;
}

/**
 * @param {any} recipe
 * @param {Runtime} runtime
 * @returns {GeneratedTool[]}
 */
export function buildTools(recipe, runtime) {
  const name = toolNamer(recipe.name);
  const tools = recipe.kind === "openapi" ? openApiTools(recipe, runtime, name) : [...graphqlTools(recipe, runtime, name), ...restTools(recipe, runtime, name)];
  tools.push(...buildRpcTools(recipe, runtime, name, (result, args) => formatResponse(result, { pick: args.pick, maxChars: args.max_chars ?? runtime.maxOutputChars })));
  tools.push(...buildStreamTools(recipe, runtime, name));
  tools.push({
    name: name("request"),
    description: clip(
      `[${recipe.name}] Free-form HTTP request (absolute URL, or path relative to ${recipe.baseUrl}). Uses the recipe's stored credentials` +
        (recipe.kind === "browser" ? " and browser cookies." : "."),
    ),
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
        url: { type: "string" },
        query: { type: "object", additionalProperties: true },
        body: { description: "Request body (object for JSON/form, string for text)." },
        body_kind: { type: "string", enum: ["json", "form", "text"], description: "Defaults to json." },
        headers: { type: "object", additionalProperties: { type: "string" } },
        ...OUTPUT_PROPERTIES,
      },
      required: ["method", "url"],
    },
    annotations: { title: `${recipe.name} request`, readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: async (args) => {
      const url = new URL(args.url, `${recipe.baseUrl.replace(/\/$/, "")}/`);
      applyQuery(url, args.query);
      return execute(runtime, recipe, { method: String(args.method).toUpperCase(), url: url.toString(), headers: args.headers, body: args.body, bodyKind: args.body_kind ?? "json" }, args);
    },
  });
  /** @param {string} url */
  const fetchUrl = async (url) => {
    const result = await runtime.send(recipe, { method: "GET", url: new URL(url, `${recipe.baseUrl.replace(/\/$/, "")}/`).toString() });
    let json;
    try {
      json = JSON.parse(result.body.toString("utf8"));
    } catch {}
    return { status: result.status, json };
  };
  // Read-only tools with a query string can merge several pages.
  const paginated = tools.map((tool) => (tool.annotations.readOnlyHint && tool.inputSchema.properties?.query && !tool.name.startsWith(`${recipe.name}__stream`) ? withPagination(tool, fetchUrl) : tool));
  // Read-only HTTP tools can reuse recent identical results.
  const cached = paginated.map((tool) => (tool.annotations.readOnlyHint && tool.annotations.openWorldHint && !tool.name.startsWith(`${recipe.name}__stream`) ? withCache(tool, { defaultSeconds: runtime.cacheSeconds }) : tool));
  return cached.map((tool) => ({ ...tool, inputSchema: safeSchema(tool.inputSchema) }));
}
