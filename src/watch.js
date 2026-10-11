// Calls a tool repeatedly for a bounded time and reports what changed between calls.
import { messageFilter } from "./realtime/client.js";

const MAX_CHANGES = 200;
const SNAPSHOT_CHARS = 1500;

/** Body of a tool output without its "HTTP 200 — url" header line. @param {string} text */
function body(text) {
  return /^HTTP \d+/.test(text) ? text.slice(text.indexOf("\n") + 1) : text.replace(/^\(cached [^)]*\)\n/, "");
}

/** Flattens JSON into "path" → scalar. @param {unknown} value @returns {Map<string, string>} */
export function flatten(value, prefix = "", out = new Map(), depth = 0) {
  if (out.size > 5000 || depth > 12) return out;
  if (value && typeof value === "object") {
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
    if (!entries.length) out.set(prefix || "$", Array.isArray(value) ? "[]" : "{}");
    for (const [key, inner] of entries) flatten(inner, prefix ? `${prefix}.${key}` : key, out, depth + 1);
  } else out.set(prefix || "$", JSON.stringify(value));
  return out;
}

/** Describes the difference between two outputs. @param {string} before @param {string} after */
export function describeChange(before, after) {
  let a, b;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch {
    return after.length > SNAPSHOT_CHARS ? `${after.slice(0, SNAPSHOT_CHARS)}…` : after;
  }
  const left = flatten(a);
  const right = flatten(b);
  const lines = [];
  for (const [key, value] of right) if (left.get(key) !== value) lines.push(left.has(key) ? `${key}: ${left.get(key)} → ${value}` : `+ ${key}: ${value}`);
  for (const key of left.keys()) if (!right.has(key)) lines.push(`- ${key}`);
  const shown = lines.slice(0, 30);
  return `${shown.join("\n")}${lines.length > shown.length ? `\n… ${lines.length - shown.length} more change(s)` : ""}`;
}

/**
 * @param {(args: Record<string, any>) => Promise<{ text: string, isError: boolean }>} run
 * @param {Record<string, any>} args
 * @param {{ intervalMs: number, durationMs: number, until?: string, onChange?: (message: string) => void, sleep?: (ms: number) => Promise<void>, now?: () => number }} options
 */
export async function watch(run, args, { intervalMs, durationMs, until, onChange = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const stopWhen = until ? messageFilter(until) : null;
  const started = now();
  const changes = [];
  let previous;
  let calls = 0;
  let errors = 0;
  let reason = "duration elapsed";
  for (;;) {
    // The whole response is compared: a shortened view would hide changes past its first items.
    const result = await run({ ...args, cache_seconds: 0, max_chars: args.max_chars ?? 40_000 });
    calls++;
    const current = body(result.text);
    const elapsed = Math.round((now() - started) / 1000);
    if (result.isError) errors++;
    if (previous === undefined) changes.push(`[+${elapsed}s] initial${result.isError ? " (error)" : ""}:\n${current.length > SNAPSHOT_CHARS ? `${current.slice(0, SNAPSHOT_CHARS)}…` : current}`);
    else if (current !== previous) {
      const change = `[+${elapsed}s] changed${result.isError ? " (error)" : ""}:\n${describeChange(previous, current)}`;
      changes.push(change);
      onChange(change);
    }
    previous = current;
    if (stopWhen?.(current)) {
      reason = `"until" matched after ${elapsed}s`;
      break;
    }
    if (changes.length >= MAX_CHANGES) {
      reason = `${MAX_CHANGES} changes recorded`;
      break;
    }
    if (now() - started + intervalMs > durationMs) break;
    await sleep(intervalMs);
  }
  return { text: `Watched ${calls} call(s) over ${Math.round((now() - started) / 1000)}s, ${changes.length - 1} change(s), ${errors} error(s); stopped: ${reason}.\n\n${changes.join("\n\n")}`, isError: false };
}
