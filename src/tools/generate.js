// Builds MCP tool definitions from a recipe: one tool per endpoint / GraphQL operation / OpenAPI operation,
// macros chaining several calls, and a free-form request tool. Agent-written annotations (names, descriptions) are applied last.
import { createHash } from "node:crypto";
import { buildDataTools } from "../data/tools.js";
import { buildRpcTools } from "../discovery/jsonrpc.js";
import { buildSoapTools } from "../discovery/soap.js";
import { buildStreamTools } from "../realtime/tools.js";
import { formatResponse } from "./http.js";
import { pick } from "./pick.js";
import { compactTool } from "./compact.js";
import { foldTools } from "./lazy.js";
import { withPagination } from "./paginate.js";

const TOOL_NAME_MAX = 64;
const DESCRIPTION_MAX = 1200;

/**
 * @typedef {object} ToolResult
 * @property {string} text
 * @property {boolean} isError
 * @property {number} [status] HTTP status
 * @property {unknown} [json] parsed JSON body before pick (pagination)
 * @property {string} [image] base64 image returned to the agent as an image
 * @property {string} [imageType] its media type
 * @property {unknown} [data] parsed JSON body, for macros
 * @property {any} [request] request that a dry run would send (credentials included: internal use only, never shown)
 */

/**
 * @typedef {object} GeneratedTool
 * @property {string} name
 * @property {string} description
 * @property {Record<string, any>} inputSchema
 * @property {Record<string, any>} annotations
 * @property {(args: Record<string, any>) => Promise<ToolResult>} run
 * @property {{ args: Record<string, any>, keys: string[], graphql?: boolean }} [probe] safe example call for health checks (read-only tools)
 * @property {boolean} [lazy] one tool per operation: folded into __operation / __call in compact mode
 */

/**
 * @typedef {object} Runtime
 * @property {(recipe: any, request: import("./http.js").OutgoingRequest, options?: { dryRun?: boolean, confirmed?: boolean, tool?: string, cacheSeconds?: number }) => Promise<import("./http.js").HttpResult | { preview: string, blocked?: boolean, request?: any }>} send
 * @property {number} maxOutputChars
 * @property {(recipe: any, host: string, key: string) => string | undefined} [secret] stored secret value (secret path parameters)
 * @property {(name: string) => GeneratedTool | undefined} [findTool] any generated tool, for macros
 * @property {number} [schemaBudget] maximum characters of a tool's description + input schema
 * @property {number} [foldThreshold] above this many operations, a recipe switches to compact mode (0 = never)
 * @property {import("../realtime/tools.js").StreamRuntime["streamAuth"]} [streamAuth]
 * @property {(recipe: any) => Promise<string>} [dataPath] local path of a data recipe's data (remote data is cached)
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

export const OUTPUT_PROPERTIES = {
  pick: {
    type: "string",
    description:
      'Optional: keep only part of a JSON response, e.g. "items[*].name", "data.user,meta.total", "items[0:5]", "items[?price>10].name", ' +
      '"items[?status=open][?name~lamp]" (~ = contains), "items.#" (count), or JSONPath ("$..price", "$.items[?(@.price > 10)]").',
  },
  max_chars: { type: "integer", minimum: 20, description: "Optional: maximum characters returned (default from server configuration)." },
  save_to: { type: "string", description: "Optional: absolute file path where the response body is written (downloads, binary files)." },
  raw: { type: "boolean", description: "Optional: return HTML as-is instead of readable text." },
  dry_run: { type: "boolean", description: "Optional: show the request that would be sent (credentials hidden) without sending it." },
  confirm: { type: "boolean", description: "Set to true to confirm a call that the safety policy holds for confirmation." },
  cache_seconds: { type: "integer", minimum: 0, maximum: 86400, description: "Optional, reads only: reuse a response fetched less than this many seconds ago." },
  timeout_ms: { type: "integer", minimum: 1000, maximum: 300000, description: "Optional: timeout of this call in milliseconds." },
};

const FILES_PROPERTY = { type: "object", additionalProperties: { type: "string" }, description: "Files to upload: form field name -> absolute file path." };

/** @param {string} method @param {string} title @param {boolean} [readOnly] */
const annotationsFor = (method, title, readOnly) => ({
  title,
  readOnlyHint: readOnly ?? (method === "GET" || method === "HEAD"),
  // PUT and PATCH overwrite existing data; POST is treated as additive.
  destructiveHint: ["DELETE", "PUT", "PATCH"].includes(method),
  idempotentHint: ["GET", "HEAD", "PUT", "DELETE"].includes(method),
  openWorldHint: true,
});

/** @param {Record<string, any> | null | undefined} schema */
function asObjectSchema(schema) {
  if (schema && schema.type === "object") return { ...schema, additionalProperties: schema.additionalProperties ?? true };
  return { type: "object", additionalProperties: true };
}

/** @param {Record<string, unknown> | undefined} query @param {URL} url */
// Technical query parameters (application id, client, agent, version, locale, format) seen with one constant value
// are part of how the site calls its API, not of the question asked: they are sent by default.
const CONSTANT_PARAM = /(^|[-_.])(app|application|client|agent|sdk|version|platform|locale|lang|language|format)([-_.]?(id|name|version))?$/i;

/**
 * @param {Record<string, { example: string, seen: number, values?: string[] }>} query observed query parameters
 * @param {number} observed number of observed calls
 * @returns {Record<string, string>}
 */
export function constantQueryDefaults(query, observed) {
  return Object.fromEntries(
    Object.entries(query)
      .filter(([key, q]) => CONSTANT_PARAM.test(key) && q.seen === observed && (q.values?.length ?? 1) <= 1 && q.example !== "REDACTED" && !q.example.endsWith("…"))
      .map(([key, q]) => [key, q.example]),
  );
}

function applyQuery(url, query) {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
    else url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
}

/** @param {string} template @param {Record<string, unknown>} values @param {string[]} names */
function fillPath(template, values, names) {
  // Every placeholder counts, including ones an OpenAPI description forgot to declare (never send "/pets/undefined").
  const placeholders = [...new Set([...names, ...[...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])])];
  const missing = placeholders.filter((name) => values?.[name] === undefined || values?.[name] === "");
  if (missing.length) throw new Error(`Missing path parameter(s): ${missing.join(", ")}`);
  return template.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(String(values[name])));
}

/** @param {import("./http.js").HttpResult} result */
function parseJson(result) {
  if (!/json/i.test(result.contentType) && !/^\s*[[{]/.test(result.body.subarray(0, 64).toString("utf8"))) return undefined;
  try {
    return JSON.parse(result.body.toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * @param {Runtime} runtime @param {any} recipe @param {import("./http.js").OutgoingRequest} request @param {Record<string, any>} args @param {string} tool
 * @param {(result: any) => any} [transform] adapts the raw response before formatting (SOAP envelopes)
 * @returns {Promise<ToolResult>}
 */
async function execute(runtime, recipe, request, args, tool, transform) {
  const cacheSeconds = Number.isFinite(args.cache_seconds) ? Math.max(0, Math.min(Number(args.cache_seconds), 86_400)) : undefined;
  if (Number.isFinite(args.timeout_ms)) request = { ...request, timeoutMs: Math.max(1000, Math.min(Number(args.timeout_ms), 300_000)) };
  const result = await runtime.send(recipe, request, { dryRun: args.dry_run === true, confirmed: args.confirm === true, tool, cacheSeconds });
  if ("preview" in result) return { text: result.preview, isError: !!result.blocked, request: result.request };
  const formatted = formatResponse(transform ? transform(result) : result, { pick: args.pick, maxChars: args.max_chars ?? runtime.maxOutputChars, saveTo: args.save_to, raw: args.raw === true });
  return { ...formatted, data: parseJson(result) };
}

// ---------------------------------------------------------------- semantic descriptions

/** @param {string} word */
function singular(word) {
  if (/ies$/i.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/i.test(word)) return word;
  if (/s$/i.test(word)) return word.slice(0, -1);
  return word;
}

/** Plain-language summary of a REST endpoint, e.g. "Get one product by product" or "List reviews of a product". @param {any} endpoint */
export function summarizeEndpoint(endpoint) {
  const parts = endpoint.pathTemplate.split("/").filter(Boolean).filter((p) => !/^(api|v\d+(\.\d+)?|rest|graphql)$/i.test(p));
  const last = parts.at(-1) ?? "resource";
  const isItem = /^\{.+\}$/.test(last);
  const literals = parts.filter((p) => !/^\{.+\}$/.test(p));
  const resource = (literals.at(-1) ?? "resource").replace(/[-_]/g, " ");
  const parentItem = !isItem && parts.length >= 3 && /^\{.+\}$/.test(parts.at(-2) ?? "") ? singular(literals.at(-2) ?? "").replace(/[-_]/g, " ") : null;
  const by = isItem ? ` by ${last.slice(1, -1)}` : "";
  const of = parentItem ? ` of a ${parentItem}` : "";
  const noun = isItem ? singular(resource) : resource;
  switch (endpoint.method) {
    case "GET":
      return isItem ? `Get one ${noun}${by}` : `${Object.keys(endpoint.query ?? {}).some((q) => /^(q|query|search|term|keyword)s?$/i.test(q)) ? "Search" : "List or get"} ${/^search(es)?$/i.test(noun) ? "" : noun}${of}`.replace(/\s+$/, "");
    case "POST":
      return isItem ? `Act on a ${noun}${by}` : `Create or submit ${singular(noun)}${of}`;
    case "PUT":
    case "PATCH":
      return `Update ${isItem ? "a " : ""}${noun}${by}${of}`;
    case "DELETE":
      return `Delete ${isItem ? "a " : ""}${noun}${by}${of}`;
    default:
      return `${endpoint.method} ${noun}`;
  }
}

/** @param {{ type: string, example: string, seen: number, values?: string[] }} q */
function queryDescription(q) {
  const observed = (q.values ?? []).filter((v) => v !== "REDACTED");
  if (observed.length > 1 && observed.length <= 6) return `Observed values: ${observed.join(", ")} (seen ${q.seen}×)`;
  return `Example: ${q.example} (seen ${q.seen}×)`;
}

// ---------------------------------------------------------------- REST, GraphQL, OpenAPI

/** @param {any} recipe @param {Runtime} runtime @param {(s: string) => string} name @returns {GeneratedTool[]} */
function restTools(recipe, runtime, name) {
  return recipe.endpoints.map((endpoint) => {
    /** @type {Record<string, any>} */ const properties = { ...OUTPUT_PROPERTIES };
    const required = [];
    const secretParams = endpoint.secretPathParams ?? [];
    if (endpoint.pathParams.length) {
      const requiredParams = endpoint.pathParams.filter((p) => !secretParams.includes(p));
      properties.path = {
        type: "object",
        description: secretParams.length ? `Path parameters. ${secretParams.join(", ")}: secret value captured during discovery, used when omitted.` : "Path parameters.",
        properties: Object.fromEntries(
          endpoint.pathParams.map((p) => [p, { type: "string", ...(endpoint.pathExamples?.[p] ? { description: `Example: ${endpoint.pathExamples[p]}` } : {}) }]),
        ),
        ...(requiredParams.length ? { required: requiredParams } : {}),
      };
      if (requiredParams.length) required.push("path");
    }
    const queryEntries = Object.entries(endpoint.query);
    const queryDefaults = constantQueryDefaults(endpoint.query, endpoint.observed);
    properties.query = {
      type: "object",
      description: queryEntries.length ? "Query string parameters (all optional; observed values shown as examples)." : "Optional query string parameters.",
      properties: Object.fromEntries(
        queryEntries.map(([key, q]) => [key, { type: q.type, description: key in queryDefaults ? `Sent by default: ${queryDefaults[key]} (null to omit).` : queryDescription(q) }]),
      ),
      additionalProperties: true,
    };
    if (!["GET", "HEAD"].includes(endpoint.method)) {
      properties.body =
        endpoint.bodyKind === "text"
          ? { type: "string", description: `Request body. Example: ${endpoint.bodyExample ?? "none"}` }
          : {
              ...(endpoint.bodySchema ?? {}),
              description: `Request body (${endpoint.bodyKind === "form" ? "form-encoded" : endpoint.bodyKind === "multipart" ? "multipart form fields" : "JSON"}). Example: ${endpoint.bodyExample ?? "none"}`,
            };
      if (endpoint.bodyKind === "multipart") properties.files = { ...FILES_PROPERTY, ...(endpoint.fileFields?.length ? { description: `${FILES_PROPERTY.description} Observed file fields: ${endpoint.fileFields.join(", ")}.` } : {}) };
    }
    const label = `${endpoint.method} ${endpoint.origin}${endpoint.pathTemplate}`;
    const toolName = name(`${endpoint.method.toLowerCase()}_${endpoint.pathTemplate.replace(/[{}]/g, "")}`);
    const probeable = endpoint.method === "GET" && endpoint.pathParams.every((p) => secretParams.includes(p) || endpoint.pathExamples?.[p] !== undefined);
    return {
      lazy: true,
      name: toolName,
      ...(probeable ? { probe: { args: endpoint.pathParams.length ? { path: { ...endpoint.pathExamples } } : {}, keys: endpoint.responseKeys ?? [] } } : {}),
      description: clip(`${summarizeEndpoint(endpoint)}. [${recipe.name}] ${label} — observed ${endpoint.observed}×. Example: ${endpoint.exampleUrl}. Response: ${endpoint.responseShape}`),
      inputSchema: { type: "object", properties, required },
      annotations: annotationsFor(endpoint.method, label),
      run: async (args) => {
        const host = new URL(endpoint.origin).host;
        const stored = Object.fromEntries(secretParams.map((p) => [p, runtime.secret?.(recipe, host, `{${endpoint.method} ${endpoint.pathTemplate}}${p}`)]));
        const values = { ...Object.fromEntries(Object.entries(stored).filter(([, v]) => v !== undefined)), ...(args.path ?? {}) };
        const url = new URL(endpoint.origin + fillPath(endpoint.pathTemplate, values, endpoint.pathParams));
        applyQuery(url, { ...queryDefaults, ...(args.query ?? {}) });
        const bodyKind = endpoint.bodyKind === "none" ? "json" : endpoint.bodyKind;
        return execute(runtime, recipe, { method: endpoint.method, url: url.toString(), headers: endpoint.headers, body: args.body, bodyKind, files: args.files }, args, toolName);
      },
    };
  });
}

/** @param {any} op @param {Record<string, any>} variables @param {string | undefined} queryOverride @returns {import("./http.js").OutgoingRequest} */
function graphqlRequest(op, variables, queryOverride) {
  const payload = {
    ...(op.operationName ? { operationName: op.operationName } : {}),
    ...(queryOverride ?? op.query ? { query: queryOverride ?? op.query } : {}),
    variables: variables ?? {},
    ...(op.extensions && !queryOverride ? { extensions: op.extensions } : {}),
  };
  const document = queryOverride ?? op.query ?? "";
  const intent = op.operationType === "query" || /^\s*(query\b|\{)/.test(document) ? "read" : "write";
  if (op.method === "GET") {
    const url = new URL(op.url);
    for (const [key, value] of Object.entries(payload)) url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
    return { method: "GET", url: url.toString(), headers: op.headers, intent };
  }
  return { method: "POST", url: op.url, headers: op.headers, body: payload, bodyKind: "json", intent };
}

/** @param {any} recipe @param {Runtime} runtime @param {(s: string) => string} name @returns {GeneratedTool[]} */
function graphqlTools(recipe, runtime, name) {
  const tools = recipe.graphql.map((op) => {
    const label = `GraphQL ${op.operationType} ${op.operationName ?? "(anonymous)"}`;
    const toolName = name(`gql_${op.operationName ?? `${op.operationType}_${shortHash(op.query ?? JSON.stringify(op.extensions))}`}`);
    const verb = op.operationType === "mutation" ? "Change data with" : op.operationType === "query" ? "Read data with" : "Run";
    let probeVariables;
    try {
      probeVariables = op.operationType === "query" && !String(op.variablesExample ?? "").includes("REDACTED") ? JSON.parse(op.variablesExample ?? "{}") : undefined;
    } catch {}
    return {
      lazy: true,
      name: toolName,
      ...(probeVariables !== undefined ? { probe: { args: { variables: probeVariables }, keys: op.responseKeys ?? [], graphql: true } } : {}),
      description: clip(
        `${verb} the ${op.operationName ?? "anonymous"} GraphQL ${op.operationType}. [${recipe.name}] ${label} at ${op.url} — observed ${op.observed}×. Variables example: ${op.variablesExample ?? "none"}. Response: ${op.responseShape}.` +
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
      // Persisted queries have an unknown type: only a known "query" is read-only; mutations and unknown operations may change data.
      annotations: { ...annotationsFor(op.operationType === "query" ? "GET" : "POST", label), destructiveHint: op.operationType !== "query" },
      run: async (args) => execute(runtime, recipe, graphqlRequest(op, args.variables, args.query), args, toolName),
    };
  });
  if (recipe.graphql.length) {
    const endpoints = [...new Set(recipe.graphql.map((op) => op.url))];
    const toolName = name("graphql");
    tools.push({
      name: toolName,
      description: clip(`Run any GraphQL document. [${recipe.name}] Endpoint(s): ${endpoints.join(", ")}.`),
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
        const request = graphqlRequest({ ...op, method: "POST", operationName: args.operationName ?? null, extensions: null, operationType: "unknown" }, args.variables, args.query);
        return execute(runtime, recipe, request, args, toolName);
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
    const multipart = op.body && /multipart\/form-data/i.test(op.body.contentType);
    if (op.body) {
      properties.body = { ...(op.body.schema ?? {}), description: `Request body (${op.body.contentType}).` };
      if (op.body.required && !multipart) required.push("body");
      if (multipart) properties.files = FILES_PROPERTY;
    }
    const label = `${op.method} ${op.path}`;
    const toolName = name(op.id);
    const probeable = op.method === "GET" && !op.params.some((p) => p.required);
    return {
      lazy: true,
      name: toolName,
      ...(probeable ? { probe: { args: {}, keys: [] } } : {}),
      description: clip(`${op.summary ? `${op.summary}. ` : ""}[${recipe.name}] ${label}`),
      inputSchema: { type: "object", properties, required },
      annotations: annotationsFor(op.method, label),
      run: async (args) => {
        const pathNames = op.params.filter((p) => p.in === "path").map((p) => p.name);
        const url = new URL(recipe.baseUrl.replace(/\/$/, "") + fillPath(op.path, args.path ?? {}, pathNames));
        applyQuery(url, args.query);
        const headers = Object.fromEntries(Object.entries(args.header ?? {}).map(([k, v]) => [k, String(v)]));
        const bodyKind = !op.body
          ? "none"
          : multipart
            ? "multipart"
            : /form-urlencoded/i.test(op.body.contentType)
              ? "form"
              : /json/i.test(op.body.contentType)
                ? "json"
                : /octet-stream/i.test(op.body.contentType)
                  ? "base64"
                  : "text";
        return execute(runtime, recipe, { method: op.method, url: url.toString(), headers, body: args.body, bodyKind, files: args.files }, args, toolName);
      },
    };
  });
  tools.push({
    name: name("routes"),
    description: clip(`List all ${recipe.routes.length} routes of ${recipe.title ?? "the API"} (optional text filter), including those without a dedicated tool. [${recipe.name}]`),
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

// ---------------------------------------------------------------- macros

/**
 * Resolves "{{params.x}}" and "{{steps.<as or index>.<pick path>}}" placeholders. A string that is exactly one
 * placeholder keeps the value's type; placeholders inside longer strings are stringified.
 * @param {unknown} template @param {{ params: Record<string, unknown>, steps: Record<string, unknown> }} scope @returns {unknown}
 */
export function renderTemplate(template, scope) {
  if (typeof template === "string") {
    const lookup = (expression) => {
      const [root, ...rest] = expression.trim().split(".");
      const base = root === "params" ? scope.params : root === "steps" ? scope.steps : undefined;
      if (base === undefined) throw new Error(`Unknown placeholder root "${root}" (use params or steps)`);
      return rest.length ? pick(base, rest.join(".")) : base;
    };
    const whole = /^\{\{([^{}]+)\}\}$/.exec(template);
    if (whole) return lookup(whole[1]);
    return template.replace(/\{\{([^{}]+)\}\}/g, (_, expression) => {
      const value = lookup(expression);
      return value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
    });
  }
  if (Array.isArray(template)) return template.map((item) => renderTemplate(item, scope));
  if (template && typeof template === "object") return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, renderTemplate(value, scope)]));
  return template;
}

/** @param {any} recipe @param {Runtime} runtime @param {(s: string) => string} name @param {GeneratedTool[]} siblings @returns {GeneratedTool[]} */
function macroTools(recipe, runtime, name, siblings, unannotated = []) {
  return (recipe.macros ?? []).map((macro) => {
    const match = (t, toolName) => t.name === toolName || t.name === `${recipe.name}__${toolName}`;
    // Hidden tools (annotate_recipe hidden=true) are not listed but remain usable as macro steps.
    const find = (toolName) =>
      siblings.find((t) => match(t, toolName)) ?? runtime.findTool?.(toolName) ?? runtime.findTool?.(`${recipe.name}__${toolName}`) ?? unannotated.find((t) => match(t, toolName));
    const readOnly = macro.steps.every((step) => find(step.tool)?.annotations?.readOnlyHint === true);
    const params = macro.params ?? {};
    return {
      name: name(`m_${macro.id}`),
      description: clip(`${macro.description} [${recipe.name} macro: ${macro.steps.map((s) => s.tool).join(" → ")}]`),
      inputSchema: {
        type: "object",
        properties: {
          ...Object.fromEntries(Object.entries(params).map(([key, spec]) => [key, { type: spec.type ?? "string", ...(spec.description ? { description: spec.description } : {}) }])),
          dry_run: OUTPUT_PROPERTIES.dry_run, confirm: OUTPUT_PROPERTIES.confirm, max_chars: OUTPUT_PROPERTIES.max_chars,
        },
        required: Object.entries(params).filter(([, spec]) => spec.required).map(([key]) => key),
      },
      annotations: { title: `${recipe.name} macro ${macro.id}`, readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true },
      run: async (args) => {
        const scope = { params: args, steps: /** @type {Record<string, unknown>} */ ({}) };
        const log = [];
        /** @type {ToolResult} */ let last = { text: "", isError: false };
        for (const [index, step] of macro.steps.entries()) {
          const tool = find(step.tool);
          if (!tool) return { text: `Macro step ${index + 1}: unknown tool "${step.tool}"`, isError: true };
          let stepArgs;
          try {
            stepArgs = storableArguments(/** @type {Record<string, any>} */ (renderTemplate(step.args ?? {}, scope)));
          } catch (error) {
            return { text: `Macro step ${index + 1} (${step.tool}): ${error.message}`, isError: true };
          }
          if (args.dry_run) stepArgs.dry_run = true;
          if (args.confirm) stepArgs.confirm = true;
          try {
            last = await tool.run(stepArgs);
          } catch (error) {
            return { text: `Macro stopped at step ${index + 1} (${tool.name}): ${error.message}\n${log.join("\n")}`, isError: true };
          }
          log.push(`${index + 1}. ${tool.name}: ${last.text.split("\n")[0]}`);
          if (last.isError) return { text: `Macro stopped at step ${index + 1} (${tool.name}).\n${log.join("\n")}\n\n${last.text}`, isError: true };
          if (/needs confirmation/.test(last.text) && !args.confirm) return { text: `Macro paused at step ${index + 1}: ${last.text}\n\nCall the macro again with confirm=true.`, isError: false };
          scope.steps[String(index)] = last.data;
          if (step.as) scope.steps[step.as] = last.data;
        }
        const output = macro.result ? renderTemplate(macro.result, scope) : undefined;
        const body = output !== undefined ? JSON.stringify(output, null, 1) : last.text;
        const maxChars = args.max_chars ?? runtime.maxOutputChars;
        return { text: `${log.join("\n")}\n\n${body.length > maxChars ? `${body.slice(0, maxChars)}\n… [truncated]` : body}`, isError: false, data: output ?? last.data };
      },
    };
  });
}

/** Validates a macro definition before it is stored. @param {any} macro */
export function validateMacro(macro) {
  if (!macro || typeof macro !== "object") throw new Error("macro must be an object");
  if (typeof macro.id !== "string" || !/^[a-z][a-z0-9_]{0,40}$/.test(macro.id)) throw new Error('macro.id must match ^[a-z][a-z0-9_]{0,40}$ (e.g. "latest_order")');
  if (typeof macro.description !== "string" || !macro.description.trim()) throw new Error("macro.description is required");
  if (!Array.isArray(macro.steps) || !macro.steps.length || macro.steps.length > 20) throw new Error("macro.steps must be a list of 1 to 20 steps");
  for (const [index, step] of macro.steps.entries()) {
    if (!step || typeof step.tool !== "string") throw new Error(`steps[${index}].tool must be a tool name`);
    if (step.args !== undefined && (typeof step.args !== "object" || Array.isArray(step.args))) throw new Error(`steps[${index}].args must be an object`);
    if (step.as !== undefined && !/^[a-z][a-z0-9_]*$/i.test(step.as)) throw new Error(`steps[${index}].as must be an identifier`);
    const refused = Object.keys(step.args ?? {}).filter((key) => !STORABLE_ARGUMENTS.has(key));
    if (refused.length) throw new Error(`steps[${index}].args cannot contain ${refused.join(", ")} (allowed: ${[...STORABLE_ARGUMENTS].join(", ")}); confirm is passed by calling the macro with confirm=true`);
  }
  for (const [key, spec] of Object.entries(macro.params ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key) || ["dry_run", "confirm", "max_chars"].includes(key)) throw new Error(`invalid macro parameter name "${key}"`);
    if (spec && spec.type && !["string", "number", "integer", "boolean", "object", "array"].includes(spec.type)) throw new Error(`params.${key}.type is not a JSON Schema type`);
  }
  return {
    id: macro.id, description: macro.description.trim().slice(0, 600), params: macro.params ?? {},
    steps: macro.steps.map((s) => ({ tool: s.tool, ...(s.args ? { args: s.args } : {}), ...(s.as ? { as: s.as } : {}) })),
    ...(macro.result !== undefined ? { result: macro.result } : {}),
  };
}

// ---------------------------------------------------------------- annotations (agent-written semantics)

// Arguments a recipe may store (defaults, macro steps). Recipes are shared: they must never be able to confirm a held call,
// write local files (save_to), upload local files (files) or redirect a free-form request on the user's behalf.
const STORABLE_ARGUMENTS = new Set(["path", "query", "body", "variables", "header", "pick", "max_chars", "raw", "cache_seconds", "timeout_ms", "operationName", "filter"]);

/** Keeps only the arguments a recipe is allowed to store. @param {Record<string, any>} args */
export function storableArguments(args) {
  return Object.fromEntries(Object.entries(args ?? {}).filter(([key]) => STORABLE_ARGUMENTS.has(key)));
}

/** @param {Record<string, any>} defaults @param {Record<string, any>} args */
export function mergeDefaults(defaults, args) {
  const out = { ...storableArguments(defaults) };
  for (const [key, value] of Object.entries(args ?? {})) {
    const base = out[key];
    out[key] =
      base && value && typeof base === "object" && typeof value === "object" && !Array.isArray(base) && !Array.isArray(value) ? { ...base, ...value } : value;
  }
  return out;
}

/**
 * Applies agent-written annotations: { [generated tool name]: { name?, description?, title?, hidden?, params?: { "query.q": "..." }, defaults?: {...} } }.
 * @param {GeneratedTool[]} tools @param {any} recipe @returns {GeneratedTool[]}
 */
function applyAnnotations(tools, recipe) {
  const notes = recipe.annotations ?? {};
  const used = new Set(tools.map((t) => t.name));
  return tools.flatMap((tool) => {
    const note = notes[tool.name];
    if (!note) return [tool];
    if (note.hidden) return [];
    let name = tool.name;
    if (note.name) {
      const candidate = `${recipe.name}__${sanitize(note.name)}`.slice(0, TOOL_NAME_MAX);
      if (!used.has(candidate)) {
        used.delete(tool.name);
        used.add(candidate);
        name = candidate;
      }
    }
    const inputSchema = structuredClone(tool.inputSchema);
    for (const [path, text] of Object.entries(note.params ?? {})) {
      const [group, key] = path.includes(".") ? path.split(".") : [null, path];
      const target = group ? inputSchema.properties?.[group]?.properties?.[key] : inputSchema.properties?.[key];
      if (target) target.description = String(text).slice(0, 300) + (target.description ? ` (${target.description})` : "");
    }
    const defaults = note.defaults && typeof note.defaults === "object" ? note.defaults : null;
    return [{
      ...tool, name, inputSchema,
      // Saved default arguments: explicit arguments win; objects (path, query, body, variables...) are merged one level deep.
      ...(defaults ? { run: (args) => tool.run(mergeDefaults(defaults, args)) } : {}),
      description: clip(note.description ? `${note.description} — ${tool.description}` : tool.description),
      annotations: { ...tool.annotations, ...(note.title ? { title: note.title } : {}) },
    }];
  });
}

/**
 * @param {any} recipe
 * @param {Runtime} runtime
 * @returns {GeneratedTool[]}
 */
export function buildTools(recipe, runtime) {
  const name = toolNamer(recipe.name);
  // Local data recipes only have their SQL tools.
  if (recipe.kind === "data") return buildDataTools(recipe, name, runtime.maxOutputChars, runtime.dataPath).map((tool) => ({ ...tool, inputSchema: safeSchema(tool.inputSchema) }));
  /** Sends through the recipe's pipeline (credentials, safety policy, formatting); `transform` adapts the raw response first. */
  const exec = (request, args, toolName, transform) => execute(runtime, recipe, request, args, toolName, transform);
  /** @type {GeneratedTool[]} */
  const tools =
    recipe.kind === "openapi" ? openApiTools(recipe, runtime, name)
    : recipe.kind === "soap" ? buildSoapTools(recipe, name, exec, OUTPUT_PROPERTIES)
    : [...graphqlTools(recipe, runtime, name), ...restTools(recipe, runtime, name)];
  tools.push(...buildRpcTools(recipe, name, exec, OUTPUT_PROPERTIES));
  tools.push(...buildStreamTools(recipe, runtime, name));
  {
    const requestName = name("request");
    tools.push({
      name: requestName,
      description: clip(
        `Free-form HTTP request (absolute URL, or path relative to ${recipe.baseUrl}). [${recipe.name}] Uses the recipe's stored credentials` +
          (recipe.kind === "browser" ? " and browser cookies." : "."),
      ),
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
          url: { type: "string" },
          query: { type: "object", additionalProperties: true },
          body: { description: "Request body (object for JSON/form/multipart fields, string for text, base64 string for base64)." },
          body_kind: { type: "string", enum: ["json", "form", "text", "multipart", "base64"], description: "Defaults to json." },
          files: FILES_PROPERTY,
          headers: { type: "object", additionalProperties: { type: "string" } },
          ...OUTPUT_PROPERTIES,
        },
        required: ["method", "url"],
      },
      annotations: { title: `${recipe.name} request`, readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      run: async (args) => {
        const url = new URL(args.url, `${recipe.baseUrl.replace(/\/$/, "")}/`);
        applyQuery(url, args.query);
        return execute(
          runtime, recipe,
          { method: String(args.method).toUpperCase(), url: url.toString(), headers: args.headers, body: args.body, bodyKind: args.body_kind ?? "json", files: args.files },
          args, requestName,
        );
      },
    });
  }
  // Macros see the annotated (possibly renamed) tools, and can be annotated themselves.
  const annotated = applyAnnotations(tools, recipe);
  const macros = applyAnnotations(macroTools(recipe, runtime, name, annotated, tools), recipe);
  /** @param {string} url */
  const fetchUrl = async (url) => {
    const result = await runtime.send(recipe, { method: "GET", url: new URL(url, `${recipe.baseUrl.replace(/\/$/, "")}/`).toString() });
    if ("preview" in result) return { status: 0, json: undefined }; // held by the safety policy
    let json;
    try {
      json = JSON.parse(result.body.toString("utf8"));
    } catch {}
    return { status: result.status, json };
  };
  // Read-only tools with a query string can merge several pages.
  const paginated = [...annotated, ...macros].map((tool) =>
    tool.annotations.readOnlyHint && tool.inputSchema.properties?.query && !tool.name.startsWith(`${recipe.name}__stream`) ? withPagination(tool, fetchUrl) : tool,
  );
  const budget = runtime.schemaBudget ?? 3000;
  const final = paginated.map((tool) => {
    const { description, inputSchema } = compactTool(tool, budget);
    return { ...tool, description, inputSchema: safeSchema(inputSchema) };
  });
  // Large recipes expose __operation + __call instead of one tool per operation.
  const threshold = runtime.foldThreshold ?? 20;
  return threshold > 0 && final.filter((t) => t.lazy).length > threshold ? foldTools(recipe, final, name) : final;
}
