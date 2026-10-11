import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parseCurl, shellSplit, splitCurlCommands } from "../../src/discovery/curl.js";
import { startFixtureServers } from "../e2e/fixture-servers.js";

describe("cURL parsing", () => {
  it("splits bash and Windows cmd syntax", () => {
    assert.deepEqual(shellSplit(`curl 'https://a.io/x?y=1' \\\n  -H 'accept: */*' -d "{\\"a\\":1}" $'line\\nnext'`), ["curl", "https://a.io/x?y=1", "-H", "accept: */*", "-d", '{"a":1}', "line\nnext"]);
    assert.deepEqual(shellSplit('curl ^"https://a.io/x^" ^\n  -H ^"x-key: k^"'), ["curl", "https://a.io/x", "-H", "x-key: k"]);
  });

  it("reads method, headers, body, cookies and basic auth", () => {
    const { observation } = parseCurl(`curl 'https://api.shop.io/v1/orders' -H 'Authorization: Bearer t0k3n' -H 'Content-Type: application/json' -b 'sid=abc' --data-raw '{"sku":"a1"}' --compressed`); // gitleaks:allow (fake test token)
    assert.equal(observation.method, "POST");
    assert.equal(observation.url, "https://api.shop.io/v1/orders");
    assert.deepEqual(observation.requestHeaders, { authorization: "Bearer t0k3n", "content-type": "application/json", cookie: "sid=abc" }); // gitleaks:allow
    assert.equal(observation.requestBody, '{"sku":"a1"}');
    assert.equal(parseCurl("curl -u me:pw https://a.io").observation.requestHeaders.authorization, `Basic ${Buffer.from("me:pw").toString("base64")}`);
    assert.equal(parseCurl("curl -G https://a.io/s -d q=lamp -d page=2").observation.url, "https://a.io/s?q=lamp&page=2");
    assert.equal(parseCurl("curl -XDELETE https://a.io/x/1").observation.method, "DELETE");
    assert.deepEqual(parseCurl("curl https://a.io -F file=@a.png").warnings, ["-F (file upload / multipart) is not imported."]);
    assert.throws(() => parseCurl("wget https://a.io"), /must start with "curl"/);
  });

  it("splits several pasted commands", () => {
    assert.equal(splitCurlCommands("curl https://a.io/1\ncurl https://a.io/2 \\\n -H 'x: y'").length, 2);
  });
});

describe("import_curl through the engine", () => {
  let home, fixtures, engine;
  before(async () => {
    home = mkdtempSync(join(tmpdir(), "umcp-curl-"));
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

  it("imports a .http file (variables, headers, JSON body, several requests)", async () => {
    const file = join(home, "pets.http");
    writeFileSync(
      file,
      [
        "@host = " + fixtures.petsUrl,
        "@key = k1",
        "",
        "### List pets",
        "GET {{host}}/v1/pets",
        "    ?limit=1",
        "Accept: application/json",
        "",
        "### Create a pet",
        "# @name createPet",
        "POST {{host}}/v1/pets HTTP/1.1",
        "Content-Type: application/json",
        "X-Api-Key: {{key}}",
        "",
        '{ "name": "Rex", "age": 3 }',
        "",
        "> {% client.global.set('id', response.body.id); %}",
        "",
        "### Unknown",
        "GET {{missing}}/x",
      ].join("\n"),
    );
    const recipe = await engine.importFile({ name: "httpfile", path: file });
    assert.equal(recipe.source.format, "http");
    assert.deepEqual(recipe.endpoints.map((e) => `${e.method} ${e.pathTemplate}`).sort(), ["GET /v1/pets", "POST /v1/pets"]);
    assert.match(recipe.warnings.join(" "), /Unresolved variable/);
    assert.ok(!readFileSync(join(home, "recipes", "httpfile.json"), "utf8").includes('"k1"'));
    const created = await engine.tools.get("httpfile__post_v1_pets").run({ body: { name: "Tom" } });
    assert.match(created.text, /HTTP 201[\s\S]*Tom/);
  });

  it("creates tools that replay the stored credentials, without sending anything at import", async () => {
    const recipe = await engine.importCurl({
      name: "petscurl",
      commands: [
        `curl '${fixtures.petsUrl}/v1/pets/1' -H 'accept: application/json'`,
        `curl '${fixtures.petsUrl}/v1/pets/2'`,
        `curl -X POST '${fixtures.petsUrl}/v1/pets' -H 'x-api-key: k1' -H 'content-type: application/json' --data-raw '{"name":"Rex"}'`,
      ].join("\n"),
    });
    assert.deepEqual(recipe.endpoints.map((e) => `${e.method} ${e.pathTemplate}`).sort(), ["GET /v1/pets/{pet}", "POST /v1/pets"]);
    assert.ok(!readFileSync(join(home, "recipes", "petscurl.json"), "utf8").includes("k1"), "the API key stays out of the recipe");
    const one = await engine.tools.get("petscurl__get_v1_pets_pet").run({ path: { pet: "5" } });
    assert.match(one.text, /HTTP 200[\s\S]*Pet 5/);
    const created = await engine.tools.get("petscurl__post_v1_pets").run({ body: { name: "Tom" } });
    assert.match(created.text, /HTTP 201[\s\S]*Tom/);
  });
});
