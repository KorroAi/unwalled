// Cases found by capturing real sites (here: the Hacker News search, which calls Algolia).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferEndpoints, isTracker } from "../../src/discovery/infer.js";
import { constantQueryDefaults, isSearchEndpoint, nestFlatArguments, probeArgs, toolNamer } from "../../src/tools/generate.js";

const obs = (method, url, body, responseJson) => ({ method, url, status: 200, requestHeaders: { "content-type": "application/json" }, requestBody: body, responseJson });

describe("inference on real-world traffic", () => {
  const { endpoints, graphql } = inferEndpoints([
    obs("POST", "https://abc-dsn.algolia.net/1/indexes/Item_dev/query", JSON.stringify({ query: "model context protocol", hitsPerPage: 20 }), { hits: [{ title: "x" }] }),
    obs("GET", "https://telemetry.algolia.com/1/settings?applications=abc", null, { ok: true }),
    obs("GET", "https://t5-in-1.algolia.net/1/isalive?probe=1", null, { message: "server is alive" }),
    obs("POST", "https://api.shop.io/graphql", JSON.stringify({ query: "query GetCart($id: ID!) { cart(id: $id) { id } }", variables: { id: "c1" } }), { data: {} }),
    obs("POST", "https://api.shop.io/graphql", JSON.stringify({ query: "{ me { id } }" }), { data: {} }),
  ]);

  it("does not mistake a search body with a query field for GraphQL", () => {
    assert.deepEqual(graphql.map((op) => op.operationName ?? "(anonymous)").sort(), ["(anonymous)", "GetCart"]);
    assert.ok(graphql.every((op) => op.url === "https://api.shop.io/graphql"));
    assert.ok(endpoints.some((e) => e.method === "POST" && e.origin === "https://abc-dsn.algolia.net"));
  });

  it("keeps a leading API version number literal", () => {
    const search = endpoints.find((e) => e.origin === "https://abc-dsn.algolia.net");
    assert.equal(search?.pathTemplate.startsWith("/1/indexes/"), true, search?.pathTemplate);
  });

  it("drops telemetry hosts and availability probes", () => {
    assert.equal(isTracker("telemetry.algolia.com"), true);
    assert.equal(isTracker("api.algolia.com"), false);
    assert.ok(!endpoints.some((e) => /telemetry|isalive/.test(`${e.origin}${e.pathTemplate}`)), JSON.stringify(endpoints.map((e) => e.pathTemplate)));
  });

  it("sends constant technical query parameters by default", () => {
    const defaults = constantQueryDefaults(
      {
        "x-algolia-agent": { example: "Algolia for JavaScript (4.0)", seen: 2, values: ["Algolia for JavaScript (4.0)"] },
        "x-algolia-application-id": { example: "UJ5WYC0L7X", seen: 2, values: ["UJ5WYC0L7X"] },
        q: { example: "rust", seen: 2, values: ["rust"] },
        locale: { example: "fr", seen: 1, values: ["fr"] },
        format: { example: "json", seen: 2, values: ["json", "csv"] },
      },
      2,
    );
    assert.deepEqual(defaults, { "x-algolia-agent": "Algolia for JavaScript (4.0)", "x-algolia-application-id": "UJ5WYC0L7X" });
  });

  it("health checks replay the query parameters seen on every call (found on MDN and Bluesky)", () => {
    const endpoint = {
      pathParams: [], observed: 2,
      query: {
        q: { example: "fetch", seen: 2 },
        actor: { example: "bsky.app", seen: 2 },
        page: { example: "2", seen: 1 },
        token: { example: "REDACTED", seen: 2 },
        long: { example: "abc…", seen: 2 },
      },
    };
    assert.deepEqual(probeArgs(endpoint), { query: { q: "fetch", actor: "bsky.app" } });
    assert.deepEqual(probeArgs({ pathParams: ["id"], pathExamples: { id: "7" }, observed: 1, query: {} }), { path: { id: "7" } });
  });

  it("drops error reporting and event logging sent to the site's own hosts (archive.org, Docker Hub)", () => {
    const { endpoints } = inferEndpoints([
      obs("POST", "https://sink.archive.org/api/2/envelope/?sentry_version=7&sentry_key=abc", "{}", { id: "1" }),
      obs("POST", "https://sessions-bugsnag.docker.com/", "{}", { ok: true }),
      obs("POST", "https://marlin-2.docker.com/docker.marlin.v1.LogService/LogEvents", "x", { ok: true }),
      obs("POST", "https://www.example.org/cdn-cgi/challenge-platform/h/g/fo/1/2", "x", { ok: true }),
      obs("POST", "https://stackoverflow.com/questions/tagged/node.js?__cf_chl_tk=abc", "md=x", undefined),
      obs("GET", "https://archive.org/services/search/beta/page_production/?user_query=apollo", null, { response: { body: { hits: [] } } }),
    ]);
    assert.deepEqual(endpoints.map((e) => e.origin + e.pathTemplate), ["https://archive.org/services/search/beta/page_production/"]);
    assert.equal(isTracker("api.sentry.io"), true);
    assert.equal(isTracker("sentryhq-docs.example.com"), false);
  });

  it("long tool names keep the verb and the end of the path, which tell tools apart (found on GitHub)", () => {
    const name = toolNamer("github");
    const a = name("get_/modelcontextprotocol/modelcontextprotocol/param2/deferred");
    const b = name("get_/modelcontextprotocol/modelcontextprotocol/param2/views.json");
    assert.match(a, /^github__get_modelcontextprotocol_param2_deferred_[0-9a-f]{6}$/);
    assert.match(b, /^github__get_.*_views_json_[0-9a-f]{6}$/);
    assert.ok(a.length <= 64 && b.length <= 64);
  });

  it("accepts path and query values passed at the top level (seen with a real agent)", () => {
    const endpoint = { method: "GET", pathParams: ["order"], query: { status: { example: "paid", seen: 1 } } };
    assert.deepEqual(nestFlatArguments({ order: "1042", status: "open", pick: "total" }, endpoint), { path: { order: "1042" }, query: { status: "open" }, pick: "total" });
    assert.deepEqual(nestFlatArguments({ order: "1", path: { order: "2" } }, endpoint), { path: { order: "2" }, query: {} });
    const post = { method: "POST", pathParams: [], query: {} };
    assert.deepEqual(nestFlatArguments({ title: "x", body: { a: 1 } }, post), { title: "x", body: { a: 1 } });
  });

  it("keeps a short webhook token in a path out of the recipe", () => {
    const { endpoints, secrets } = inferEndpoints([obs("POST", "https://chat.example.com/hooks/abc123", JSON.stringify({ text: "hi" }), { ok: true })]);
    const hook = endpoints.find((e) => e.pathTemplate.startsWith("/hooks/"));
    assert.ok(hook, JSON.stringify(endpoints.map((e) => e.pathTemplate)));
    assert.deepEqual(hook.secretPathParams?.length, 1);
    assert.ok(!JSON.stringify(endpoints).includes("abc123"));
    assert.ok(JSON.stringify(secrets["chat.example.com"]).includes("abc123"));
  });

  it("a plain value for \"query\" is the site's own query parameter (Grafana's search)", () => {
    const endpoint = { method: "GET", pathParams: [], query: { query: { example: "x", seen: 1 }, limit: { example: "10", seen: 1 } } };
    assert.deepEqual(nestFlatArguments({ query: "Revenue", limit: 5 }, endpoint), { query: { query: "Revenue", limit: 5 }, path: {} });
    assert.deepEqual(nestFlatArguments({ query: { query: "x" } }, endpoint), { query: { query: "x" } });
  });

  it("remembers which endpoints were called with a secret query parameter (Algolia's key on Hacker News)", () => {
    const { endpoints, secrets } = inferEndpoints([
      obs("POST", "https://abc-dsn.algolia.net/1/indexes/Item_dev/query?x-algolia-api-key=fake0key0for0tests0aaaaaaaaaaaa1&x-algolia-application-id=ABC", "{}", { hits: [] }),
      obs("GET", "https://archive.test/config.php?key=feature.flag", null, { on: true }),
      obs("GET", "https://archive.test/search?q=x", null, { hits: [] }),
    ]);
    const byPath = Object.fromEntries(endpoints.map((e) => [e.pathTemplate, e.secretQuery]));
    assert.deepEqual(byPath["/1/indexes/Item_dev/query"], ["x-algolia-api-key"]);
    assert.deepEqual(byPath["/config.php"], ["key"]);
    assert.deepEqual(byPath["/search"], []);
    assert.equal(secrets["abc-dsn.algolia.net"]["?x-algolia-api-key"], "fake0key0for0tests0aaaaaaaaaaaa1");
  });

  it("treats a POST to a search path as a read (Algolia, Elasticsearch, Flathub), so read-only policies allow it", () => {
    for (const path of ["/1/indexes/Item_dev/query", "/api/v2/search", "/products/_search"]) assert.equal(isSearchEndpoint({ method: "POST", pathTemplate: path, bodyKind: "json" }), true, path);
    for (const path of ["/api/orders", "/api/search/{id}/delete"]) assert.equal(isSearchEndpoint({ method: "POST", pathTemplate: path, bodyKind: "json" }), false, path);
    assert.equal(isSearchEndpoint({ method: "DELETE", pathTemplate: "/search", bodyKind: "none" }), false);
  });
});
