// JSON-RPC (1.0 / 2.0) support: requests whose body is {"jsonrpc", "method", "params"} (or a batch of them)
// become one tool per method instead of a single opaque POST endpoint.
import { redact, redactUrl } from "./infer.js";
import { describeShape, inferSchema } from "../tools/schema.js";

/**
 * @typedef {object} RpcMethod
 * @property {string} url endpoint (query string kept, secrets redacted by the caller's rules)
 * @property {string} method JSON-RPC method name
 * @property {"1.0" | "2.0"} version
 * @property {"array" | "object" | "none"} paramsKind
 * @property {Record<string, any>} paramsSchema
 * @property {string} paramsExample redacted
 * @property {string} resultShape
 * @property {number} observed
 */

/** @param {unknown} value @returns {{ method: string, params?: unknown, jsonrpc?: string }[] | null} */
function rpcCalls(value) {
  const list = Array.isArray(value) ? value : [value];
  if (!list.length) return null;
  const calls = list.filter((c) => c && typeof c === "object" && typeof c.method === "string" && ("jsonrpc" in c || ("id" in c && "params" in c)));
  return calls.length === list.length ? calls : null;
}

/** @param {string | null} body */
function parse(body) {
  if (!body || !/^\s*[[{]/.test(body)) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * @param {import("./infer.js").Observation[]} observations
 * @returns {{ methods: RpcMethod[], rpcUrls: Set<string> }} rpcUrls: endpoints that only carried JSON-RPC (their generic REST endpoint is redundant)
 */
export function inferJsonRpc(observations) {
  /** @type {Map<string, { url: string, method: string, version: "1.0" | "2.0", params: unknown[], results: unknown[], observed: number }>} */ const groups = new Map();
  /** @type {Map<string, boolean>} */ const onlyRpc = new Map();
  for (const obs of observations) {
    if (obs.method !== "POST" || obs.status >= 400) continue;
    let url;
    try {
      url = new URL(obs.url);
    } catch {
      continue;
    }
    const endpoint = `${url.origin}${url.pathname}`;
    // Sensitive query parameters (API keys) are left out: they are host secrets, added back when sending.
    const redacted = new URL(redactUrl(obs.url));
    for (const [key, value] of [...redacted.searchParams]) if (value === "REDACTED") url.searchParams.delete(key);
    const calls = rpcCalls(parse(obs.requestBody));
    if (!calls) {
      onlyRpc.set(endpoint, false);
      continue;
    }
    if (!onlyRpc.has(endpoint)) onlyRpc.set(endpoint, true);
    const responses = Array.isArray(obs.responseJson) ? obs.responseJson : [obs.responseJson];
    calls.forEach((call, index) => {
      const key = `${url} ${call.method}`;
      const group = groups.get(key) ?? { url: url.toString(), method: call.method, version: call.jsonrpc === "2.0" ? "2.0" : "1.0", params: [], results: [], observed: 0 };
      group.observed++;
      if (call.params !== undefined) group.params.push(call.params);
      const response = responses.find((r) => r && typeof r === "object" && "id" in r && r.id === /** @type {any} */ (call).id) ?? responses[index];
      if (response && typeof response === "object" && "result" in response) group.results.push(response.result);
      groups.set(key, group);
    });
  }
  const methods = [...groups.values()].map((g) => {
    const first = g.params[0];
    const paramsKind = first === undefined ? "none" : Array.isArray(first) ? "array" : "object";
    return {
      url: g.url, method: g.method, version: g.version, paramsKind,
      paramsSchema: paramsKind === "none" ? {} : inferSchema(g.params.slice(0, 20).map((p) => redact(p))),
      paramsExample: first === undefined ? "none" : JSON.stringify(redact(first)).slice(0, 400),
      resultShape: g.results.length ? describeShape(inferSchema(g.results.slice(0, 20))) : "unknown",
      observed: g.observed,
    };
  });
  return { methods: /** @type {RpcMethod[]} */ (methods), rpcUrls: new Set([...onlyRpc].filter(([, only]) => only).map(([endpoint]) => endpoint)) };
}

/**
 * @param {any} recipe
 * @param {{ send: (recipe: any, request: any) => Promise<any> }} runtime
 * @param {(suffix: string) => string} name
 * @param {(result: any, args: Record<string, any>) => { text: string, isError: boolean }} format
 */
export function buildRpcTools(recipe, runtime, name, format) {
  const methods = recipe.jsonrpc ?? [];
  let nextId = 1;
  const tools = methods.map((m) => ({
    name: name(`rpc_${m.method}`),
    description: `[${recipe.name}] JSON-RPC ${m.version} method "${m.method}" at ${m.url} — observed ${m.observed}×. Params example: ${m.paramsExample}. Result: ${m.resultShape}.`.slice(0, 1200),
    inputSchema: {
      type: "object",
      properties: {
        params: m.paramsKind === "array" ? { type: "array", items: {}, description: "Positional parameters." } : { type: "object", additionalProperties: true, ...(m.paramsKind === "object" ? { properties: m.paramsSchema.properties ?? {} } : {}), description: "Named parameters." },
        pick: { type: "string", description: 'Optional: keep only part of the JSON response, e.g. "result.items[*].name".' },
        max_chars: { type: "integer", minimum: 20 },
      },
    },
    // Method names do not say whether they write: only obvious readers are marked read-only.
    annotations: { title: `${recipe.name} ${m.method}`, readOnlyHint: /^(get|list|find|search|read|query|fetch|describe|count|eth_(get|call|block|chain|gas|estimate)|net_|web3_)/i.test(m.method.replace(/^[\w]+\./, "")), destructiveHint: false, openWorldHint: true },
    /** @param {Record<string, any>} args */
    run: async (args) => {
      const payload = { ...(m.version === "2.0" ? { jsonrpc: "2.0" } : {}), id: nextId++, method: m.method, ...(args.params !== undefined || m.paramsKind !== "none" ? { params: args.params ?? (m.paramsKind === "array" ? [] : {}) } : {}) };
      const result = await runtime.send(recipe, { method: "POST", url: m.url, body: payload, bodyKind: "json" });
      return format(result, args);
    },
  }));
  if (methods.length) {
    const urls = [...new Set(methods.map((m) => m.url))];
    tools.push({
      name: name("rpc"),
      description: `[${recipe.name}] Call any JSON-RPC method on ${urls.join(", ")}.`,
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string" },
          params: { description: "Array (positional) or object (named) parameters." },
          endpoint: { type: "string", enum: urls, description: `Defaults to ${urls[0]}.` },
          pick: { type: "string" },
          max_chars: { type: "integer", minimum: 20 },
        },
        required: ["method"],
      },
      annotations: { title: `${recipe.name} JSON-RPC`, readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      /** @param {Record<string, any>} args */
      run: async (args) => {
        const url = args.endpoint ?? urls[0];
        const version = methods.find((m) => m.url === url)?.version ?? "2.0";
        const payload = { ...(version === "2.0" ? { jsonrpc: "2.0" } : {}), id: nextId++, method: String(args.method), ...(args.params !== undefined ? { params: args.params } : {}) };
        return format(await runtime.send(recipe, { method: "POST", url, body: payload, bodyKind: "json" }), args);
      },
    });
  }
  return tools;
}
