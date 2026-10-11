// Minimal path selector to cut large JSON responses down to what the agent needs.
// Syntax: "data.items[0].name", "items[*].id", "items.*.id", "meta" ; several paths separated by commas.
// Arrays also accept slices "items[0:5]", "items[-3:]" and filters "items[?price>10]", "items[?status=open]",
// "items[?name~lamp]" (contains, case-insensitive), "items[?tags]" (field present and truthy), "items[?a.b!=1]".
// "items.#" returns the length of a list (or the number of keys of an object); "items[-1]" is the last item;
// "**price" finds every "price" key at any depth.
// Standard JSONPath is accepted too when the expression starts with "$": "$.items[*].name", "$..price",
// "$.items[?(@.price > 10)].name", "$['odd key']".

/**
 * @typedef {{ slice: [number | undefined, number | undefined] }} SliceToken
 * @typedef {{ filter: { path: string[], op: string, value: string | undefined } }} FilterToken
 * @typedef {string | number | SliceToken | FilterToken} Token
 */

const BRACKET = /\[(-?\d+|\*|-?\d*:-?\d*|\?[^\]]+|'[^']*')\]/g;

/**
 * Translates a JSONPath expression into this module's syntax.
 * @param {string} expression starts with "$"
 */
export function fromJsonPath(expression) {
  let path = expression.trim().slice(1);
  if (/&&|\|\||\bin\b|=~|\(\s*@\s*\)/.test(path)) throw new Error(`Unsupported JSONPath expression "${expression}": use a single comparison per filter.`);
  path = path
    // Keys with dots or brackets stay quoted ("$['a.b']"); others become plain segments.
    .replace(/\[\s*'([^']*)'\s*\]|\[\s*"([^"]*)"\s*\]/g, (_, single, double) => {
      const key = single ?? double;
      return /[.[\]]/.test(key) ? `['${key}']` : `.${key}`;
    })
    .replace(/\[\?\(\s*@\.?([^)]*?)\s*(===|==|!==|!=|>=|<=|>|<)\s*([^)]*?)\s*\)\]/g, (_, field, op, value) => `[?${field}${op.startsWith("!") ? "!=" : op.startsWith("=") ? "=" : op}${value}]`)
    .replace(/\[\?\(\s*@\.?([^)]*?)\s*\)\]/g, (_, field) => `[?${field}]`)
    .replace(/\.\.([^.[]+)/g, ".**$1")
    .replace(/\.\.\[/g, ".**[")
    .replace(/^\./, "");
  return path;
}

/** @param {string} body text inside "[?...]" */
function parseFilter(body) {
  const match = /^([^=!<>~]+?)\s*(!=|>=|<=|=|>|<|~)\s*(.*)$/.exec(body);
  if (!match) return { filter: { path: body.trim().split("."), op: "exists", value: undefined } };
  return { filter: { path: match[1].trim().split("."), op: match[2], value: match[3].trim().replace(/^["']|["']$/g, "") } };
}

/** Splits on dots that are not inside brackets or quoted keys. @param {string} path */
function splitSegments(path) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const char of path) {
    if (char === "'" && depth > 0) quoted = !quoted;
    if (char === "[" && !quoted) depth++;
    if (char === "]" && !quoted) depth--;
    if (char === "." && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts;
}

/** @param {string} path @returns {Token[]} */
export function parsePath(path) {
  /** @type {Token[]} */ const tokens = [];
  // "[]" (every item, as in jq and many agents' habits) means "[*]".
  for (const part of splitSegments(path.replace(/\[\]/g, "[*]"))) {
    if (part === "") throw new Error(`Invalid pick path "${path}"`);
    const match = /^([^[\]]*)((?:\[(?:-?\d+|\*|-?\d*:-?\d*|\?[^\]]+|'[^']*')\])*)$/.exec(part);
    if (!match) throw new Error(`Invalid pick path segment "${part}"`);
    if (match[1]) tokens.push(match[1]);
    for (const [, index] of match[2].matchAll(BRACKET)) {
      if (index === "*") tokens.push("*");
      else if (index.startsWith("'")) tokens.push(index.slice(1, -1));
      else if (index.startsWith("?")) tokens.push(parseFilter(index.slice(1)));
      else if (index.includes(":")) {
        const [start, end] = index.split(":").map((n) => (n === "" ? undefined : Number(n)));
        tokens.push({ slice: [start, end] });
      } else tokens.push(Number(index));
    }
  }
  return tokens;
}

/** @param {unknown} item @param {FilterToken["filter"]} filter */
function matches(item, { path, op, value }) {
  let current = item;
  for (const key of path) current = current && typeof current === "object" && Object.hasOwn(current, key) ? current[key] : undefined;
  if (op === "exists") return current !== undefined && current !== null && current !== false && current !== "";
  if (current === undefined || current === null) return op === "!=";
  const text = typeof current === "object" ? JSON.stringify(current) : String(current);
  const number = Number(value);
  const numeric = value !== "" && Number.isFinite(number) && typeof current !== "object" && Number.isFinite(Number(current));
  switch (op) {
    case "=":
      return numeric ? Number(current) === number : text === value;
    case "!=":
      return numeric ? Number(current) !== number : text !== value;
    case "~":
      return text.toLowerCase().includes(String(value).toLowerCase());
    case ">":
      return numeric && Number(current) > number;
    case "<":
      return numeric && Number(current) < number;
    case ">=":
      return numeric && Number(current) >= number;
    case "<=":
      return numeric && Number(current) <= number;
    default:
      return false;
  }
}

/** @param {unknown} value @param {Token[]} tokens @returns {unknown} */
function select(value, tokens) {
  if (!tokens.length) return value;
  const [token, ...rest] = tokens;
  if (value === null || typeof value !== "object") return undefined;
  if (token === "#") return Array.isArray(value) ? value.length : Object.keys(value).length;
  if (typeof token === "string" && token.startsWith("**")) {
    // Every value of this key at any depth, each followed by the rest of the path.
    const key = token.slice(2);
    const found = [];
    const visit = (/** @type {unknown} */ node, depth = 0) => {
      if (!node || typeof node !== "object" || depth > 50 || found.length > 10_000) return;
      if (!Array.isArray(node) && Object.hasOwn(node, key)) found.push(node[key]);
      for (const child of Array.isArray(node) ? node : Object.values(node)) visit(child, depth + 1);
    };
    visit(value);
    return found.map((item) => select(item, rest)).filter((v) => v !== undefined);
  }
  if (typeof token === "number" && token < 0) return Array.isArray(value) ? select(value.at(token), rest) : undefined;
  if (token === "*") {
    const items = Array.isArray(value) ? value : Object.values(value);
    return items.map((item) => select(item, rest)).filter((v) => v !== undefined);
  }
  if (typeof token === "object") {
    if ("slice" in token && !Array.isArray(value)) return undefined;
    // Consecutive slices and filters ("[?a>1][?b=2][0:3]") all apply to the list itself.
    let items = Array.isArray(value) ? value : Object.values(value);
    let remaining = tokens;
    while (remaining.length && typeof remaining[0] === "object") {
      const op = /** @type {SliceToken | FilterToken} */ (remaining[0]);
      items = "slice" in op ? items.slice(op.slice[0], op.slice[1]) : items.filter((item) => matches(item, op.filter));
      remaining = remaining.slice(1);
    }
    if (remaining[0] === "#") return items.length;
    return items.map((item) => select(item, remaining)).filter((v) => v !== undefined);
  }
  // Own properties only: "constructor" or "__proto__" must not reach Object.prototype.
  return Object.hasOwn(value, token) ? select(value[/** @type {string | number} */ (token)], rest) : undefined;
}

/**
 * @param {unknown} data
 * @param {string} expression one or more comma-separated paths
 */
export function pick(data, expression) {
  const paths = splitSegmentsOnCommas(expression).map((p) => p.trim()).filter(Boolean);
  const run = (/** @type {string} */ path) => {
    const native = path.startsWith("$") ? fromJsonPath(path) : path;
    return native === "" ? data : select(data, parsePath(native));
  };
  if (paths.length === 1) return run(paths[0]);
  return Object.fromEntries(paths.map((p) => [p, run(p)]));
}

/** Commas inside filters ("[?a=1,2]") do not separate paths. @param {string} expression */
function splitSegmentsOnCommas(expression) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of expression) {
    if (char === "[") depth++;
    if (char === "]") depth--;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts;
}
