// Automatic pagination for read-only generated tools: follows next-page tokens/URLs, page numbers or offsets,
// and returns the merged list of items.
import { pick } from "./pick.js";

const MAX_PAGES = 50;
const PAGE_CHARS = 5_000_000;
const ITEM_KEYS = ["items", "data", "results", "records", "entries", "list", "rows", "nodes", "edges", "hits", "values", "elements", "objects"];
const NEXT_KEY = /^(next|next_?page|next_?page_?token|next_?token|next_?cursor|cursor_?next|next_?url|next_?link|next_?href|nextlink|odata\.nextlink|continuation(_?token)?|end_?cursor)$/i;
const TOKEN_PARAMS = ["pageToken", "page_token", "cursor", "after", "next", "starting_after", "continuation", "continuationToken", "token", "next_token", "nextToken"];
const PAGE_PARAM = /^(page|p|page_?num(ber)?|page_?index|pg)$/i;
const OFFSET_PARAM = /^(offset|skip|start|start_?index|from|first_?result)$/i;

export const PAGINATE_PROPERTY = {
  paginate: {
    type: "object",
    description:
      "Optional: fetch several pages and merge their items. Follows next-page tokens/URLs found in the response, otherwise increments a page number " +
      "or offset passed in query (e.g. query.page=1 or query.offset=0).",
    properties: {
      max_pages: { type: "integer", minimum: 1, maximum: MAX_PAGES, description: "Default 5." },
      max_items: { type: "integer", minimum: 1, description: "Stop once this many items are collected (default 1000)." },
      items_path: { type: "string", description: 'Where the list is in each page (e.g. "data.items"); detected automatically otherwise.' },
    },
  },
};

/**
 * Finds the list of items in a page.
 * @param {unknown} json @param {string | undefined} itemsPath
 * @returns {{ items: unknown[] | null, path: string }}
 */
export function findItems(json, itemsPath) {
  if (itemsPath) {
    const value = pick(json, itemsPath);
    return { items: Array.isArray(value) ? value : null, path: itemsPath };
  }
  if (Array.isArray(json)) return { items: json, path: "" };
  if (!json || typeof json !== "object") return { items: null, path: "" };
  /** @type {{ items: unknown[], path: string, score: number } | null} */ let best = null;
  const consider = (value, path, depth) => {
    if (!Array.isArray(value)) return;
    const name = path.split(".").at(-1) ?? "";
    const score = value.length + (ITEM_KEYS.includes(name.toLowerCase()) ? 1000 : 0) - depth;
    if (!best || score > best.score) best = { items: value, path, score };
  };
  for (const [key, value] of Object.entries(json)) {
    consider(value, key, 0);
    if (value && typeof value === "object" && !Array.isArray(value)) for (const [sub, inner] of Object.entries(value)) consider(inner, `${key}.${sub}`, 1);
  }
  return best ? { items: best.items, path: best.path } : { items: null, path: "" };
}

/** Finds a next-page token or URL in a page (up to 3 levels deep). @param {unknown} json */
export function findNext(json) {
  /** @type {{ key: string, value: string } | null} */ let found = null;
  let hasMore = undefined;
  const visit = (value, depth) => {
    if (found || depth > 3 || !value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, inner] of Object.entries(value)) {
      if (/^(has_?more|has_?next(_?page)?|more)$/i.test(key) && typeof inner === "boolean") hasMore = inner;
      if (NEXT_KEY.test(key) && (typeof inner === "string" || typeof inner === "number") && String(inner) !== "") {
        found = { key, value: String(inner) };
        return;
      }
      if (/^next$/i.test(key) && inner && typeof inner === "object" && typeof (/** @type {any} */ (inner).href) === "string") {
        found = { key, value: /** @type {any} */ (inner).href };
        return;
      }
    }
    for (const inner of Object.values(value)) visit(inner, depth + 1);
  };
  visit(json, 0);
  return { next: found, hasMore };
}

/**
 * Decides how to request the following page.
 * @param {unknown} json @param {Record<string, unknown>} query current query @param {number} count items in this page
 * @returns {{ url: string } | { query: Record<string, unknown> } | { stop: string }}
 */
export function nextPage(json, query, count) {
  const { next, hasMore } = findNext(json);
  if (hasMore === false) return { stop: "the API reports no more pages" };
  if (next) {
    if (/^(https?:\/\/|\/)/.test(next.value)) return { url: next.value };
    const existing = TOKEN_PARAMS.find((name) => name in query);
    const derived = next.key.replace(/^next_?/i, "").replace(/^Page/, "page").replace(/^Token/, "token").replace(/^Cursor/, "cursor") || "cursor";
    const param = existing ?? (/^end_?cursor$/i.test(next.key) ? "after" : /^next$/i.test(next.key) ? "cursor" : derived.replace(/^./, (c) => c.toLowerCase()));
    return { query: { ...query, [param]: next.value } };
  }
  if (!count) return { stop: "empty page" };
  const pageKey = Object.keys(query).find((k) => PAGE_PARAM.test(k) && /^\d+$/.test(String(query[k])));
  if (pageKey) return { query: { ...query, [pageKey]: Number(query[pageKey]) + 1 } };
  const offsetKey = Object.keys(query).find((k) => OFFSET_PARAM.test(k) && /^\d+$/.test(String(query[k])));
  if (offsetKey) return { query: { ...query, [offsetKey]: Number(query[offsetKey]) + count } };
  return { stop: "no next-page token in the response and no page/offset parameter in query" };
}

/** @param {string} text tool output "HTTP <status> — <url>\n<body>" */
function parseToolOutput(text) {
  const newline = text.indexOf("\n");
  const header = newline === -1 ? text : text.slice(0, newline);
  const status = Number(/^HTTP (\d+)/.exec(header)?.[1] ?? 0);
  try {
    return { status, json: JSON.parse(text.slice(newline + 1)), header };
  } catch {
    return { status, json: undefined, header };
  }
}

/**
 * Adds a "paginate" option to a read-only tool.
 * @param {import("./generate.js").GeneratedTool} tool
 * @param {(url: string) => Promise<{ status: number, json: unknown }>} fetchUrl GET an absolute next-page URL with the recipe's credentials
 * @returns {import("./generate.js").GeneratedTool}
 */
export function withPagination(tool, fetchUrl) {
  const run = tool.run;
  return {
    ...tool,
    inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, ...PAGINATE_PROPERTY } },
    run: async (args) => {
      if (!args.paginate) return run(args);
      const maxPages = Math.min(Math.max(Number(args.paginate.max_pages ?? 5), 1), MAX_PAGES);
      const maxItems = Math.max(Number(args.paginate.max_items ?? 1000), 1);
      const { paginate, pick: pickExpression, max_chars: maxChars, ...base } = args;
      /** @type {unknown[]} */ const items = [];
      let query = { ...(base.query ?? {}) };
      let stop = `reached max_pages (${maxPages})`;
      let pages = 0;
      let itemsPath = paginate.items_path;
      const seen = new Set();
      /** @type {{ status: number, json: unknown }} */ let page = parseToolOutput((await run({ ...base, query, max_chars: PAGE_CHARS })).text);
      for (;;) {
        pages++;
        if (page.status >= 400 || page.json === undefined) {
          if (pages === 1) return run(args); // not a JSON list: plain call
          stop = `page ${pages} failed (HTTP ${page.status})`;
          break;
        }
        const found = findItems(page.json, itemsPath);
        if (!found.items) {
          if (pages === 1) return run(args);
          stop = `no list found in page ${pages}`;
          break;
        }
        itemsPath ??= found.path || undefined;
        items.push(...found.items);
        if (items.length >= maxItems) {
          stop = `reached max_items (${maxItems})`;
          break;
        }
        if (pages >= maxPages) break;
        const next = nextPage(page.json, query, found.items.length);
        if ("stop" in next) {
          stop = next.stop;
          break;
        }
        const key = "url" in next ? next.url : JSON.stringify(next.query);
        if (seen.has(key)) {
          stop = "the next page repeats a previous one";
          break;
        }
        seen.add(key);
        if ("url" in next) page = await fetchUrl(next.url);
        else {
          query = next.query;
          page = parseToolOutput((await run({ ...base, query, max_chars: PAGE_CHARS })).text);
        }
      }
      const kept = items.slice(0, maxItems);
      let selected = kept;
      if (pickExpression) selected = /** @type {unknown[]} */ (kept.map((item) => pick(item, pickExpression)).filter((v) => v !== undefined));
      let text = `Paginated: ${pages} page(s), ${kept.length} item(s)${itemsPath ? ` from "${itemsPath}"` : ""}; stopped: ${stop}.\n${JSON.stringify(selected)}`;
      const limit = maxChars ?? PAGE_CHARS;
      if (text.length > limit) text = `${text.slice(0, limit)}\n… [truncated: ${text.length} characters; use pick, max_items or max_chars]`;
      return { text, isError: false };
    },
  };
}
