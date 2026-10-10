import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isExpired, jwtExpiry } from "../../src/auth.js";
import { checkPolicy, intentOf, previewRequest, RateLimiter } from "../../src/safety.js";
import { searchTools } from "../../src/server.js";
import { renderTemplate, summarizeEndpoint, validateMacro } from "../../src/tools/generate.js";
import { htmlToText, isChallenge } from "../../src/tools/http.js";

const jwt = (payload) => `Bearer eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

describe("safety", () => {
  const url = new URL("https://api.example.com/x");
  it("classifies intents", () => {
    assert.equal(intentOf("GET"), "read");
    assert.equal(intentOf("delete"), "delete");
    assert.equal(intentOf("PATCH"), "write");
  });

  it("applies read-only, host and confirmation policies", () => {
    assert.equal(checkPolicy({}, { intent: "read", url, confirmed: false }, "destructive"), null);
    assert.match(checkPolicy({}, { intent: "delete", url, confirmed: false }, "destructive")?.reason ?? "", /needs confirmation/);
    assert.equal(checkPolicy({}, { intent: "delete", url, confirmed: true }, "destructive"), null);
    assert.equal(checkPolicy({}, { intent: "write", url, confirmed: false }, "destructive"), null);
    assert.ok(checkPolicy({ confirm: "writes" }, { intent: "write", url, confirmed: false }, "none"));
    assert.equal(checkPolicy({ readOnly: true }, { intent: "write", url, confirmed: true }, "none")?.blocked, true);
    assert.equal(checkPolicy({ allowedHosts: ["example.com"] }, { intent: "read", url, confirmed: false }, "none"), null);
    assert.equal(checkPolicy({ allowedHosts: ["other.com"] }, { intent: "read", url, confirmed: false }, "none")?.blocked, true);
  });

  it("spaces requests per host", async () => {
    const limiter = new RateLimiter();
    const started = Date.now();
    for (let i = 0; i < 3; i++) await limiter.wait("h", 20);
    assert.ok(Date.now() - started >= 90, "3 requests at 20/s take at least ~100 ms");
    const other = Date.now();
    await limiter.wait("other-host", 20);
    assert.ok(Date.now() - other < 30, "other hosts are not delayed");
  });

  it("hides stored credentials in previews", () => {
    const text = previewRequest({ method: "POST", url: "https://h.test/a?token=t", headers: { authorization: "Bearer x", accept: "json" }, body: { a: 1 } }, ["authorization"]);
    assert.equal(text, 'POST https://h.test/a?token=REDACTED\nauthorization: <stored secret>\naccept: json\nBody: {"a":1}');
  });
});

describe("auth", () => {
  it("reads JWT expiry", () => {
    assert.equal(jwtExpiry(jwt({ exp: 1700000000 })), 1700000000);
    assert.equal(jwtExpiry("Bearer opaque-token"), null);
    assert.equal(isExpired(jwt({ exp: Math.floor(Date.now() / 1000) - 10 })), true);
    assert.equal(isExpired(jwt({ exp: Math.floor(Date.now() / 1000) + 3600 })), false);
    assert.equal(isExpired(undefined), false);
  });
});

describe("macros", () => {
  it("renders placeholders, keeping types for whole-value placeholders", () => {
    const scope = { params: { q: "lamp", n: 2 }, steps: { search: { results: [{ id: "a1" }] }, 0: { total: 3 } } };
    assert.deepEqual(renderTemplate({ query: { q: "{{params.q}}", n: "{{params.n}}" }, path: { id: "{{steps.search.results[0].id}}" }, text: "q={{params.q}} t={{steps.0.total}}" }, scope), {
      query: { q: "lamp", n: 2 }, path: { id: "a1" }, text: "q=lamp t=3",
    });
    assert.throws(() => renderTemplate("{{nope.x}}", scope), /Unknown placeholder root/);
  });

  it("validates definitions", () => {
    assert.throws(() => validateMacro({ id: "Bad Id", description: "x", steps: [{ tool: "t" }] }), /macro.id/);
    assert.throws(() => validateMacro({ id: "ok", description: "x", steps: [] }), /steps/);
    assert.throws(() => validateMacro({ id: "ok", description: "x", steps: [{ tool: "t" }], params: { confirm: {} } }), /invalid macro parameter/);
    assert.deepEqual(validateMacro({ id: "ok", description: " d ", steps: [{ tool: "t", extra: 1 }] }), { id: "ok", description: "d", params: {}, steps: [{ tool: "t" }] });
  });
});

describe("plain-language summaries", () => {
  const e = (method, pathTemplate, query = {}) => ({ method, pathTemplate, query });
  it("names endpoints by verb and resource", () => {
    assert.equal(summarizeEndpoint(e("GET", "/api/v1/crates/{crate}")), "Get one crate by crate");
    assert.equal(summarizeEndpoint(e("GET", "/api/products")), "List or get products");
    assert.equal(summarizeEndpoint(e("GET", "/api/search", { q: {} })), "Search");
    assert.equal(summarizeEndpoint(e("GET", "/api/products/{product}/reviews")), "List or get reviews of a product");
    assert.equal(summarizeEndpoint(e("POST", "/api/orders")), "Create or submit order");
    assert.equal(summarizeEndpoint(e("DELETE", "/api/orders/{order}")), "Delete a order by order");
  });
});

describe("responses", () => {
  const result = (status, contentType, body, headers = {}) => ({ status, statusText: "", contentType, body: Buffer.from(body), finalUrl: "https://x", headers });
  it("recognises bot challenges", () => {
    assert.equal(isChallenge(result(403, "text/html", "<title>Just a moment...</title>")), true);
    assert.equal(isChallenge(result(403, "application/json", "{}", { "cf-mitigated": "challenge" })), true);
    assert.equal(isChallenge(result(403, "application/json", '{"error":"forbidden"}')), false);
    assert.equal(isChallenge(result(200, "text/html", "captcha")), false);
  });

  it("turns HTML into readable text", () => {
    const text = htmlToText('<html><head><title>T</title><script>x()</script></head><body><h1>Hi</h1><p>A &amp; B</p><a href="/x">link</a><table><tr><td>a</td><td>b</td></tr></table></body></html>');
    assert.match(text, /^# T\n/);
    assert.match(text, /Hi\nA & B\nlink \[\/x\]/);
    assert.match(text, /\| a \| b/);
    assert.doesNotMatch(text, /x\(\)/);
  });
});

describe("tool search", () => {
  it("ranks name matches first", () => {
    const tools = [
      { name: "shop__get_api_orders", description: "List or get orders", inputSchema: {}, annotations: {}, run: async () => ({ text: "", isError: false }) },
      { name: "shop__get_api_products", description: "List or get products (see orders)", inputSchema: {}, annotations: {}, run: async () => ({ text: "", isError: false }) },
      { name: "pets__list_pets", description: "List pets", inputSchema: {}, annotations: {}, run: async () => ({ text: "", isError: false }) },
    ];
    assert.deepEqual(searchTools(tools, "orders").map((t) => t.name), ["shop__get_api_orders", "shop__get_api_products"]);
    assert.deepEqual(searchTools(tools, "list", "pets").map((t) => t.name), ["pets__list_pets"]);
  });
});

describe("audit regressions", () => {
  const makeEngine = async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Engine } = await import("../../src/core.js");
    const home = mkdtempSync(join(tmpdir(), "unwalled-audit-"));
    const config = /** @type {any} */ ({
      home, recipesDir: join(home, "recipes"), profilesDir: join(home, "profiles"), secretsDir: join(home, "secrets"), stateDir: join(home, "state"), auditFile: null,
      browser: "chrome", maxOutputChars: 40_000, requestTimeoutMs: 5000, maxEndpoints: 40, maxOpenApiTools: 60, confirm: "destructive", rateLimit: 0, toolMode: "all", toolThreshold: 60,
    });
    return { engine: new Engine(config), home, join };
  };

  it("never replays per-request headers such as Idempotency-Key", async () => {
    const { inferEndpoints } = await import("../../src/discovery/infer.js");
    const result = inferEndpoints([{ method: "POST", url: "https://api.x.test/orders", status: 201, requestHeaders: { "idempotency-key": "Zx81Lq0Wm3Np5Rt7Vb9Yc2Qa", traceparent: "00-abc-def-01", "x-app": "1" }, requestBody: "{}", responseJson: {} }]);
    assert.deepEqual(result.endpoints[0].headers, { "x-app": "1" });
    assert.deepEqual(result.secrets, {});
  });

  it("keeps the case of secret query parameter names", async () => {
    const { engine } = await makeEngine();
    assert.deepEqual(engine.setCredentials({ name: "x", host: "api.x.test", headers: { "?apiKey": "k", "X-Token": "t" } }), ["?apiKey", "x-token"]);
  });

  it("stores only the HAR file name and rebuilds form bodies exported as params", async () => {
    const { writeFileSync, readFileSync } = await import("node:fs");
    const { engine, home, join } = await makeEngine();
    const harPath = join(home, "private-folder-name.har");
    const entry = {
      _resourceType: "xhr",
      request: { method: "POST", url: "https://api.x.test/upload", headers: [], postData: { mimeType: "multipart/form-data; boundary=x", params: [{ name: "title", value: "t" }, { name: "doc", fileName: "a.pdf" }] } },
      response: { status: 200, content: { mimeType: "application/json", text: "{}" } },
    };
    writeFileSync(harPath, JSON.stringify({ log: { entries: [entry] } }));
    const recipe = await engine.discoverHar({ name: "h", harPath });
    assert.equal(recipe.source.harFile, "private-folder-name.har");
    assert.ok(!readFileSync(join(home, "recipes", "h.json"), "utf8").includes("unwalled-audit-"), "no local path in the recipe");
    assert.equal(recipe.endpoints[0].bodyKind, "multipart");
    assert.deepEqual(recipe.endpoints[0].fileFields, ["doc"]);
    const tool = engine.toolsOf("h").find((t) => t.name === "h__post_upload");
    assert.ok(tool?.inputSchema.properties.files, "the upload tool accepts files");
  });
});

describe("default arguments", () => {
  it("merges saved defaults one level deep, explicit arguments winning", async () => {
    const { mergeDefaults } = await import("../../src/tools/generate.js");
    assert.deepEqual(mergeDefaults({ query: { lang: "fr", page: 1 }, pick: "a" }, { query: { page: 2 } }), { query: { lang: "fr", page: 2 }, pick: "a" });
    assert.deepEqual(mergeDefaults({ tags: ["a"] }, { tags: ["b"] }), { tags: ["b"] });
    assert.deepEqual(mergeDefaults({ path: { id: "1" } }, {}), { path: { id: "1" } });
  });
});

describe("shared recipes cannot act on the user's behalf", () => {
  it("drops confirm, save_to and files from defaults and refuses them in macros", async () => {
    const { mergeDefaults, validateMacro } = await import("../../src/tools/generate.js");
    assert.deepEqual(mergeDefaults({ confirm: true, save_to: "/etc/x", files: { a: "/home/me/.ssh/id_rsa" }, url: "https://evil.test", query: { a: 1 } }, {}), { query: { a: 1 } });
    assert.throws(() => validateMacro({ id: "m", description: "d", steps: [{ tool: "t", args: { confirm: true } }] }), /cannot contain confirm/);
    assert.throws(() => validateMacro({ id: "m", description: "d", steps: [{ tool: "t", args: { files: {} } }] }), /cannot contain files/);
  });
});

describe("retries and cache", () => {
  it("retries reads on temporary failures, writes only when not processed", async () => {
    const { shouldRetry } = await import("../../src/safety.js");
    assert.equal(shouldRetry({ status: 503 }, null, "read"), true);
    assert.equal(shouldRetry({ status: 500 }, null, "read"), false);
    assert.equal(shouldRetry({ status: 503 }, null, "write"), false);
    assert.equal(shouldRetry({ status: 503, headers: { "retry-after": "1" } }, null, "write"), true);
    assert.equal(shouldRetry({ status: 429 }, null, "delete"), true);
    assert.equal(shouldRetry(null, new Error("fetch failed"), "read"), true);
    assert.equal(shouldRetry(null, new Error("fetch failed"), "write"), false);
  });

  it("waits Retry-After or an exponential backoff, at most 30 s", async () => {
    const { retryDelay } = await import("../../src/safety.js");
    assert.equal(retryDelay("2", 0), 2000);
    assert.equal(retryDelay("120", 0), 30_000);
    assert.ok(retryDelay(undefined, 0) >= 500 && retryDelay(undefined, 0) < 750);
    assert.ok(retryDelay(undefined, 3) >= 4000);
  });

  it("caches responses for their time to live, bounded in size", async () => {
    const { ResponseCache } = await import("../../src/safety.js");
    const cache = new ResponseCache(2);
    cache.set("a", { status: 200 });
    assert.equal(cache.get("a", 60)?.status, 200);
    assert.ok(cache.get("a", 60)?.cachedAgeMs >= 0);
    assert.equal(cache.get("a", 0), null, "expired");
    cache.set("a", { status: 200 });
    cache.set("b", { status: 200 });
    cache.set("c", { status: 200 });
    assert.equal(cache.get("a", 60), null, "oldest entry evicted");
    cache.clear("b");
    assert.equal(cache.get("b", 60), null);
  });
});

describe("robustness", () => {
  it("skips a malformed recipe instead of failing at startup", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Engine } = await import("../../src/core.js");
    const home = mkdtempSync(join(tmpdir(), "unwalled-bad-"));
    mkdirSync(join(home, "recipes"), { recursive: true });
    writeFileSync(join(home, "recipes", "bad.json"), JSON.stringify({ schemaVersion: 1, name: "bad", kind: "browser", baseUrl: "https://x.test" }));
    const config = /** @type {any} */ ({ home, recipesDir: join(home, "recipes"), profilesDir: join(home, "profiles"), secretsDir: join(home, "secrets"), stateDir: join(home, "state"), auditFile: null, maxOutputChars: 1000, requestTimeoutMs: 1000, maxEndpoints: 40, maxOpenApiTools: 60, confirm: "destructive", rateLimit: 0 });
    const engine = new Engine(config);
    assert.equal(engine.toolsOf("bad").length, 0);
  });
});
