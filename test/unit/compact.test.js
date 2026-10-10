import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactTool } from "../../src/tools/compact.js";
import { buildTools } from "../../src/tools/generate.js";

const deepBody = {
  type: "object",
  properties: Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [
      `field${i}`,
      { type: "object", description: "x".repeat(400), properties: { inner: { type: "object", properties: { deeper: { type: "string", enum: Array.from({ length: 50 }, (_, j) => `v${j}`) } } } } },
    ]),
  ),
};

describe("schema compaction", () => {
  it("keeps small tools as they are", () => {
    const tool = { description: "Small.", inputSchema: { type: "object", properties: { q: { type: "string" } } } };
    assert.deepEqual(compactTool(tool, 3000), { ...tool, compacted: false });
  });

  it("shrinks large schemas under the budget while keeping top-level parameters", () => {
    const tool = { description: "d".repeat(1200), inputSchema: { type: "object", properties: { body: deepBody, pick: { type: "string" } } } };
    const before = JSON.stringify(tool).length;
    const { description, inputSchema, compacted } = compactTool(tool, 3000);
    const after = description.length + JSON.stringify(inputSchema).length;
    assert.equal(compacted, true);
    assert.ok(after <= 3000, `${before} -> ${after}`);
    assert.deepEqual(Object.keys(inputSchema.properties), ["body", "pick"]);
    assert.match(inputSchema.properties.body.description, /fields: field0, field1, .*field29/, "the body's fields are still named");
  });
});

describe("compact mode", () => {
  const operation = (i) => ({ id: `op_${i}`, method: i % 2 ? "GET" : "DELETE", path: `/things/${i}`, summary: `Operation number ${i}. More words.`, params: [], body: null });
  const make = (count, threshold) => {
    const calls = [];
    const recipe = { name: "big", kind: "openapi", baseUrl: "https://big.io", routes: [], operations: Array.from({ length: count }, (_, i) => operation(i)) };
    const runtime = { maxOutputChars: 10_000, foldThreshold: threshold, send: async (_r, request) => (calls.push(request), { status: 200, statusText: "OK", contentType: "application/json", body: Buffer.from('{"ok":true}'), finalUrl: request.url }) };
    return { tools: new Map(buildTools(recipe, runtime).map((t) => [t.name, t])), calls };
  };

  it("is used above the threshold only", () => {
    assert.ok(make(5, 20).tools.has("big__op_3"));
    const { tools } = make(25, 20);
    assert.deepEqual([...tools.keys()].sort(), ["big__call", "big__operation", "big__request", "big__routes"]);
    assert.ok(make(25, 0).tools.has("big__op_3"), "0 disables compact mode");
  });

  it("lists, describes and calls folded operations", async () => {
    const { tools, calls } = make(25, 20);
    const listing = await tools.get("big__operation").run({ filter: "number 1" });
    assert.match(listing.text, /^op_1 — .*Operation number 1\./m);
    const described = await tools.get("big__operation").run({ operation: "op_4" });
    assert.match(described.text, /\(may change data, destructive\)/);
    assert.match(described.text, /"pick"/);
    const result = await tools.get("big__call").run({ operation: "op_3", arguments: { pick: "ok" } });
    assert.equal(result.text.split("\n")[1], "true");
    assert.equal(calls.at(-1).url, "https://big.io/things/3");
    assert.equal((await tools.get("big__call").run({ operation: "nope" })).isError, true);
    assert.equal(tools.get("big__call").annotations.destructiveHint, true);
  });
});
