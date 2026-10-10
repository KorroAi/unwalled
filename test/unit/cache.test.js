import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearCache, withCache } from "../../src/tools/cache.js";

describe("tool cache", () => {
  const makeTool = () => {
    let calls = 0;
    let fail = false;
    const tool = withCache(
      { name: "t__get", description: "", inputSchema: { type: "object", properties: {} }, annotations: {}, run: async () => ({ text: `call ${++calls}`, isError: fail }) },
      { now: () => clock },
    );
    return { tool, calls: () => calls, setFail: (v) => (fail = v) };
  };
  let clock = 0;

  it("reuses identical calls within cache_seconds, whatever the key order", async () => {
    clearCache();
    const { tool, calls } = makeTool();
    assert.ok(tool.inputSchema.properties.cache_seconds);
    assert.equal((await tool.run({ query: { a: 1, b: 2 }, cache_seconds: 60 })).text, "call 1");
    clock = 30_000;
    assert.match((await tool.run({ cache_seconds: 60, query: { b: 2, a: 1 } })).text, /^\(cached 30s ago\)\ncall 1$/);
    assert.equal((await tool.run({ query: { a: 1, b: 3 }, cache_seconds: 60 })).text, "call 2");
    clock = 61_000;
    assert.equal((await tool.run({ query: { a: 1, b: 2 }, cache_seconds: 60 })).text, "call 3");
    assert.equal((await tool.run({ query: { a: 1, b: 2 } })).text, "call 4", "no cache without cache_seconds");
    assert.equal(calls(), 4);
  });

  it("never caches errors", async () => {
    clearCache();
    clock = 0;
    const { tool, setFail } = makeTool();
    setFail(true);
    await tool.run({ cache_seconds: 60 });
    setFail(false);
    assert.equal((await tool.run({ cache_seconds: 60 })).text, "call 2");
  });
});
