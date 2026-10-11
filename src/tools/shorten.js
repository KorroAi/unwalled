// Shortened view of a large JSON response: the agent sees its structure and first items for a fraction of the tokens,
// plus the list of field paths it can pass to "pick" to get exactly what it needs.

/**
 * @param {unknown} value
 * @param {{ items: number, chars: number, depth: number }} limits
 * @param {number} [level]
 * @returns {unknown}
 */
function shortenValue(value, limits, level = 0) {
  if (typeof value === "string") return value.length > limits.chars ? `${value.slice(0, limits.chars)}… (${value.length} chars)` : value;
  if (!value || typeof value !== "object") return value;
  if (level >= limits.depth) return Array.isArray(value) ? `[… ${value.length} items]` : `{… ${Object.keys(value).length} keys}`;
  if (Array.isArray(value)) {
    const kept = value.slice(0, limits.items).map((item) => shortenValue(item, limits, level + 1));
    return value.length > limits.items ? [...kept, `… ${value.length - limits.items} more items`] : kept;
  }
  const entries = Object.entries(value);
  // Keys say what a response holds: all are kept (up to a point), their values are what gets shortened.
  const maxKeys = 60;
  const kept = entries.slice(0, maxKeys).map(([k, v]) => [k, shortenValue(v, limits, level + 1)]);
  if (entries.length > maxKeys) kept.push(["…", `${entries.length - maxKeys} more keys`]);
  return Object.fromEntries(kept);
}

/**
 * Shortens JSON until it fits in about `budget` characters (fewer items, shorter strings, then less depth).
 * @param {unknown} json @param {number} budget
 * @returns {string}
 */
export function shortenJson(json, budget) {
  const steps = [
    { items: 5, chars: 300, depth: 8 },
    { items: 3, chars: 160, depth: 6 },
    { items: 2, chars: 80, depth: 5 },
    { items: 1, chars: 60, depth: 4 },
    { items: 1, chars: 40, depth: 3 },
  ];
  let text = "";
  for (const limits of steps) {
    text = JSON.stringify(shortenValue(json, limits));
    if (text.length <= budget) return text;
  }
  return `${text.slice(0, budget)}…`;
}

/**
 * Leaf field paths of a JSON value in pick syntax ("crate.max_version", "versions[*].num"), most common first.
 * Arrays are described by their first items only.
 * @param {unknown} json @param {number} [limit]
 * @returns {string[]}
 */
export function fieldPaths(json, limit = 40) {
  /** @type {Map<string, number>} */ const seen = new Map();
  const walk = (/** @type {unknown} */ value, /** @type {string} */ path, /** @type {number} */ level) => {
    if (seen.size > 2000 || level > 8) return;
    if (Array.isArray(value)) {
      const objects = value.slice(0, 5).filter((item) => item && typeof item === "object");
      if (objects.length) for (const item of objects) walk(item, `${path}[*]`, level + 1);
      else seen.set(path || "[*]", (seen.get(path || "[*]") ?? 0) + 1); // a list of plain values: the list itself
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        const safe = /^[A-Za-z_$][\w$-]*$/.test(key) ? key : null;
        if (safe === null) continue; // keys pick cannot address simply (spaces, dots): left out of the hint
        walk(child, path ? `${path}.${safe}` : safe, level + 1);
      }
      return;
    }
    if (path) seen.set(path, (seen.get(path) ?? 0) + 1);
  };
  walk(json, "", 0);
  const paths = [...seen.keys()];
  return paths.length > limit ? [...paths.slice(0, limit), `… ${paths.length - limit} more`] : paths;
}
