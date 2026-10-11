// Real MySQL or MariaDB server. Skipped unless UNWALLED_MYSQL_URL is set, e.g. a throwaway container:
//   docker run -d --name umcp-mysql -e MYSQL_ROOT_PASSWORD=secret -e MYSQL_DATABASE=shop -p 127.0.0.1::3306 mysql:8.4
//   UNWALLED_MYSQL_URL="mysql://root:secret@127.0.0.1:<port>/shop" node --test test/live/mysql.test.js
// It only reads (no table needed).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { connectMysql } from "../../src/data/mysql.js";

const url = process.env.UNWALLED_MYSQL_URL;

describe("MySQL / MariaDB data source", { skip: !url && "set UNWALLED_MYSQL_URL to run" }, () => {
  let home, engine;
  before(async () => {
    home = mkdtempSync(join(tmpdir(), "umcp-mysql-"));
    process.env.UNWALLED_HOME = home;
    const { loadConfig } = await import("../../src/config.js");
    const { Engine } = await import("../../src/core.js");
    engine = new Engine(loadConfig());
  });
  after(async () => {
    await engine?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  it("connects, converts types, binds parameters and only reads", async () => {
    const db = await connectMysql(String(url));
    try {
      const { rows } = await db.query("SELECT 1 AS i, CAST(10 AS DECIMAL(5,0)) AS d, 2.5 AS f, CAST(TRUE AS SIGNED) AS b, JSON_OBJECT('a', 1) AS j, NULL AS z, ? AS p", [String.raw`it's a \ test`]);
      // MariaDB's JSON is an alias of LONGTEXT: its values arrive as text.
      const row = { ...rows[0], j: typeof rows[0].j === "string" ? JSON.parse(rows[0].j) : rows[0].j };
      assert.deepEqual(row, { i: 1, d: 10, f: 2.5, b: 1, j: { a: 1 }, z: null, p: String.raw`it's a \ test` });
      await assert.rejects(db.query("CREATE TABLE umcp_should_not_exist (a INT)"), /Only read statements/);
      // Even a reading statement cannot write: the session is read-only (a SELECT ... INTO OUTFILE or a function call would be refused).
      const tables = await db.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'umcp_should_not_exist'");
      assert.equal(tables.rows[0].n, 0, "nothing was created");
      const limited = await db.query("WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 50) SELECT n FROM s", [], { maxRows: 5 });
      assert.equal(limited.rows.length, 5);
      assert.equal(limited.truncated, true);
    } finally {
      db.close();
    }
  });

  it("becomes a recipe whose address stays out of the shared file", async () => {
    const recipe = await engine.importFile({ name: "my", path: String(url) });
    assert.equal(recipe.source.db, "mysql");
    const password = decodeURIComponent(new URL(String(url)).password);
    if (password) assert.ok(!readFileSync(join(home, "recipes", "my.json"), "utf8").includes(password));
    const sql = /** @type {any} */ (engine.tools.get("my__sql"));
    const result = await sql.run({ sql: "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", params: ["information_schema"] });
    assert.equal(result.isError, false, result.text);
    assert.ok(JSON.parse(result.text.split("\n")[0]).rows[0].n > 10);
    assert.equal((await sql.run({ sql: "DELETE FROM x" })).isError, true);
  });
});
