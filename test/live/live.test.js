// Tests against real public websites. Skipped unless UNIVERSAL_MCP_LIVE=1 (they need network access
// and depend on third-party sites that can change at any time).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const enabled = process.env.UNIVERSAL_MCP_LIVE === "1";
const BIN = fileURLToPath(new URL("../../bin/universal-mcp.js", import.meta.url));
const TIMEOUT = { timeout: 240_000 };

let home;
/** @type {Client} */ let client;

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 230_000 });
  return { text: /** @type {any} */ (result.content)[0].text, isError: !!result.isError };
}

describe("live websites", { skip: !enabled && "set UNIVERSAL_MCP_LIVE=1 to run" }, () => {
  before(async () => {
    home = mkdtempSync(join(tmpdir(), "universal-mcp-live-"));
    client = new Client({ name: "live", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN], env: { ...process.env, UNIVERSAL_MCP_HOME: home } }));
  });

  after(async () => {
    await client?.close().catch(() => {});
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });

  it("crates.io (single-page app, browser capture)", TIMEOUT, async () => {
    const discovered = await call("discover", { name: "crates", url: "https://crates.io/search?q=serde", actions: [{ goto: "/crates/serde" }] });
    assert.equal(discovered.isError, false, discovered.text);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("crates__get_api_v1_crates_crate"), names.join(", "));
    const tokio = await call("crates__get_api_v1_crates_crate", { path: { crate: "tokio" }, pick: "crate.name,crate.max_version" });
    assert.match(tokio.text, /HTTP 200[\s\S]*"tokio"/);
    const search = await call("crates__get_api_v1_crates", { query: { q: "bevy", per_page: 2 }, pick: "crates[*].name" });
    assert.match(search.text, /bevy/);
  });

  it("Swagger Petstore (OpenAPI found from the Swagger UI page)", TIMEOUT, async () => {
    const discovered = await call("discover", { name: "petstore", url: "https://petstore3.swagger.io/" });
    assert.equal(discovered.isError, false, discovered.text);
    assert.match(discovered.text, /\(openapi\)/);
    const pet = await call("petstore__find_pets_by_status", { query: { status: "available" }, max_chars: 300 });
    assert.match(pet.text, /HTTP 200/);
  });

  it("YouTube Data API (Google Discovery document)", TIMEOUT, async () => {
    const discovered = await call("discover", { name: "youtube", url: "https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest", include: "search_list|videos_list" });
    assert.equal(discovered.isError, false, discovered.text);
    assert.match(discovered.text, /YouTube Data API/);
    // Without an API key Google refuses the call, which still proves the request is well formed.
    const key = process.env.YOUTUBE_API_KEY;
    if (key) await call("set_credentials", { name: "youtube", host: "youtube.googleapis.com", headers: { "x-goog-api-key": key } });
    const search = await call("youtube__youtube_search_list", { query: { part: ["snippet"], q: "bitcoin", maxResults: 1 }, max_chars: 400 });
    assert.match(search.text, key ? /HTTP 200/ : /HTTP 403[\s\S]*API Key/);
  });

  it("OData demo service (Northwind, $metadata)", TIMEOUT, async () => {
    const discovered = await call("discover", { name: "northwind", url: "https://services.odata.org/V4/Northwind/Northwind.svc/", include: "customers" });
    assert.equal(discovered.isError, false, discovered.text);
    const one = await call("northwind__get_customers", { path: { CustomerID: "ALFKI" }, pick: "CompanyName" });
    assert.match(one.text, /HTTP 200[\s\S]*Alfreds Futterkiste/);
    const list = await call("northwind__list_customers", { query: { $filter: "Country eq 'France'", $top: 3, $select: "CompanyName" }, pick: "value[*].CompanyName" });
    assert.match(list.text, /HTTP 200/);
  });

  it("SOAP demo service (calculator, WSDL)", TIMEOUT, async () => {
    const discovered = await call("discover", { name: "calc", url: "http://www.dneonline.com/calculator.asmx" });
    assert.equal(discovered.isError, false, discovered.text);
    const sum = await call("calc__Add", { params: { intA: 2, intB: 40 }, pick: "AddResponse.AddResult" });
    assert.match(sum.text, /HTTP 200[^\n]*\n"42"/);
  });

  it("Hacker News search (browser capture of a third-party search API)", TIMEOUT, async () => {
    const discovered = await call("discover", { name: "hn", url: "https://hn.algolia.com/?q=model%20context%20protocol", mode: "browser", hosts: ["algolia.net"] });
    assert.equal(discovered.isError, false, discovered.text);
    assert.doesNotMatch(discovered.text, /GraphQL|telemetry|isalive/, "search bodies are not GraphQL; telemetry and probes are dropped");
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name.startsWith("hn__post_1_indexes_"));
    assert.ok(search, tools.map((t) => t.name).join(", "));
    const result = await call(search.name, { body: { query: "rust", hitsPerPage: 3 }, pick: "hits[*].title" });
    assert.match(result.text, /HTTP 200/, result.text);
  });
});
