import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import YAML from "yaml";
import { observationsFromHar } from "../../src/discovery/har.js";
import { normalizeOpenApi, resolveBaseUrl } from "../../src/discovery/openapi.js";
import { buildTools, toolNamer } from "../../src/tools/generate.js";
import { formatResponse } from "../../src/tools/http.js";

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

describe("OpenAPI normalization", () => {
  const spec = YAML.parse(fixture("petstore.yaml"));

  it("resolves the base URL from servers, relative to the spec URL", () => {
    assert.equal(resolveBaseUrl(spec, "http://localhost:9000/openapi.yaml"), "http://localhost:9000/v1");
    assert.equal(resolveBaseUrl({ swagger: "2.0", host: "api.x.com", basePath: "/v2/", schemes: ["https"] }, "http://a/b.json"), "https://api.x.com/v2");
    assert.equal(resolveBaseUrl({ openapi: "3.0.0", paths: {} }, "https://docs.x.com/spec.json"), "https://docs.x.com");
  });

  it("dereferences parameters and bodies", () => {
    const { operations, routes } = normalizeOpenApi(spec, "http://localhost:9000/openapi.yaml");
    assert.equal(routes.length, 4);
    const getPet = operations.find((o) => o.id === "get_pet");
    assert.deepEqual(getPet.params.map((p) => [p.in, p.name, p.required]), [["path", "petId", true]]);
    const create = operations.find((o) => o.id === "create_pet");
    assert.equal(create.body.schema.properties.name.type, "string");
    assert.deepEqual(create.body.schema.required, ["name"]);
    assert.ok(!operations.some((o) => o.id === "old_endpoint"), "deprecated operations are skipped");
  });

  it("filters operations and reports the rest", () => {
    const { operations, warnings } = normalizeOpenApi(spec, "http://x/openapi.yaml", { include: "^list" });
    assert.deepEqual(operations.map((o) => o.id), ["list_pets"]);
    assert.match(warnings[0], /4 operations in total, 1 became tools/);
  });
});

describe("HAR import", () => {
  it("keeps API calls, decodes base64 bodies and finds the base URL", () => {
    const { observations, baseUrl, pageUrls } = observationsFromHar(fixture("sample.har"));
    assert.equal(baseUrl, "https://api.example.com");
    assert.deepEqual(observations.map((o) => `${o.method} ${new URL(o.url).pathname}`), ["GET /v1/items", "GET /v1/items/1234", "POST /v1/items"]);
    assert.deepEqual(observations[1].responseJson, { id: 1234, name: "Lamp" });
    assert.equal(observations[0].requestHeaders.authorization, "Bearer secret-token");
    assert.ok(pageUrls.includes("https://example.com/shop"));
  });

  it("filters by host and rejects invalid files", () => {
    assert.equal(observationsFromHar(fixture("sample.har"), { hosts: ["other.com"] }).observations.length, 0);
    assert.throws(() => observationsFromHar("{}"), /log.entries/);
    assert.throws(() => observationsFromHar("nope"), /Not a valid HAR/);
  });
});

describe("tool generation", () => {
  it("creates unique, valid, bounded names", () => {
    const name = toolNamer("shop");
    const long = name("x".repeat(100));
    assert.ok(long.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(long));
    assert.notEqual(name("get_items"), name("get_items"));
    assert.equal(name("get /api/{id}!"), "shop__get_api_id");
  });

  it("builds REST tools that fill path and query parameters", async () => {
    const sent = [];
    const recipe = {
      name: "shop", kind: "har", baseUrl: "https://api.x.com",
      endpoints: [{
        kind: "rest", method: "GET", origin: "https://api.x.com", pathTemplate: "/items/{item}", pathParams: ["item"],
        query: { lang: { type: "string", example: "en", seen: 1 } }, bodyKind: "none", bodySchema: null, bodyExample: null,
        headers: { "x-app": "1" }, responseShape: "{ id: integer }", exampleUrl: "https://api.x.com/items/1", observed: 1,
      }],
      graphql: [],
    };
    const runtime = {
      maxOutputChars: 1000,
      send: async (_recipe, request) => {
        sent.push(request);
        return { status: 200, statusText: "OK", contentType: "application/json", body: Buffer.from('{"id":7,"name":"Desk"}'), finalUrl: request.url };
      },
    };
    const tools = buildTools(recipe, runtime);
    assert.deepEqual(tools.map((t) => t.name), ["shop__get_items_item", "shop__request"]);
    const tool = tools[0];
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.deepEqual(tool.inputSchema.required, ["path"]);
    const result = await tool.run({ path: { item: "a b" }, query: { lang: "fr" }, pick: "name" });
    assert.equal(sent[0].url, "https://api.x.com/items/a%20b?lang=fr");
    assert.deepEqual(sent[0].headers, { "x-app": "1" });
    assert.match(result.text, /"Desk"/);
    await assert.rejects(tool.run({ path: {} }), /Missing path parameter/);
  });
});

describe("formatResponse", () => {
  const response = (status, body, contentType = "application/json") => ({ status, statusText: "", contentType, body: Buffer.from(body), finalUrl: "https://x/y" });

  it("truncates long bodies and flags errors with a hint", () => {
    const long = formatResponse(response(200, JSON.stringify({ a: "x".repeat(500) })), { maxChars: 100 });
    assert.match(long.text, /truncated/);
    const denied = formatResponse(response(401, '{"error":"no"}'), { maxChars: 1000 });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /login tool/);
  });

  it("describes binary bodies and reports empty picks", () => {
    assert.match(formatResponse(response(200, "\u0000\u0001", "image/png"), { maxChars: 100 }).text, /binary body/);
    assert.match(formatResponse(response(200, '{"a":1}'), { maxChars: 100, pick: "b" }).text, /matched nothing/);
  });
});

describe("safeSchema", () => {
  it("removes property names Claude's API would reject, keeping them usable", async () => {
    const { safeSchema } = await import("../../src/tools/generate.js");
    const schema = safeSchema({
      type: "object",
      properties: { "page[size]": { type: "integer" }, ok_name: { type: "object", properties: { "a b": { type: "string" }, c: { type: "string" } }, required: ["a b", "c"] } },
      required: ["page[size]"],
    });
    assert.deepEqual(Object.keys(schema.properties), ["ok_name"]);
    assert.equal(schema.required, undefined);
    assert.equal(schema.additionalProperties, true);
    assert.match(schema.description, /"page\[size\]"/);
    assert.deepEqual(schema.properties.ok_name.required, ["c"]);
  });

  it("is applied to every generated tool", () => {
    const recipe = {
      name: "q", kind: "har", baseUrl: "https://x.com", graphql: [],
      endpoints: [{ kind: "rest", method: "GET", origin: "https://x.com", pathTemplate: "/s", pathParams: [], query: { "filter[status]": { type: "string", example: "a", seen: 1 } },
        bodyKind: "none", bodySchema: null, bodyExample: null, headers: {}, responseShape: "", exampleUrl: "https://x.com/s", observed: 1 }],
    };
    const [tool] = buildTools(recipe, { maxOutputChars: 100, send: async () => { throw new Error("unused"); } });
    const query = tool.inputSchema.properties.query;
    assert.deepEqual(Object.keys(query.properties), []);
    assert.equal(query.additionalProperties, true);
    assert.match(query.description, /filter\[status\]/);
  });
});
