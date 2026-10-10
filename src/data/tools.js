// Tools of a local data recipe: "<recipe>__tables" (schema, row counts, samples) and "<recipe>__sql" (read-only SQL).
import { statSync } from "node:fs";
import { pick } from "../tools/pick.js";
import { assertReadOnly, dataFiles, describeTable, openData } from "./source.js";

const IDLE_MS = 5 * 60 * 1000;

/** Open connections, reused while the files do not change. @type {Map<string, { version: string, data: Promise<Awaited<ReturnType<typeof openData>>>, timer?: NodeJS.Timeout }>} */
const open = new Map();

/** @param {string} path */
function versionOf(path) {
  return dataFiles(path).map((f) => `${f}:${statSync(f).mtimeMs}:${statSync(f).size}`).join("|");
}

/** @param {string} path */
async function connection(path) {
  const version = versionOf(path);
  let entry = open.get(path);
  if (entry && entry.version !== version) {
    (await entry.data.catch(() => null))?.close();
    open.delete(path);
    entry = undefined;
  }
  if (!entry) {
    entry = { version, data: openData(path) };
    open.set(path, entry);
    entry.data.catch(() => open.delete(path));
  }
  clearTimeout(entry.timer);
  const current = entry;
  current.timer = setTimeout(async () => {
    if (open.get(path) === current) open.delete(path);
    (await current.data.catch(() => null))?.close();
  }, IDLE_MS);
  current.timer.unref?.();
  return current.data;
}

/** Closes every cached connection (tests, shutdown). */
export async function closeDataConnections() {
  for (const [path, entry] of open) {
    open.delete(path);
    clearTimeout(entry.timer);
    (await entry.data.catch(() => null))?.close();
  }
}

/** SQLite returns BigInt for large integers and null-prototype rows: make them JSON-friendly. @param {any} row */
const plain = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v instanceof Uint8Array ? `base64:${Buffer.from(v).toString("base64")}` : v]));

/**
 * @param {any} recipe kind "data"
 * @param {(suffix: string) => string} name
 * @param {number} maxOutputChars
 * @param {(recipe: any) => Promise<string>} [dataPath] where the data is (remote data is downloaded into a cache)
 */
export function buildDataTools(recipe, name, maxOutputChars, dataPath = async (r) => r.source.path) {
  const path = recipe.source.remote ? `${recipe.source.origin} (remote, refreshed every ${recipe.source.refreshSeconds ?? 300}s)` : recipe.source.path;
  const summary = (recipe.tables ?? []).map((t) => `${t.name}(${t.columns.map((c) => c.name).slice(0, 12).join(", ")}${t.columns.length > 12 ? ", …" : ""}) ${t.rows} rows`).join("; ");
  return [
    {
      name: name("tables"),
      description: `[${recipe.name}] Tables of the local data ${path}: columns, types, row counts and sample rows. ${summary}`.slice(0, 1200),
      inputSchema: { type: "object", properties: { table: { type: "string", description: "Only this table." } } },
      annotations: { title: `${recipe.name} tables`, readOnlyHint: true, openWorldHint: false },
      /** @param {Record<string, any>} args */
      run: async (args) => {
        const { db, tables } = await connection(await dataPath(recipe));
        const wanted = args.table ? tables.filter((t) => t === args.table) : tables;
        if (args.table && !wanted.length) return { text: `Unknown table "${args.table}". Tables: ${tables.join(", ")}`, isError: true };
        return { text: JSON.stringify(wanted.map((t) => describeTable(db, t)), null, 1).slice(0, maxOutputChars), isError: false };
      },
    },
    {
      name: name("sql"),
      description: (
        `[${recipe.name}] Read-only SQL (SQLite dialect) on the local data ${path}. Tables: ${summary}. ` +
        "Use aggregates (count, sum, avg, group by) and filters instead of reading everything."
      ).slice(0, 1200),
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "One SELECT / WITH / VALUES / EXPLAIN statement." },
          params: { type: "array", items: {}, description: "Values for ? placeholders." },
          max_rows: { type: "integer", minimum: 1, maximum: 10_000, description: "Default 200." },
          pick: { type: "string", description: 'Optional: keep only part of the result, e.g. "rows[*].name".' },
          max_chars: { type: "integer", minimum: 20 },
        },
        required: ["sql"],
      },
      annotations: { title: `${recipe.name} SQL`, readOnlyHint: true, openWorldHint: false },
      /** @param {Record<string, any>} args */
      run: async (args) => {
        let sql;
        try {
          sql = assertReadOnly(String(args.sql ?? ""));
        } catch (error) {
          return { text: error.message, isError: true };
        }
        const { db } = await connection(await dataPath(recipe));
        const maxRows = Math.min(Math.max(Number(args.max_rows ?? 200), 1), 10_000);
        let rows;
        try {
          const statement = db.prepare(sql);
          rows = [];
          for (const row of statement.iterate(...(Array.isArray(args.params) ? args.params : []))) {
            if (rows.length >= maxRows + 1) break;
            rows.push(plain(row));
          }
        } catch (error) {
          return { text: `SQL error: ${error.message}`, isError: true };
        }
        const truncated = rows.length > maxRows;
        const result = { columns: rows[0] ? Object.keys(rows[0]) : [], rows: rows.slice(0, maxRows), truncated };
        let text = JSON.stringify(args.pick ? pick(result, args.pick) : result);
        if (truncated) text += `\n… more rows than max_rows (${maxRows}): aggregate, filter or raise max_rows.`;
        const limit = args.max_chars ?? maxOutputChars;
        if (text.length > limit) text = `${text.slice(0, limit)}\n… [truncated: use pick, max_rows or a narrower query]`;
        return { text, isError: false, json: result };
      },
    },
  ];
}
