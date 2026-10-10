// Cases found by capturing real sites (here: the Hacker News search, which calls Algolia).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferEndpoints, isTracker } from "../../src/discovery/infer.js";
import { constantQueryDefaults } from "../../src/tools/generate.js";

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
});
