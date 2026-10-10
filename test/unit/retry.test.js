import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { retryDelayMs, sendRequest } from "../../src/tools/http.js";

describe("retries", () => {
  it("computes delays from Retry-After or defaults", () => {
    assert.equal(retryDelayMs(undefined, 0), 500);
    assert.equal(retryDelayMs(undefined, 1), 1500);
    assert.equal(retryDelayMs("2", 0), 2000);
    assert.equal(retryDelayMs("3600", 0), null);
    assert.equal(retryDelayMs(new Date(10_000).toUTCString(), 0, 7_000), 3000);
  });

  /** @type {import("node:http").Server} */ let server;
  let base = "";
  const hits = { flaky: 0, busy: 0, post: 0 };
  before(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/flaky") {
        hits.flaky++;
        if (hits.flaky < 3) return res.writeHead(503, { "retry-after": "0" }).end();
        return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      }
      if (path === "/busy") {
        hits.busy++;
        return res.writeHead(429, { "retry-after": "120" }).end();
      }
      hits.post++;
      res.writeHead(503).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  });
  after(() => new Promise((resolve) => server.close(() => resolve(undefined))));

  it("retries idempotent requests until they succeed", async () => {
    const result = await sendRequest({ method: "GET", url: `${base}/flaky` }, { timeoutMs: 5000 });
    assert.equal(result.status, 200);
    assert.equal(hits.flaky, 3);
  });

  it("does not wait when the server asks for too long, and never retries POST", async () => {
    assert.equal((await sendRequest({ method: "GET", url: `${base}/busy` }, { timeoutMs: 5000 })).status, 429);
    assert.equal(hits.busy, 1);
    assert.equal((await sendRequest({ method: "POST", url: `${base}/post`, body: {} }, { timeoutMs: 5000 })).status, 503);
    assert.equal(hits.post, 1);
  });
});
