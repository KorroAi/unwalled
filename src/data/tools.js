// Tools of a local data recipe: "<recipe>__tables" (schema, row counts, samples) and "<recipe>__sql" (read-only SQL).
import { statSync } from "node:fs";
import { pick } from "../tools/pick.js";
import { connectMysql, mysqlTables } from "./mysql.js";
import { connectPostgres, postgresTables } from "./postgres.js";
import { assertReadOnly, dataFiles, describeTable, openData } from "./source.js";

/** Database engines: connection, table listing, and how the agent should write queries for them. */
const ENGINES = {
  postgres: { connect: connectPostgres, tables: postgresTables, label: "PostgreSQL", placeholders: "$1, $2..." },
  mysql: { connect: connectMysql, tables: mysqlTables, label: "MySQL / MariaDB", placeholders: "?" },
};

/** Open database connections by address, closed after a few idle minutes. @type {Map<string, { pg: Promise<any>, timer?: NodeJS.Timeout }>} */
const databases = new Map();

/** @param {string} url @param {keyof typeof ENGINES} [engine] */
async function dbConnection(url, engine = "postgres") {
  let entry = databases.get(url);
  if (!entry) {
    entry = { pg: ENGINES[engine].connect(url) };
    databases.set(url, entry);
    entry.pg.catch(() => databases.delete(url));
  }
  clearTimeout(entry.timer);
  const current = entry;
  current.timer = setTimeout(async () => {
    if (databases.get(url) === current) databases.delete(url);
    (await current.pg.catch(() => null))?.close();
  }, IDLE_MS);
  current.timer.unref?.();
  return current.pg;
}

/** Runs fn on a cached connection, reconnecting once if the connection was lost. @template T @param {string} url @param {(pg: any) => Promise<T>} fn @param {keyof typeof ENGINES} [engine] @returns {Promise<T>} */
function withDatabase(url, fn, engine = "postgres") {
  // One statement at a time per connection: the server answers in order, and parallel calls would mix their replies.
  const previous = queues.get(url) ?? Promise.resolve();
  const task = previous.then(async () => {
    try {
      return await fn(await dbConnection(url, engine));
    } catch (error) {
      if (!/connection closed|ECONNRESET|EPIPE|did not answer/i.test(String(error?.message))) throw error;
      const stale = databases.get(url);
      databases.delete(url);
      (await stale?.pg.catch(() => null))?.close();
      return fn(await dbConnection(url, engine));
    } finally {
      databases.get(url)?.timer?.refresh(); // idle time counts from the end of the statement
    }
  });
  const settled = task.then(() => {}, () => {});
  queues.set(url, settled);
  settled.then(() => queues.get(url) === settled && queues.delete(url));
  return task;
}

/** Last pending statement by address. @type {Map<string, Promise<void>>} */
const queues = new Map();

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
  for (const [url, entry] of databases) {
    databases.delete(url);
    clearTimeout(entry.timer);
    (await entry.pg.catch(() => null))?.close();
  }
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
 * @param {(recipe: any) => Promise<string>} [dataPath] where the data is (remote data is downloaded into a cache); for databases, their address
 */
export function buildDataTools(recipe, name, maxOutputChars, dataPath = async (r) => r.source.path) {
  if (recipe.source?.db === "postgres" || recipe.source?.db === "mysql") return databaseTools(recipe, name, maxOutputChars, dataPath);
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

/**
 * Tools of a database recipe (PostgreSQL, MySQL / MariaDB): same names and arguments as file data, queries run in READ ONLY transactions.
 * @param {any} recipe @param {(suffix: string) => string} name @param {number} maxOutputChars @param {(recipe: any) => Promise<string>} address
 */
function databaseTools(recipe, name, maxOutputChars, address) {
  const where = recipe.source.origin;
  const engine = /** @type {keyof typeof ENGINES} */ (recipe.source.db);
  const { label, placeholders } = ENGINES[engine];
  const summary = (recipe.tables ?? []).slice(0, 40).map((t) => `${t.name}(${t.columns.map((c) => c.name).slice(0, 10).join(", ")}${t.columns.length > 10 ? ", …" : ""})`).join("; ");
  return [
    {
      name: name("tables"),
      description: `[${recipe.name}] Tables and views of the ${label} database ${where}: columns, types and estimated row counts. ${summary}`.slice(0, 1200),
      inputSchema: { type: "object", properties: { table: { type: "string", description: "Only this table (schema.table outside public)." } } },
      annotations: { title: `${recipe.name} tables`, readOnlyHint: true, openWorldHint: true },
      /** @param {Record<string, any>} args */
      run: async (args) => {
        const tables = await withDatabase(await address(recipe), (db) => ENGINES[engine].tables(db), engine);
        const wanted = args.table ? tables.filter((t) => t.name === args.table) : tables;
        if (args.table && !wanted.length) return { text: `Unknown table "${args.table}". Tables: ${tables.map((t) => t.name).join(", ")}`, isError: true };
        return { text: JSON.stringify(wanted, null, 1).slice(0, maxOutputChars), isError: false };
      },
    },
    {
      name: name("sql"),
      description: (
        `[${recipe.name}] Read-only SQL (${label} dialect) on ${where}, inside a READ ONLY transaction with a statement timeout. Parameters: ${placeholders} Tables: ${summary}. ` +
        "Use aggregates and filters instead of reading everything."
      ).slice(0, 1200),
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "One SELECT / WITH / VALUES / EXPLAIN statement." },
          params: { type: "array", items: {}, description: `Values for ${placeholders}` },
          max_rows: { type: "integer", minimum: 1, maximum: 10_000, description: "Default 200." },
          timeout_seconds: { type: "integer", minimum: 1, maximum: 300, description: "Statement timeout (default 30)." },
          pick: { type: "string", description: 'Optional: keep only part of the result, e.g. "rows[*].name".' },
          max_chars: { type: "integer", minimum: 20 },
        },
        required: ["sql"],
      },
      annotations: { title: `${recipe.name} SQL`, readOnlyHint: true, openWorldHint: true },
      /** @param {Record<string, any>} args */
      run: async (args) => {
        let sql;
        try {
          sql = assertReadOnly(String(args.sql ?? ""));
        } catch (error) {
          return { text: error.message, isError: true };
        }
        const maxRows = Math.min(Math.max(Number(args.max_rows ?? 200), 1), 10_000);
        let result;
        try {
          result = await withDatabase(
            await address(recipe),
            (db) => db.query(sql, Array.isArray(args.params) ? args.params : [], { maxRows, statementTimeoutMs: Math.min(Math.max(Number(args.timeout_seconds ?? 30), 1), 300) * 1000 }),
            engine,
          );
        } catch (error) {
          return { text: `SQL error: ${error.message}`, isError: true };
        }
        let text = JSON.stringify(args.pick ? pick(result, args.pick) : result);
        if (result.truncated) text += `\n… more rows than max_rows (${maxRows}): aggregate, filter or raise max_rows.`;
        const limit = args.max_chars ?? maxOutputChars;
        if (text.length > limit) text = `${text.slice(0, limit)}\n… [truncated: use pick, max_rows or a narrower query]`;
        return { text, isError: false, json: result };
      },
    },
  ];
}
