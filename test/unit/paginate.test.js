import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { buildTools } from "../../src/tools/generate.js";
import { sendRequest } from "../../src/tools/http.js";
import { findItems, findNext, nextPage } from "../../src/tools/paginate.js";

const ALL = Array.from({ length: 23 }, (_, i) => ({ id: i + 1, name: `item ${i + 1}` }));

describe("pagination helpers", () => {
  it("finds the item list", () => {
    assert.deepEqual(findItems([1, 2], undefined), { items: [1, 2], path: "" });
    assert.equal(findItems({ meta: { tags: [1, 2, 3, 4] }, data: { items: [1] } }, undefined).path, "data.items");
    assert.equal(findItems({ results: [], other: 1 }, undefined).path, "results");
    assert.equal(findItems({ a: 1 }, undefined).items, null);
  });
  it("finds next tokens and URLs", () => {
    assert.deepEqual(findNext({ nextPageToken: "abc", items: [] }).next, { key: "nextPageToken", value: "abc" });
    assert.deepEqual(findNext({ links: { next: { href: "/x?page=2" } } }).next, { key: "next", value: "/x?page=2" });
    assert.equal(findNext({ has_more: false, data: [] }).hasMore, false);
  });
  it("chooses the next request", () => {
    assert.deepEqual(nextPage({ nextPageToken: "t2" }, { q: "a" }, 5), { query: { q: "a", pageToken: "t2" } });
    assert.deepEqual(nextPage({ next_cursor: "c2" }, { cursor: "c1" }, 5), { query: { cursor: "c2" } });
    assert.deepEqual(nextPage({ pageInfo: { endCursor: "e1" } }, {}, 5), { query: { after: "e1" } });
    assert.deepEqual(nextPage({ next: "https://api.x.io/items?page=2" }, {}, 5), { url: "https://api.x.io/items?page=2" });
    assert.deepEqual(nextPage([1, 2], { page: "1" }, 2), { query: { page: 2 } });
    assert.deepEqual(nextPage([1, 2], { offset: 0, limit: 2 }, 2), { query: { offset: 2, limit: 2 } });
    assert.ok("stop" in nextPage([], { page: 3 }, 0));
    assert.ok("stop" in nextPage({ has_more: false, nextPageToken: "x" }, {}, 3));
  });
});

describe("paginated tools against a local API", () => {
  let server, base;
  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const json = (body) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const size = 10;
      if (url.pathname === "/token") {
        const start = Number(url.searchParams.get("pageToken") ?? 0);
        const next = start + size < ALL.length ? String(start + size) : undefined;
        return json({ kind: "list", items: ALL.slice(start, start + size), ...(next ? { nextPageToken: next } : {}) });
      }
      if (url.pathname === "/links") {
        const page = Number(url.searchParams.get("page") ?? 1);
        const items = ALL.slice((page - 1) * size, page * size);
        return json({ data: items, links: { next: page * size < ALL.length ? `/links?page=${page + 1}` : null } });
      }
      if (url.pathname === "/pages") {
        const page = Number(url.searchParams.get("page") ?? 1);
        return json(ALL.slice((page - 1) * size, page * size));
      }
      if (url.pathname === "/offset") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return json({ total: ALL.length, results: ALL.slice(offset, offset + size) });
      }
      res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  const tools = () => {
    const operation = (id, path, params) => ({ id, method: "GET", path, summary: "", params: params.map((name) => ({ name, in: "query", required: false, schema: { type: "string" } })), body: null });
    const recipe = {
      name: "api", kind: "openapi", baseUrl: base, routes: [],
      operations: [operation("token", "/token", ["pageToken"]), operation("links", "/links", ["page"]), operation("pages", "/pages", ["page"]), operation("offset", "/offset", ["offset"])],
    };
    const runtime = { maxOutputChars: 100_000, send: (_recipe, request) => sendRequest(request, { timeoutMs: 5000 }) };
    return new Map(buildTools(recipe, runtime).map((t) => [t.name, t]));
  };

  /** @type {[string, Record<string, number>][]} */ const cases = [["api__token", {}], ["api__links", {}], ["api__pages", { page: 1 }], ["api__offset", { offset: 0 }]];
  for (const [name, query] of cases) {
    it(`merges every page (${name})`, async () => {
      const tool = /** @type {any} */ (tools().get(name));
      assert.ok(tool.inputSchema.properties.paginate);
      const result = await tool.run({ query, paginate: { max_pages: 10 }, pick: "id" });
      assert.equal(result.isError, false, result.text);
      const [header, body] = result.text.split("\n");
      assert.deepEqual(JSON.parse(body), ALL.map((item) => item.id), header);
    });
  }

  it("respects max_items and keeps the plain call when paginate is absent", async () => {
    const tool = /** @type {any} */ (tools().get("api__token"));
    const limited = await tool.run({ paginate: { max_items: 12 } });
    assert.match(limited.text, /12 item\(s\)[\s\S]*max_items/);
    const plain = await tool.run({});
    assert.match(plain.text, /^HTTP 200/);
  });
});
