// Minimal path selector to cut large JSON responses down to what the agent needs.
// Syntax: "data.items[0].name", "items[*].id", "items.*.id", "meta" ; several paths separated by commas.

/** @param {string} path @returns {(string|number)[]} */
export function parsePath(path) {
  const tokens = [];
  for (const part of path.split(".")) {
    if (part === "") throw new Error(`Invalid pick path "${path}"`);
    const match = /^([^[\]]*)((?:\[(?:\d+|\*)\])*)$/.exec(part);
    if (!match) throw new Error(`Invalid pick path segment "${part}"`);
    if (match[1]) tokens.push(match[1]);
    for (const [, index] of match[2].matchAll(/\[(\d+|\*)\]/g)) tokens.push(index === "*" ? "*" : Number(index));
  }
  return tokens;
}

/** @param {unknown} value @param {(string|number)[]} tokens */
function select(value, tokens) {
  if (!tokens.length) return value;
  const [token, ...rest] = tokens;
  if (value === null || typeof value !== "object") return undefined;
  if (token === "*") {
    const items = Array.isArray(value) ? value : Object.values(value);
    return items.map((item) => select(item, rest)).filter((v) => v !== undefined);
  }
  return select(value[token], rest);
}

/**
 * @param {unknown} data
 * @param {string} expression one or more comma-separated paths
 */
export function pick(data, expression) {
  const paths = expression.split(",").map((p) => p.trim()).filter(Boolean);
  if (paths.length === 1) return select(data, parsePath(paths[0]));
  return Object.fromEntries(paths.map((p) => [p, select(data, parsePath(p))]));
}
