// JSON-RPC (1.0 / 2.0) support: requests whose body is {"jsonrpc", "method", "params"} (or a batch of them)
// become one tool per method instead of a single opaque POST endpoint.
import { redact, redactUrl } from "./infer.js";
import { isSecretSegment, REDACTED } from "./secrets.js";

/** Secret entry restoring a path whose key was hidden ("/v3/REDACTED" -> "/v3/<key>"), keyed by the hidden path. */
export const SECRET_PATH_PREFIX = "~path:";
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
 * @returns {{ methods: RpcMethod[], rpcUrls: Set<string>, secrets: Record<string, Record<string, string>> }} rpcUrls: endpoints that only
 *   carried JSON-RPC (their generic REST endpoint is redundant); secrets: API keys found in endpoint paths (Infura, Alchemy...)
 */
export function inferJsonRpc(observations) {
  /** @type {Record<string, Record<string, string>>} */ const secrets = {};
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
    // Hosted nodes put the API key in the path ("/v3/<key>"): the recipe keeps "/v3/REDACTED", the key goes to the secrets.
    const segments = url.pathname.split("/");
    const hidden = segments.map((segment, i) => (isSecretSegment(decodeSafe(segment), decodeSafe(segments[i - 1] ?? "")) ? REDACTED : segment)).join("/");
    if (hidden !== url.pathname) {
      secrets[url.host] = { ...(secrets[url.host] ?? {}), [`${SECRET_PATH_PREFIX}${hidden}`]: url.pathname };
      url.pathname = hidden;
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
  return { methods: /** @type {RpcMethod[]} */ (methods), rpcUrls: new Set([...onlyRpc].filter(([, only]) => only).map(([endpoint]) => endpoint)), secrets };
}

/** @param {string} segment */
function decodeSafe(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Method names do not say whether they write: only obvious readers are read-only. @param {string} method */
const isReader = (method) => /^(get|list|find|search|read|query|fetch|describe|count|eth_(get|call|block|chain|gas|estimate)|net_|web3_)/i.test(method.replace(/^[\w]+\./, ""));

/**
 * @param {any} recipe
 * @param {(suffix: string) => string} name
 * @param {(request: any, args: Record<string, any>, toolName: string, transform?: (result: any) => any) => Promise<{ text: string, isError: boolean }>} exec
 *   sends a request through the recipe's pipeline (credentials, safety policy, formatting) and returns the tool result
 * @param {Record<string, any>} outputProperties shared output options of generated tools (pick, max_chars...)
 */
export function buildRpcTools(recipe, name, exec, outputProperties) {
  const methods = recipe.jsonrpc ?? [];
  let nextId = 1;
  const tools = methods.map((m) => {
    const toolName = name(`rpc_${m.method}`);
    const readOnly = isReader(m.method);
    return {
      lazy: true,
      name: toolName,
      description: `[${recipe.name}] JSON-RPC ${m.version} method "${m.method}" at ${m.url} — observed ${m.observed}×. Params example: ${m.paramsExample}. Result: ${m.resultShape}.`.slice(0, 1200),
      inputSchema: {
        type: "object",
        properties: {
          params: m.paramsKind === "array" ? { type: "array", items: {}, description: "Positional parameters." } : { type: "object", additionalProperties: true, ...(m.paramsKind === "object" ? { properties: m.paramsSchema.properties ?? {} } : {}), description: "Named parameters." },
          ...outputProperties,
        },
      },
      // Anything that is not obviously a reader may change data.
      annotations: { title: `${recipe.name} ${m.method}`, readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true },
      /** @param {Record<string, any>} args */
      run: async (args) => {
        const payload = { ...(m.version === "2.0" ? { jsonrpc: "2.0" } : {}), id: nextId++, method: m.method, ...(args.params !== undefined || m.paramsKind !== "none" ? { params: args.params ?? (m.paramsKind === "array" ? [] : {}) } : {}) };
        return exec({ method: "POST", url: m.url, body: payload, bodyKind: "json", intent: readOnly ? "read" : "write" }, args, toolName);
      },
    };
  });
  if (methods.length) {
    const urls = [...new Set(methods.map((m) => m.url))];
    const toolName = name("rpc");
    tools.push({
      name: toolName,
      description: `[${recipe.name}] Call any JSON-RPC method on ${urls.join(", ")}.`,
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string" },
          params: { description: "Array (positional) or object (named) parameters." },
          endpoint: { type: "string", enum: urls, description: `Defaults to ${urls[0]}.` },
          ...outputProperties,
        },
        required: ["method"],
      },
      annotations: { title: `${recipe.name} JSON-RPC`, readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      /** @param {Record<string, any>} args */
      run: async (args) => {
        const url = args.endpoint ?? urls[0];
        const version = methods.find((m) => m.url === url)?.version ?? "2.0";
        const payload = { ...(version === "2.0" ? { jsonrpc: "2.0" } : {}), id: nextId++, method: String(args.method), ...(args.params !== undefined ? { params: args.params } : {}) };
        return exec({ method: "POST", url, body: payload, bodyKind: "json", intent: isReader(String(args.method)) ? "read" : "write" }, args, toolName);
      },
    });
  }
  return tools;
}
