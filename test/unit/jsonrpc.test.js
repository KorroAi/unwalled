import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { inferJsonRpc } from "../../src/discovery/jsonrpc.js";

describe("JSON-RPC inference", () => {
  it("groups calls by method, including batches, and flags RPC-only endpoints", () => {
    const { methods, rpcUrls } = inferJsonRpc([
      {
        method: "POST", url: "https://node.io/rpc?apikey=s3cret", status: 200, requestHeaders: {},
        requestBody: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }, { jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: ["0xabc", "latest"] }]),
        responseJson: [{ jsonrpc: "2.0", id: 2, result: "0x10" }, { jsonrpc: "2.0", id: 1, result: "0x99" }],
      },
      { method: "POST", url: "https://node.io/rpc?apikey=s3cret", status: 200, requestHeaders: {}, requestBody: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "eth_blockNumber", params: [] }), responseJson: { jsonrpc: "2.0", id: 3, result: "0x9a" } },
      { method: "POST", url: "https://node.io/other", status: 200, requestHeaders: {}, requestBody: '{"a":1}', responseJson: {} },
    ]);
    assert.deepEqual(methods.map((m) => [m.method, m.observed, m.paramsKind, m.url]), [
      ["eth_blockNumber", 2, "array", "https://node.io/rpc"],
      ["eth_getBalance", 1, "array", "https://node.io/rpc"],
    ]);
    assert.equal(methods[1].resultShape, "string");
    assert.deepEqual([...rpcUrls], ["https://node.io/rpc"]);
  });
});

describe("JSON-RPC tools", () => {
  let home, engine, server, base;
  const seen = [];
  before(async () => {
    server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const url = new URL(req.url ?? "/", "http://x");
      if (url.searchParams.get("key") !== "k-777") return res.writeHead(401).end();
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.push(body);
      const answer = (call) => ({
        jsonrpc: "2.0", id: call.id,
        ...(call.method === "items.list" ? { result: { items: [{ id: 1, name: "lamp" }, { id: 2, name: "chair" }].slice(0, call.params?.limit ?? 10) } } : call.method === "sum" ? { result: call.params.reduce((a, b) => a + b, 0) } : { error: { code: -32601, message: "Method not found" } }),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
    home = mkdtempSync(join(tmpdir(), "umcp-rpc-"));
    process.env.UNIVERSAL_MCP_HOME = home;
    const { loadConfig } = await import("../../src/config.js");
    const { Engine } = await import("../../src/core.js");
    engine = new Engine(loadConfig());
  });
  after(async () => {
    await engine?.close();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    rmSync(home, { recursive: true, force: true });
  });

  it("creates one tool per method, keeps the API key out of the recipe and adds it back when calling", async () => {
    const recipe = await engine.importCurl({
      name: "rpc",
      commands: [
        `curl '${base}/rpc?key=k-777' -H 'content-type: application/json' --data-raw '{"jsonrpc":"2.0","id":1,"method":"items.list","params":{"limit":1}}'`,
        `curl '${base}/rpc?key=k-777' -H 'content-type: application/json' --data-raw '{"jsonrpc":"2.0","id":2,"method":"sum","params":[1,2]}'`,
      ],
    });
    assert.equal(recipe.endpoints.length, 0, "the generic POST /rpc endpoint is replaced by the methods");
    assert.deepEqual(recipe.jsonrpc.map((m) => m.method), ["items.list", "sum"]);
    assert.ok(!readFileSync(join(home, "recipes", "rpc.json"), "utf8").includes("k-777"));
    const names = engine.toolsOf("rpc").map((t) => t.name);
    assert.ok(names.includes("rpc__rpc_items_list") && names.includes("rpc__rpc_sum") && names.includes("rpc__rpc"), names.join(", "));

    const list = await engine.tools.get("rpc__rpc_items_list").run({ params: { limit: 2 }, pick: "result.items[*].name" });
    assert.equal(list.isError, false, list.text);
    assert.deepEqual(JSON.parse(list.text.split("\n").slice(1).join("")), ["lamp", "chair"]);
    const sum = await engine.tools.get("rpc__rpc_sum").run({ params: [4, 5, 6], pick: "result" });
    assert.equal(sum.text.split("\n")[1], "15");
    const generic = await engine.tools.get("rpc__rpc").run({ method: "nope" });
    assert.match(generic.text, /Method not found/);
    assert.deepEqual(seen.at(-1), { jsonrpc: "2.0", id: 3, method: "nope" });
  });
});
