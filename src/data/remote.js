// Remote data (a CSV / JSON / Excel / iCalendar address: published spreadsheets, calendar feeds, open data) kept in a local
// cache file and refreshed after a delay, so the SQL tools work on it like on a local file.
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_BYTES = 200 * 1024 * 1024;

/** @type {[RegExp, string][]} */
const TYPES = [
  [/text\/csv|application\/csv/i, ".csv"],
  [/tab-separated/i, ".tsv"],
  [/text\/calendar/i, ".ics"],
  [/spreadsheetml|ms-excel/i, ".xlsx"],
  [/ndjson|jsonl|json-seq/i, ".jsonl"],
  [/json/i, ".json"],
  [/sqlite/i, ".sqlite"],
];

/** File extension of a remote data address: from the URL path, else from the content type. @param {string} url @param {string} [contentType] */
export function remoteExtension(url, contentType = "") {
  const fromPath = /\.(csv|tsv|json|jsonl|ndjson|xlsx|ics|sqlite|db)$/i.exec(new URL(url).pathname)?.[0].toLowerCase();
  if (fromPath) return fromPath;
  const format = new URL(url).searchParams.get("format") ?? new URL(url).searchParams.get("output");
  if (format && /^(csv|tsv|xlsx|json|ics)$/i.test(format)) return `.${format.toLowerCase()}`;
  return TYPES.find(([type]) => type.test(contentType))?.[1];
}

/**
 * Downloads the address into `file` unless the cached copy is younger than maxAgeMs.
 * @param {string} url @param {string} file @param {{ maxAgeMs: number, timeoutMs?: number, headers?: Record<string, string> }} options
 * @returns {Promise<{ file: string, contentType: string, fetched: boolean }>}
 */
export async function fetchToCache(url, file, { maxAgeMs, timeoutMs = 30_000, headers = {} }) {
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < maxAgeMs) return { file, contentType: "", fetched: false };
  const response = await fetch(url, { headers: { accept: "text/csv, application/json, text/calendar, */*;q=0.5", ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!response.ok) {
    // A failed refresh keeps serving the previous copy when there is one.
    if (existsSync(file)) return { file, contentType: "", fetched: false };
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error(`Remote data too large (${length} bytes, limit ${MAX_BYTES}).`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_BYTES) throw new Error(`Remote data too large (${body.length} bytes, limit ${MAX_BYTES}).`);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, file);
  return { file, contentType: response.headers.get("content-type") ?? "", fetched: true };
}

/** Cache file of a remote data recipe. @param {string} home @param {string} name @param {string} extension */
export const cacheFile = (home, name, extension) => join(home, "cache", `${name}${extension}`);
