import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bindParameters } from "../../src/data/mysql.js";

describe("MySQL parameters", () => {
  it("replaces ? outside strings, identifiers and comments, and escapes values", () => {
    assert.equal(bindParameters("SELECT ?, ?, ?, ?", ["a'b\\c", 42, null, true]), String.raw`SELECT 'a''b\\c', 42, NULL, 1`);
    assert.equal(bindParameters("SELECT '?' AS q, `we?ird` , ? -- ?\n, ? /* ? */", ["x", "y"]), "SELECT '?' AS q, `we?ird` , 'x' -- ?\n, 'y' /* ? */");
    assert.equal(bindParameters("SELECT ? # ?", [{ a: 1 }]), `SELECT '{"a":1}' # ?`);
    assert.equal(bindParameters("SELECT ?", ["line\nbreak\0nul"]), String.raw`SELECT 'line\nbreak\0nul'`);
  });

  it("refuses missing, extra or non-finite parameters", () => {
    assert.throws(() => bindParameters("SELECT ?, ?", [1]), /Missing value for parameter 2/);
    assert.throws(() => bindParameters("SELECT ?", [1, 2]), /2 parameters given, 1 placeholders/);
    assert.throws(() => bindParameters("SELECT ?", [Number.NaN]), /finite numbers/);
  });
});

describe("read statements", () => {
  it("lets only reading statements through", async () => {
    const { assertReadStatement } = await import("../../src/data/mysql.js");
    for (const sql of ["SELECT 1", "  /* c */ with x as (select 1) select * from x", "-- note\nSHOW TABLES", "EXPLAIN SELECT 1", "DESCRIBE t"]) assert.doesNotThrow(() => assertReadStatement(sql), sql);
    for (const sql of ["CREATE TABLE t (a INT)", "DROP TABLE t", "/* SELECT */ DELETE FROM t", "SET GLOBAL x = 1", "CALL p()", "LOAD DATA INFILE 'x' INTO TABLE t"]) assert.throws(() => assertReadStatement(sql), /Only read statements/, sql);
  });
});
