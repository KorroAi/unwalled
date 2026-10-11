// Local data as SQL tables: CSV / TSV, JSON (array of records, or an object of arrays), JSON Lines, SQLite databases,
// and folders of such files (one table per file). Queries are read-only.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parseCsv } from "../tools/formats.js";
import { readFeed, readIcs, readXlsx } from "./formats.js";

export const DATA_EXTENSIONS = /\.(csv|tsv|json|jsonl|ndjson|sqlite|sqlite3|db|xlsx|ics|rss|atom|xml)$/i;
const MAX_ROWS = 1_000_000;
const MAX_FILE_BYTES = 500 * 1024 * 1024;

/** node:sqlite ships with Node 22.5+ (without flag from Node 23.4 / 24). */
async function sqlite() {
  try {
    return await import("node:sqlite");
  } catch {
    throw new Error(`Local data needs node:sqlite (Node.js 22.5 or newer; Node ${process.versions.node} here).`);
  }
}

/** @param {string} name */
export const tableName = (name) => basename(name, extname(name)).replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^(\d)/, "_$1").replace(/^_+$/, "data") || "data";

/** @param {string} name */
const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** Column types from values: INTEGER, REAL or TEXT. @param {unknown[]} values */
function columnType(values) {
  let type = "INTEGER";
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "number") {
      if (!Number.isInteger(value)) type = "REAL";
      continue;
    }
    if (typeof value === "boolean") continue;
    if (typeof value !== "string") return "TEXT";
    // A leading zero is part of the value ("01234" postal codes, "007" references): a number would drop it.
    if (/^-?0\d/.test(value)) return "TEXT";
    if (/^-?\d{1,15}$/.test(value)) continue;
    if (/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(value)) type = "REAL";
    else return "TEXT";
  }
  return type;
}

/** @param {unknown} value @param {string} type */
function toSql(value, type) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  if (type === "INTEGER" || type === "REAL") return Number(value);
  return String(value);
}

/**
 * Records of one file, keyed by table name.
 * @param {string} file @returns {Record<string, Record<string, unknown>[]>}
 */
export function readRecords(file) {
  const size = statSync(file).size;
  if (size > MAX_FILE_BYTES) throw new Error(`${file} is too large (${size} bytes, limit ${MAX_FILE_BYTES}).`);
  const name = tableName(file);
  const ext = extname(file).toLowerCase();
  // Excel: one table per sheet; iCalendar: events (and to-dos).
  if (ext === ".xlsx") {
    const sheets = Object.entries(readXlsx(readFileSync(file)));
    /** @type {Record<string, Record<string, unknown>[]>} */ const tables = {};
    for (const [sheet, rows] of sheets) {
      // Sheets whose names give the same table name ("Q1 2026", "Q1-2026") must not overwrite each other.
      let table = sheets.length === 1 ? name : tableName(sheet);
      for (let n = 2; table in tables; n++) table = `${tableName(sheet)}_${n}`;
      tables[table] = rows;
    }
    return tables;
  }
  const text = readFileSync(file, "utf8").replace(/^﻿/, "");
  if (ext === ".ics") return readIcs(text);
  if (ext === ".rss" || ext === ".atom" || ext === ".xml") {
    const items = readFeed(text);
    if (!items) throw new Error(`${file} is XML but not an RSS or Atom feed.`);
    return { [name]: items };
  }
  if (ext === ".csv" || ext === ".tsv") return { [name]: parseCsv(text) };
  if (ext === ".jsonl" || ext === ".ndjson") {
    return { [name]: text.split(/\r?\n/).filter((l) => l.trim()).map((line, i) => {
      try {
        const value = JSON.parse(line);
        return value && typeof value === "object" && !Array.isArray(value) ? value : { value };
      } catch {
        throw new Error(`${file}: line ${i + 1} is not valid JSON.`);
      }
    }) };
  }
  const json = JSON.parse(text);
  const asRecords = (/** @type {unknown[]} */ list) => list.map((item) => (item && typeof item === "object" && !Array.isArray(item) ? /** @type {Record<string, unknown>} */ (item) : { value: item }));
  if (Array.isArray(json)) return { [name]: asRecords(json) };
  if (json && typeof json === "object") {
    // {"users": [...], "orders": [...]} gives one table per array; anything else is a single row.
    const arrays = Object.entries(json).filter(([, v]) => Array.isArray(v) && v.length);
    if (arrays.length) return Object.fromEntries(arrays.map(([key, v]) => [tableName(key), asRecords(/** @type {unknown[]} */ (v))]));
    return { [name]: [json] };
  }
  return { [name]: [{ value: json }] };
}

/** Files of a data source (one file, or the data files of a folder). @param {string} path */
export function dataFiles(path) {
  if (statSync(path).isDirectory()) {
    // In folders, generic .xml files (configuration, sitemaps...) are not taken as data: only .rss / .atom feeds.
    const files = readdirSync(path).filter((f) => DATA_EXTENSIONS.test(f) && !/\.xml$/i.test(f)).sort().map((f) => join(path, f));
    if (!files.length) throw new Error(`No data file (CSV, TSV, JSON, JSON Lines, SQLite) in ${path}.`);
    return files;
  }
  if (!DATA_EXTENSIONS.test(path)) throw new Error(`Not a data file: ${path}`);
  return [path];
}

/** By extension, or by the 16-byte header (only the header is read). @param {string} file */
function isSqliteFile(file) {
  if (/\.(sqlite|sqlite3|db)$/i.test(file)) return true;
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(16);
    readSync(fd, header, 0, 16, 0);
    return header.toString("latin1") === "SQLite format 3\u0000";
  } finally {
    closeSync(fd);
  }
}

/**
 * Opens a data source as a read-only SQLite connection. Text files are loaded into an in-memory database.
 * @param {string} path file or folder
 * @returns {Promise<{ db: any, tables: string[], close: () => void }>}
 */
export async function openData(path) {
  const { DatabaseSync } = await sqlite();
  const files = dataFiles(path);
  if (files.length === 1 && isSqliteFile(files[0])) {
    const db = new DatabaseSync(files[0], { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => String(r.name));
    return { db, tables, close: () => db.close() };
  }
  const db = new DatabaseSync(":memory:");
  const tables = [];
  for (const file of files) {
    if (isSqliteFile(file)) {
      // A database inside a folder is attached under its file name.
      db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS ${quote(tableName(file))}`);
      continue;
    }
    for (const [table, records] of Object.entries(readRecords(file))) {
      if (records.length > MAX_ROWS) throw new Error(`${file}: more than ${MAX_ROWS} rows.`);
      const columns = [...new Set(records.flatMap((r) => Object.keys(r)))];
      if (!columns.length) continue;
      const types = Object.fromEntries(columns.map((c) => [c, columnType(records.slice(0, 5000).map((r) => r[c]))]));
      let unique = table;
      for (let n = 2; tables.includes(unique); n++) unique = `${table}_${n}`;
      db.exec(`CREATE TABLE ${quote(unique)} (${columns.map((c) => `${quote(c)} ${types[c]}`).join(", ")})`);
      const insert = db.prepare(`INSERT INTO ${quote(unique)} VALUES (${columns.map(() => "?").join(", ")})`);
      db.exec("BEGIN");
      for (const record of records) insert.run(...columns.map((c) => toSql(record[c], types[c])));
      db.exec("COMMIT");
      tables.push(unique);
    }
  }
  db.exec("PRAGMA query_only = ON");
  return { db, tables, close: () => db.close() };
}

/** @param {any} db @param {string} table */
export function describeTable(db, table) {
  const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map((c) => ({ name: String(c.name), type: String(c.type || "ANY") }));
  const rows = Number(db.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get().n);
  const sample = db.prepare(`SELECT * FROM ${quote(table)} LIMIT 3`).all().map((r) => ({ ...r }));
  return { name: table, columns, rows, sample };
}

/** Only one read statement: SELECT, WITH ... SELECT, EXPLAIN, or PRAGMA table_info. @param {string} sql */
export function assertReadOnly(sql) {
  const text = sql.trim().replace(/;+\s*$/, "");
  if (/;/.test(text.replace(/'[^']*'|"[^"]*"/g, ""))) throw new Error("Send a single SQL statement.");
  if (!/^(select|with|explain|pragma\s+table_info|values)\b/i.test(text)) throw new Error("Only read queries are allowed (SELECT, WITH, EXPLAIN, VALUES).");
  return text;
}
