import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  graphqlOperationInfo, inferEndpoints, isTracker, looksLikeId, navigationVariables, parseBody, registrableDomain, splitHeaders,
} from "../../src/discovery/infer.js";

/**
 * @param {string} url @param {any} [responseJson] @param {Record<string, any>} [extra]
 * @returns {import("../../src/discovery/infer.js").Observation}
 */
const obs = (url, responseJson = { ok: true }, extra = {}) => ({ method: "GET", url, status: 200, requestHeaders: {}, requestBody: null, responseJson, ...extra });
const templates = (result) => result.endpoints.map((e) => `${e.method} ${e.pathTemplate}`).sort();

describe("helpers", () => {
  it("computes registrable domains", () => {
    assert.equal(registrableDomain("api.shop.example.com"), "example.com");
    assert.equal(registrableDomain("www.shop.co.uk"), "shop.co.uk");
    assert.equal(registrableDomain("127.0.0.1"), "127.0.0.1");
    assert.equal(registrableDomain("localhost"), "localhost");
  });

  it("recognises identifiers but not words or versions", () => {
    for (const id of ["42", "550e8400-e29b-41d4-a716-446655440000", "5f2b8c9a1d3e", "abc123def456ghi"]) assert.ok(looksLikeId(id), id);
    for (const word of ["users", "serde", "v2", "search", "site_metadata"]) assert.ok(!looksLikeId(word), word);
  });

  it("flags trackers", () => {
    assert.ok(isTracker("www.google-analytics.com"));
    assert.ok(isTracker("o123.ingest.sentry.io"));
    assert.ok(!isTracker("api.example.com"));
  });

  it("splits sensitive headers from reusable ones", () => {
    const { keep, secret } = splitHeaders(
      { authorization: "Bearer x", cookie: "a=1", "x-api-key": "k", "x-csrf-token": "c", "x-client-version": "3", accept: "application/json", "user-agent": "UA", ":method": "GET", ":authority": "x.com" },
      { secretCookies: false },
    );
    assert.deepEqual(keep, { "x-client-version": "3", accept: "application/json" });
    assert.deepEqual(secret, { authorization: "Bearer x", "x-api-key": "k", "x-csrf-token": "c" });
    assert.equal(splitHeaders({ cookie: "a=1" }, { secretCookies: true }).secret.cookie, "a=1");
  });

  it("parses bodies", () => {
    assert.deepEqual(parseBody('{"a":1}', "application/json"), { kind: "json", value: { a: 1 } });
    assert.deepEqual(parseBody("a=1&b=two", "application/x-www-form-urlencoded"), { kind: "form", value: { a: "1", b: "two" } });
    assert.equal(parseBody("plain", "text/plain").kind, "text");
    assert.equal(parseBody(null, "").kind, "none");
  });

  it("reads GraphQL operation types and names", () => {
    assert.deepEqual(graphqlOperationInfo("query GetUser($id: ID!) { user(id: $id) { id } }"), { type: "query", name: "GetUser" });
    assert.deepEqual(graphqlOperationInfo("# comment\nmutation { like }"), { type: "mutation", name: undefined });
    assert.deepEqual(graphqlOperationInfo("{ me { id } }"), { type: "query", name: undefined });
  });
});

describe("inferEndpoints — path templates", () => {
  it("turns ids into named parameters", () => {
    const result = inferEndpoints([obs("https://x.com/api/users/42"), obs("https://x.com/api/users/7/posts/550e8400-e29b-41d4-a716-446655440000")]);
    assert.deepEqual(templates(result), ["GET /api/users/{user}", "GET /api/users/{user}/posts/{post}"]);
    assert.deepEqual(result.endpoints.find((e) => e.pathParams.length === 2).pathParams, ["user", "post"]);
  });

  it("uses navigation values only after the matching parent segment", () => {
    const variables = navigationVariables(["https://crates.io/crates/serde", "https://crates.io/search?q=tokio"]);
    const result = inferEndpoints(
      [obs("https://crates.io/api/v1/crates/serde"), obs("https://crates.io/api/v1/search"), obs("https://crates.io/api/v1/keywords/tokio")],
      { variables },
    );
    assert.deepEqual(templates(result), ["GET /api/v1/crates/{crate}", "GET /api/v1/keywords/{keyword}", "GET /api/v1/search"]);
  });

  it("does not turn a page name into a parameter without the same parent", () => {
    const variables = navigationVariables(["https://x.com/search"]);
    assert.deepEqual(templates(inferEndpoints([obs("https://x.com/api/search")], { variables })), ["GET /api/search"]);
  });

  it("merges sibling resources that return the same shape", () => {
    const user = (name) => obs(`https://x.com/u/${name}`, { login: name, followers: 1 });
    assert.deepEqual(templates(inferEndpoints([user("alice"), user("bob"), user("carol")])), ["GET /u/{u}"]);
    // Only two names at the last position: not enough evidence.
    assert.equal(inferEndpoints([user("alice"), user("bob")]).endpoints.length, 2);
    // Different collections returning different shapes stay separate.
    const distinct = inferEndpoints([obs("https://x.com/api/crates", { crates: [] }), obs("https://x.com/api/summary", { total: 1 }), obs("https://x.com/api/categories", { categories: [] })]);
    assert.equal(distinct.endpoints.length, 3);
  });

  it("merges a varying middle segment with the same shape", () => {
    const result = inferEndpoints([obs("https://x.com/repos/acme/issues", [{ id: 1 }]), obs("https://x.com/repos/globex/issues", [{ id: 2 }])]);
    assert.deepEqual(templates(result), ["GET /repos/{repo}/issues"]);
    assert.equal(result.endpoints[0].observed, 2);
  });
});

describe("inferEndpoints — parameters, bodies, filtering", () => {
  it("types query parameters from observed values", () => {
    const result = inferEndpoints([obs("https://x.com/api/items?page=1&q=lamp&exact=true&ratio=0.5"), obs("https://x.com/api/items?page=2&q=desk")]);
    const { query } = result.endpoints[0];
    assert.deepEqual(
      Object.fromEntries(Object.entries(query).map(([k, v]) => [k, [v.type, v.seen]])),
      { page: ["integer", 2], q: ["string", 2], exact: ["boolean", 1], ratio: ["number", 1] },
    );
  });

  it("infers JSON and form request bodies", () => {
    const post = (body, type) => obs("https://x.com/api/cart", { id: 1 }, { method: "POST", requestBody: body, requestHeaders: { "content-type": type } });
    const json = inferEndpoints([post('{"sku":"A1","qty":2}', "application/json"), post('{"sku":"B2","qty":1,"note":"gift"}', "application/json")]);
    assert.equal(json.endpoints[0].bodyKind, "json");
    assert.deepEqual(json.endpoints[0].bodySchema.required, ["sku", "qty"]);
    assert.equal(json.endpoints[0].bodySchema.properties.qty.type, "integer");
    const form = inferEndpoints([post("a=1&b=2", "application/x-www-form-urlencoded")]);
    assert.equal(form.endpoints[0].bodyKind, "form");
  });

  it("drops failures, trackers and non-http URLs; keeps secrets per host", () => {
    const result = inferEndpoints([
      obs("https://x.com/api/ok", { a: 1 }, { requestHeaders: { authorization: "Bearer t", "x-app": "web" } }),
      obs("https://x.com/api/broken", { error: "x" }, { status: 500 }),
      obs("https://www.google-analytics.com/g/collect"),
      obs("data:application/json,{}"),
    ]);
    assert.deepEqual(templates(result), ["GET /api/ok"]);
    assert.deepEqual(result.secrets, { "x.com": { authorization: "Bearer t" } });
    assert.deepEqual(result.endpoints[0].headers, { "x-app": "web" });
  });

  it("caps the number of endpoints and warns", () => {
    const many = Array.from({ length: 12 }, (_, i) => obs(`https://x.com/api/r${"abcdefghijkl"[i]}`, { [`k${i}`]: i }));
    const result = inferEndpoints(many, { maxEndpoints: 5 });
    assert.equal(result.endpoints.length, 5);
    assert.match(result.warnings[0], /5 most frequent of 12/);
  });

  it("warns when nothing was observed", () => {
    assert.match(inferEndpoints([]).warnings[0], /No API call was observed/);
  });
});

describe("inferEndpoints — GraphQL", () => {
  const gql = (payload, response) =>
    obs("https://x.com/graphql", response, { method: "POST", requestBody: JSON.stringify(payload), requestHeaders: { "content-type": "application/json" } });

  it("extracts named operations with variable schemas", () => {
    const result = inferEndpoints([
      gql({ operationName: "GetCart", query: "query GetCart($id: ID!) { cart(id: $id) { total } }", variables: { id: "c1" } }, { data: { cart: { total: 3 } } }),
      gql({ operationName: "GetCart", query: "query GetCart($id: ID!) { cart(id: $id) { total } }", variables: { id: "c2" } }, { data: { cart: { total: 5 } } }),
      gql({ query: "mutation AddItem($sku: String!) { addItem(sku: $sku) }", variables: { sku: "A" } }, { data: { addItem: true } }),
    ]);
    assert.equal(result.endpoints.length, 0);
    const byName = Object.fromEntries(result.graphql.map((op) => [op.operationName, op]));
    assert.equal(byName.GetCart.observed, 2);
    assert.equal(byName.GetCart.operationType, "query");
    assert.deepEqual(byName.GetCart.variablesSchema.required, ["id"]);
    assert.equal(byName.AddItem.operationType, "mutation");
    assert.match(byName.GetCart.responseShape, /cart/);
  });

  it("handles batched and persisted queries", () => {
    const result = inferEndpoints([
      gql([{ operationName: "A", query: "query A { a }" }, { operationName: "B", query: "query B { b }" }], [{ data: { a: 1 } }, { data: { b: 2 } }]),
      gql({ operationName: "P", variables: {}, extensions: { persistedQuery: { version: 1, sha256Hash: "abc" } } }, { data: { p: 1 } }),
    ]);
    assert.deepEqual(result.graphql.map((op) => op.operationName).sort(), ["A", "B", "P"]);
    const persisted = result.graphql.find((op) => op.operationName === "P");
    assert.equal(persisted.query, null);
    assert.equal(persisted.extensions.persistedQuery.sha256Hash, "abc");
  });

  it("recognises GET GraphQL requests", () => {
    const url = `https://x.com/graphql?operationName=Feed&query=${encodeURIComponent("query Feed { feed { id } }")}&variables=${encodeURIComponent('{"n":3}')}`;
    const result = inferEndpoints([obs(url, { data: { feed: [] } })]);
    assert.equal(result.graphql[0].method, "GET");
    assert.equal(result.graphql[0].operationName, "Feed");
  });
});

describe("inferEndpoints — secrets never reach the recipe", () => {
  it("moves sensitive query parameters to secrets and redacts examples", () => {
    const result = inferEndpoints([
      obs("https://x.com/api/data?api_key=SECRET1&page=2"),
      obs("https://x.com/api/login", { ok: true }, { method: "POST", requestBody: '{"user":"bob","password":"hunter2","meta":{"session_token":"S3"}}', requestHeaders: { "content-type": "application/json" } }),
      obs("https://x.com/api/form", { ok: true }, { method: "POST", requestBody: "user=bob&password=hunter2", requestHeaders: { "content-type": "application/x-www-form-urlencoded" } }),
    ]);
    const serialized = JSON.stringify({ endpoints: result.endpoints, graphql: result.graphql });
    for (const secret of ["SECRET1", "hunter2", "S3"]) assert.ok(!serialized.includes(secret), `${secret} leaked`);
    assert.equal(result.secrets["x.com"]["?api_key"], "SECRET1");
    const data = result.endpoints.find((e) => e.pathTemplate === "/api/data");
    assert.deepEqual(Object.keys(data.query), ["page"]);
    assert.match(data.exampleUrl, /api_key=REDACTED/);
  });
});
