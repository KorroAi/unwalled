import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { assertReadOnly, readRecords } from "../../src/data/source.js";

describe("local data parsing", () => {
  let dir;
  before(() => (dir = mkdtempSync(join(tmpdir(), "umcp-data-"))));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("reads CSV, JSON Lines and JSON objects of arrays", () => {
    writeFileSync(join(dir, "sales 2026.csv"), "id,product,amount\n1,lamp,12.5\n2,chair,40\n");
    assert.deepEqual(readRecords(join(dir, "sales 2026.csv")), { sales_2026: [{ id: "1", product: "lamp", amount: "12.5" }, { id: "2", product: "chair", amount: "40" }] });
    writeFileSync(join(dir, "events.jsonl"), '{"t":1,"kind":"click"}\n\n{"t":2,"kind":"view"}\n');
    assert.equal(readRecords(join(dir, "events.jsonl")).events.length, 2);
    writeFileSync(join(dir, "shop.json"), JSON.stringify({ users: [{ id: 1 }], orders: [{ id: 9, user: 1 }], meta: { v: 1 } }));
    assert.deepEqual(Object.keys(readRecords(join(dir, "shop.json"))), ["users", "orders"]);
  });

  it("only accepts single read statements", () => {
    assert.equal(assertReadOnly("SELECT 1;"), "SELECT 1");
    assert.equal(assertReadOnly("with x as (select 1) select * from x"), "with x as (select 1) select * from x");
    assert.throws(() => assertReadOnly("DELETE FROM t"), /Only read queries/);
    assert.throws(() => assertReadOnly("SELECT 1; DROP TABLE t"), /single SQL statement/);
    assert.throws(() => assertReadOnly("ATTACH DATABASE 'x' AS y"), /Only read queries/);
    assert.doesNotThrow(() => assertReadOnly("SELECT 'a;b'"));
  });
});

describe("local data recipes", () => {
  let home, dir, engine;
  before(async () => {
    home = mkdtempSync(join(tmpdir(), "umcp-datahome-"));
    dir = join(home, "files");
    mkdirSync(dir);
    process.env.UNIVERSAL_MCP_HOME = home;
    const { loadConfig } = await import("../../src/config.js");
    const { Engine } = await import("../../src/core.js");
    engine = new Engine(loadConfig());
  });
  after(async () => {
    await engine?.close();
    rmSync(home, { recursive: true, force: true });
  });

  const sql = async (recipe, query, extra = {}) => {
    const result = await /** @type {any} */ (engine.tools.get(`${recipe}__sql`)).run({ sql: query, ...extra });
    return { ...result, data: result.isError ? null : JSON.parse(result.text.split("\n")[0]) };
  };

  it("queries a CSV file with typed columns and aggregates", async () => {
    const file = join(dir, "trades.csv");
    writeFileSync(file, "symbol,side,price,qty\nBTC,buy,60000,0.5\nBTC,sell,61000,0.2\nETH,buy,3000,2\n");
    const recipe = await engine.importFile({ name: "trades", path: file });
    assert.equal(recipe.kind, "data");
    assert.deepEqual(recipe.tables[0].columns.map((c) => `${c.name}:${c.type}`), ["symbol:TEXT", "side:TEXT", "price:INTEGER", "qty:REAL"]);
    const total = await sql("trades", "SELECT symbol, sum(price * qty) AS notional FROM trades GROUP BY symbol ORDER BY symbol");
    assert.deepEqual(total.data.rows, [{ symbol: "BTC", notional: 42200 }, { symbol: "ETH", notional: 6000 }]);
    const param = await sql("trades", "SELECT count(*) AS n FROM trades WHERE price > ?", { params: [10000] });
    assert.equal(param.data.rows[0].n, 2);
  });

  it("refuses writes, including writes hidden in a WITH clause", async () => {
    assert.equal((await sql("trades", "DELETE FROM trades")).isError, true);
    const hidden = await sql("trades", "WITH x AS (SELECT 1) INSERT INTO trades(symbol) SELECT 'X' FROM x");
    assert.equal(hidden.isError, true, "query_only must block it");
    assert.equal((await sql("trades", "SELECT count(*) AS n FROM trades")).data.rows[0].n, 3);
  });

  it("reloads the data when the file changes", async () => {
    const file = join(dir, "trades.csv");
    writeFileSync(file, "symbol,side,price,qty\nSOL,buy,150,10\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    assert.equal((await sql("trades", "SELECT symbol FROM trades")).data.rows[0].symbol, "SOL");
  });

  it("opens SQLite databases read-only and folders of files as several tables", async () => {
    const dbFile = join(dir, "app.sqlite");
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users (name) VALUES ('ada'), ('linus');");
    db.close();
    const recipe = await engine.importFile({ name: "app", path: dbFile });
    assert.deepEqual(recipe.tables.map((t) => [t.name, t.rows]), [["users", 2]]);
    assert.deepEqual((await sql("app", "SELECT name FROM users ORDER BY id")).data.rows, [{ name: "ada" }, { name: "linus" }]);
    assert.equal((await sql("app", "WITH x AS (SELECT 1) INSERT INTO users(name) SELECT 'eve' FROM x")).isError, true);

    const folder = join(dir, "export");
    mkdirSync(folder);
    writeFileSync(join(folder, "customers.csv"), "id,name\n1,Acme\n2,Globex\n");
    writeFileSync(join(folder, "orders.json"), JSON.stringify([{ id: 10, customer: 1, total: 99.5 }, { id: 11, customer: 1, total: 0.5 }]));
    await engine.importFile({ name: "export", path: folder });
    const joined = await sql("export", "SELECT c.name, sum(o.total) AS spent FROM orders o JOIN customers c ON c.id = o.customer GROUP BY c.name");
    assert.deepEqual(joined.data.rows, [{ name: "Acme", spent: 100 }]);
    const tables = await /** @type {any} */ (engine.tools.get("export__tables")).run({});
    assert.match(tables.text, /"customers"[\s\S]*"orders"/);
  });

  it("treats a JSON file as data only when it is not an API description", async () => {
    const records = join(dir, "prices.json");
    writeFileSync(records, JSON.stringify([{ day: "2026-10-01", close: 61000 }, { day: "2026-10-02", close: 62500 }]));
    assert.equal((await engine.importFile({ name: "prices", path: records })).kind, "data");
    const spec = join(dir, "openapi.json");
    writeFileSync(spec, JSON.stringify({ openapi: "3.0.0", info: { title: "x", version: "1" }, servers: [{ url: "https://x.io" }], paths: { "/a": { get: { operationId: "getA" } } } }));
    assert.equal((await engine.importFile({ name: "spec", path: spec })).kind, "openapi");
  });
});
