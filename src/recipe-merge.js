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
export const rpcKey = (m) => `${m.url} ${m.method}`;

/** JSON-RPC methods of the observations; plain endpoints that only carried JSON-RPC are dropped. */
export function withJsonRpc(observations, endpoints) {
  const { methods, rpcUrls } = inferJsonRpc(observations);
  return { methods, endpoints: endpoints.filter((e) => !(e.method === "POST" && rpcUrls.has(`${e.origin}${e.pathTemplate}`))) };
}
export const graphqlKey = (e) => `${e.method} ${e.url} ${e.operationName ?? e.query ?? JSON.stringify(e.extensions)}`;

/** @param {Record<string, Record<string, string>>[]} sources */
export function mergeSecrets(...sources) {
  /** @type {Record<string, Record<string, string>>} */ const merged = {};
  for (const source of sources) for (const [host, values] of Object.entries(source)) merged[host] = { ...(merged[host] ?? {}), ...values };
  return merged;
}
