// Helpers shared by discovery and imports: URL checks, merging of recipe parts and secrets.
import { inferJsonRpc } from "./discovery/jsonrpc.js";

/** Largest HAR / API description file read into memory. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

/** @param {string} value */
export function assertHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Only http(s) URLs are supported: ${value}`);
  return url;
}

/** Merges endpoint lists, newer entries replacing older ones with the same identity. */
export function mergeByKey(older, newer, key) {
  const map = new Map(older.map((item) => [key(item), item]));
  for (const item of newer) map.set(key(item), item);
  return [...map.values()];
}
export const restKey = (e) => `${e.method} ${e.origin}${e.pathTemplate}`;
export const streamKey = (s) => `${s.kind} ${s.url}`;
export const pageKey = (p) => `${p.origin}${p.pathTemplate}`;
export const rpcKey = (m) => `${m.url} ${m.method}`;

/** JSON-RPC methods of the observations; plain endpoints that only carried JSON-RPC are dropped. */
export function withJsonRpc(observations, endpoints) {
  const { methods, rpcUrls, secrets } = inferJsonRpc(observations);
  // rpcUrls holds real paths; endpoint templates may have turned a key segment into a parameter.
  const covered = (/** @type {any} */ e) => e.method === "POST" && [...rpcUrls].some((u) => u === `${e.origin}${e.pathTemplate}` || templateMatches(`${e.origin}${e.pathTemplate}`, u));
  return { methods, secrets, endpoints: endpoints.filter((e) => !covered(e)) };
}
export const graphqlKey = (e) => `${e.method} ${e.url} ${e.operationName ?? e.query ?? JSON.stringify(e.extensions)}`;

/** "https://h/v3/{param1}" matches "https://h/v3/abc". @param {string} template @param {string} url */
function templateMatches(template, url) {
  const pattern = new RegExp(`^${template.split(/\{[^}]+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}$`);
  return pattern.test(url);
}

/** @param {Record<string, Record<string, string>>[]} sources */
export function mergeSecrets(...sources) {
  /** @type {Record<string, Record<string, string>>} */ const merged = {};
  for (const source of sources) for (const [host, values] of Object.entries(source)) merged[host] = { ...(merged[host] ?? {}), ...values };
  return merged;
}
