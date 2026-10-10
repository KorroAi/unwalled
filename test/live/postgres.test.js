// Real PostgreSQL server. Skipped unless UNWALLED_PG_URL is set, e.g. a throwaway container:
//   docker run -d --name umcp-pg -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=shop -p 127.0.0.1::5432 postgres:17
//   UNWALLED_PG_URL="postgres://postgres:secret@127.0.0.1:<port>/shop" node --test test/live/postgres.test.js
// It only reads (system catalogs), so any database works.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { connectPostgres } from "../../src/data/postgres.js";

const url = process.env.UNWALLED_PG_URL;

describe("PostgreSQL data source", { skip: !url && "set UNWALLED_PG_URL to run" }, () => {
  let home, engine;
  before(async () => {
    home = mkdtempSync(join(tmpdir(), "umcp-pg-"));
    process.env.UNWALLED_HOME = home;
    const { loadConfig } = await import("../../src/config.js");
    const { Engine } = await import("../../src/core.js");
    engine = new Engine(loadConfig());
  });
  after(async () => {
    await engine?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("connects (TLS when offered, SCRAM), converts types and only reads", async () => {
    const pg = await connectPostgres(String(url));
    try {
      const { rows } = await pg.query("SELECT 1::int AS i, 10::numeric AS n, 2.5::float8 AS f, true AS b, '{\"a\":1}'::jsonb AS j, NULL::text AS z, 9007199254740993::bigint AS big");
      assert.deepEqual(rows, [{ i: 1, n: 10, f: 2.5, b: true, j: { a: 1 }, z: null, big: "9007199254740993" }]);
      await assert.rejects(pg.query("CREATE TABLE umcp_should_not_exist (a int)"), /Only read statements/);
      await assert.rejects(pg.query("WITH x AS (SELECT 1) SELECT * INTO umcp_should_not_exist FROM x"), /read-only transaction/);
      await assert.rejects(pg.query("SELECT pg_sleep(3)", [], { statementTimeoutMs: 1000 }), /statement timeout/);
      const limited = await pg.query("SELECT generate_series(1, 50) AS n", [], { maxRows: 5 });
      assert.equal(limited.rows.length, 5);
      assert.equal(limited.truncated, true);
      const param = await pg.query("SELECT $1::text || '!' AS s, $2::int + 1 AS n", ["hi", 41]);
      assert.deepEqual(param.rows, [{ s: "hi!", n: 42 }]);
    } finally {
      pg.close();
    }
  });

  it("becomes a recipe whose address stays out of the shared file", async () => {
    const recipe = await engine.importFile({ name: "db", path: String(url) });
    assert.equal(recipe.source.db, "postgres");
    const password = decodeURIComponent(new URL(String(url)).password);
    if (password) assert.ok(!readFileSync(join(home, "recipes", "db.json"), "utf8").includes(password), "the password stays out of the recipe");
    const sql = /** @type {any} */ (engine.tools.get("db__sql"));
    const result = await sql.run({ sql: "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1", params: ["pg_catalog"] });
    assert.equal(result.isError, false, result.text);
    assert.ok(JSON.parse(result.text.split("\n")[0]).rows[0].n > 10);
    const write = await sql.run({ sql: "WITH x AS (SELECT 1) INSERT INTO pg_temp.t SELECT 1 FROM x" });
    assert.equal(write.isError, true);
    assert.equal((await sql.run({ sql: "DELETE FROM x" })).isError, true);
  });
});
