import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { insomniaToOpenApi, postmanToOpenApi } from "../../src/discovery/collections.js";
import { describeFile } from "../../src/discovery/files.js";
import { normalizeOpenApi } from "../../src/discovery/openapi.js";
import { startFixtureServers } from "../e2e/fixture-servers.js";

const postman = (baseUrl) => ({
  info: { _postman_id: "1", name: "Pets", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  variable: [{ key: "baseUrl", value: baseUrl }],
  item: [
    {
      name: "Pets",
      item: [
        { name: "List pets", request: { method: "GET", url: { raw: "{{baseUrl}}/v1/pets?limit=1", query: [{ key: "limit", value: "1" }, { key: "old", value: "x", disabled: true }] } } },
        { name: "Get pet", request: { method: "GET", url: { raw: "{{baseUrl}}/v1/pets/:petId", variable: [{ key: "petId", value: "1" }] } } },
        {
          name: "Create pet",
          request: { method: "POST", header: [{ key: "Content-Type", value: "application/json" }], body: { mode: "raw", raw: '{"name":"Rex","age":3}', options: { raw: { language: "json" } } }, url: "{{baseUrl}}/v1/pets" },
        },
      ],
    },
    { name: "Elsewhere", request: { method: "GET", url: "https://other.example.com/x" } },
  ],
});

describe("collections", () => {
  it("converts a Postman collection: folders, :params, query, JSON body, foreign hosts", () => {
    const { spec, warnings } = postmanToOpenApi(postman("https://api.example.com"));
    const { baseUrl, operations } = normalizeOpenApi(spec, "https://api.example.com");
    assert.equal(baseUrl, "https://api.example.com");
    assert.deepEqual(operations.map((o) => `${o.method} ${o.path} ${o.id}`), ["GET /v1/pets pets_list_pets", "POST /v1/pets pets_create_pet", "GET /v1/pets/{petId} pets_get_pet"]);
    assert.deepEqual(operations[0].params.map((p) => p.name), ["limit"]);
    assert.equal(/** @type {any} */ (operations[1]).body.schema.properties.age.type, "integer");
    assert.match(warnings.join(" "), /other\.example\.com/);
  });

  it("keeps passwords and keys of a collection's examples out of the descriptions", () => {
    const { spec } = postmanToOpenApi({
      info: { _postman_id: "x", name: "Login" },
      item: [{
        name: "Sign in",
        request: {
          method: "POST",
          url: { raw: "https://api.test/login?api_key=k3y-value-123&page=2", query: [{ key: "api_key", value: "k3y-value-123" }, { key: "page", value: "2" }] },
          body: { mode: "raw", raw: '{"user":"alice","password":"hunter22"}', options: { raw: { language: "json" } } },
        },
      }],
    });
    const text = JSON.stringify(spec);
    assert.doesNotMatch(text, /hunter22|k3y-value-123/);
    assert.match(text, /"user\\":\\"alice/);
    assert.match(text, /Example: 2/);
  });

  it("converts an Insomnia export with environment variables", () => {
    const doc = {
      _type: "export", __export_format: 4,
      resources: [
        { _id: "wrk", _type: "workspace", name: "Shop" },
        { _id: "env", _type: "environment", data: { base: "https://shop.example.com/api" } },
        { _id: "fld", _type: "request_group", name: "Orders", parentId: "wrk" },
        { _id: "r1", _type: "request", parentId: "fld", name: "Get order", method: "GET", url: "{{ _.base }}/orders/{{ orderId }}", parameters: [{ name: "expand", value: "items" }] },
        { _id: "r2", _type: "request", parentId: "fld", name: "Create order", method: "POST", url: "{{ _.base }}/orders", body: { mimeType: "application/json", text: '{"sku":"a1"}' } },
      ],
    };
    const { spec } = insomniaToOpenApi(doc);
    const { baseUrl, operations } = normalizeOpenApi(spec, spec.servers[0].url);
    assert.equal(baseUrl, "https://shop.example.com");
    assert.deepEqual(operations.map((o) => `${o.method} ${o.path} ${o.id}`), ["GET /api/orders/{orderId} orders_get_order", "POST /api/orders orders_create_order"]);
    assert.deepEqual(operations[0].params.map((p) => `${p.in}:${p.name}`), ["path:orderId", "query:expand"]);
  });

  it("detects file formats", () => {
    assert.equal(describeFile(JSON.stringify({ log: { entries: [] } })).format, "har");
    assert.equal(describeFile("openapi: 3.0.0\npaths: {}\ninfo: {title: x}\n").format, "openapi");
    assert.equal(describeFile(JSON.stringify(postman("https://a.io"))).format, "postman");
    assert.throws(() => describeFile('{"hello": 1}'), /Unrecognised file/);
  });
});

describe("import_file through the engine", () => {
  let home, fixtures, engine;
  before(async () => {
    home = mkdtempSync(join(tmpdir(), "umcp-import-"));
    process.env.UNWALLED_HOME = home;
    fixtures = await startFixtureServers();
    const { loadConfig } = await import("../../src/config.js");
    const { Engine } = await import("../../src/core.js");
    engine = new Engine(loadConfig());
  });
  after(async () => {
    await engine?.close();
    await fixtures?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  it("imports a Postman collection and calls its tools", async () => {
    const file = join(home, "pets.postman_collection.json");
    writeFileSync(file, JSON.stringify(postman("{{baseUrl}}")));
    const incomplete = await engine.importFile({ name: "pets", path: file });
    assert.match(incomplete.warnings.join(" "), /incomplete/);
    const recipe = await engine.importFile({ name: "pets", path: file, variables: { baseUrl: fixtures.petsUrl } });
    assert.equal(recipe.baseUrl, fixtures.petsUrl);
    assert.equal(recipe.source.format, "postman");
    const list = await engine.tools.get("pets__pets_list_pets").run({ query: { limit: 1 } });
    assert.match(list.text, /HTTP 200[\s\S]*Rex/);
    const one = await engine.tools.get("pets__pets_get_pet").run({ path: { petId: "7" } });
    assert.match(one.text, /Pet 7/);
    engine.setCredentials({ name: "pets", host: new URL(fixtures.petsUrl).host, headers: { "x-api-key": "k1" } });
    const created = await engine.tools.get("pets__pets_create_pet").run({ body: { name: "Tom" } });
    assert.match(created.text, /HTTP 201[\s\S]*Tom/);
  });

  it("imports a Bruno collection folder with its environment", async () => {
    const dir = join(home, "pets-bruno");
    mkdirSync(join(dir, "environments"), { recursive: true });
    mkdirSync(join(dir, "Pets"));
    writeFileSync(join(dir, "bruno.json"), JSON.stringify({ version: "1", name: "Pets API", type: "collection" }));
    writeFileSync(join(dir, "environments", "local.bru"), `vars {\n  host: ${fixtures.petsUrl}\n}\n`);
    writeFileSync(join(dir, "environments", "prod.bru"), "vars {\n  host: https://pets.example.com\n}\n");
    writeFileSync(
      join(dir, "Pets", "List pets.bru"),
      "meta {\n  name: List pets\n  type: http\n  seq: 1\n}\n\nget {\n  url: {{host}}/v1/pets?limit=1\n  body: none\n  auth: none\n}\n\nparams:query {\n  limit: 1\n  ~old: x\n}\n",
    );
    writeFileSync(
      join(dir, "Pets", "Create pet.bru"),
      'meta {\n  name: Create pet\n  type: http\n  seq: 2\n}\n\npost {\n  url: {{host}}/v1/pets\n  body: json\n  auth: none\n}\n\nbody:json {\n  {\n    "name": "Rex",\n    "age": 3\n  }\n}\n',
    );
    writeFileSync(join(dir, "Pets", "Get pet.bru"), "meta {\n  name: Get pet\n}\n\nget {\n  url: {{host}}/v1/pets/:petId\n}\n\nparams:path {\n  petId: 1\n}\n");
    await assert.rejects(engine.importFile({ name: "bruno", path: dir, environment: "staging" }), /not found \(available: local, prod\)/);
    const recipe = await engine.importFile({ name: "bruno", path: dir, environment: "local" });
    assert.equal(recipe.source.format, "bruno");
    assert.equal(recipe.title, "Pets API");
    assert.equal(recipe.baseUrl, fixtures.petsUrl);
    assert.deepEqual(recipe.operations.map((o) => `${o.method} ${o.path} ${o.id}`).sort(), ["GET /v1/pets pets_list_pets", "GET /v1/pets/{petId} pets_get_pet", "POST /v1/pets pets_create_pet"]);
    assert.deepEqual(recipe.operations.find((o) => o.id === "pets_list_pets").params.map((p) => p.name), ["limit"]);
    assert.equal(recipe.operations.find((o) => o.id === "pets_create_pet").body.schema.properties.age.type, "integer");
    const one = await engine.tools.get("bruno__pets_get_pet").run({ path: { petId: "9" } });
    assert.match(one.text, /Pet 9/);
  });

  it("exports a recipe without secrets and imports it under another name", async () => {
    const file = join(home, "shared-pets.json");
    engine.exportRecipe({ name: "pets", path: file });
    assert.throws(() => engine.exportRecipe({ name: "pets", path: file }), /already exists/);
    assert.ok(!readFileSync(file, "utf8").includes("k1"), "the API key must not be exported");
    const copy = await engine.importFile({ name: "pets-copy", path: file });
    assert.equal(copy.source.originalName, "pets");
    assert.ok(engine.tools.has("pets-copy__pets_list_pets"));
    const list = await engine.tools.get("pets-copy__pets_list_pets").run({});
    assert.match(list.text, /HTTP 200/);
  });
});
