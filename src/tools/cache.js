// Optional in-memory cache for read-only generated tools: identical calls within cache_seconds reuse the last result.

const MAX_ENTRIES = 300;

export const CACHE_PROPERTY = {
  cache_seconds: { type: "integer", minimum: 0, maximum: 86_400, description: "Optional: reuse an identical successful call made less than this many seconds ago." },
};

/** @type {Map<string, { at: number, result: { text: string, isError: boolean } }>} */
const entries = new Map();

export function clearCache() {
  entries.clear();
}

/** Stable JSON (sorted keys) so that argument order does not matter. @param {unknown} value @returns {string} */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

/**
 * @param {import("./generate.js").GeneratedTool} tool
 * @param {{ defaultSeconds?: number, now?: () => number }} [options]
 * @returns {import("./generate.js").GeneratedTool}
 */
export function withCache(tool, { defaultSeconds = 0, now = Date.now } = {}) {
  const run = tool.run;
  return {
    ...tool,
    inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, ...CACHE_PROPERTY } },
    run: async (args) => {
      const { cache_seconds: requested, ...rest } = args;
      const seconds = Number(requested ?? defaultSeconds) || 0;
      if (seconds <= 0) return run(rest);
      const key = `${tool.name} ${stable(rest)}`;
      const hit = entries.get(key);
      if (hit && now() - hit.at < seconds * 1000) {
        entries.delete(key);
        entries.set(key, hit); // most recently used last
        return { ...hit.result, text: `(cached ${Math.round((now() - hit.at) / 1000)}s ago)\n${hit.result.text}` };
      }
      const result = await run(rest);
      if (!result.isError) {
        entries.set(key, { at: now(), result });
        while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
      }
      return result;
    },
  };
}
