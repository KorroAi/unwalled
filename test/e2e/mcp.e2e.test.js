// End-to-end: a real MCP client drives the server (spawned like an MCP host would) against local fixture servers.
// Requires a Chromium-based browser (Chrome by default; set UNIVERSAL_MCP_BROWSER=chromium on CI).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { startFixtureServers } from "./fixture-servers.js";

const BIN = fileURLToPath(new URL("../../bin/universal-mcp.js", import.meta.url));
const TIMEOUT = { timeout: 180_000 };

let home;
let fixtures;
/** @type {Client} */ let client;
let toolListChanges = 0;
let serverLog = "";

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: { ...process.env, UNIVERSAL_MCP_HOME: home },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    serverLog += chunk;
  });
  const instance = new Client({ name: "e2e", version: "0.0.0" });
  instance.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    toolListChanges++;
  });
  await instance.connect(transport);
  return instance;
}

/** @returns {Promise<{ text: string, isError: boolean }>} */
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 170_000 });
  return { text: /** @type {any} */ (result.content)[0].text, isError: !!result.isError };
}

async function toolNames(prefix = "") {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name).filter((n) => n.startsWith(prefix)).sort();
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), "universal-mcp-e2e-"));
  fixtures = await startFixtureServers();
  client = await connect();
});

after(async () => {
  await client?.close().catch(() => {});
  await fixtures?.close();
  // Chrome may hold profile files for a moment after exit (Windows).
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(home, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
});

describe("universal-mcp end to end", () => {
  it("starts with only the management tools", async () => {
    assert.deepEqual(await toolNames(), ["discover", "discover_har", "export_recipe", "forget", "import_curl", "import_file", "inspect_recipe", "list_recipes", "login", "set_credentials", "watch"]);
    assert.match((await call("list_recipes")).text, /No recipe yet/);
  });

  it("rejects invalid input cleanly", async () => {
    assert.match((await call("discover", { name: "Bad Name", url: fixtures.shopUrl })).text, /Invalid recipe name/);
    assert.match((await call("discover", { name: "x", url: "file:///etc/passwd" })).text, /Only http\(s\)/);
    assert.match((await call("discover", { name: "x", url: fixtures.shopUrl, actions: [{ click: "#a", goto: "/b" }] })).text, /exactly one of/);
    assert.match((await call("discover", { name: "x", url: fixtures.shopUrl, mode: "openapi" })).text, /No OpenAPI/);
    const unknown = await call("nope__tool");
    assert.equal(unknown.isError, true);
  });

  it("discovers a single-page app through the browser (REST, GraphQL, cookie and bearer auth)", TIMEOUT, async () => {
    const before = toolListChanges;
    const result = await call("discover", {
      name: "shop",
      url: fixtures.shopUrl,
      actions: [{ click: "#login" }, { goto: "/product/blue-lamp" }, { fill: "#q", text: "lamp" }, { click: "#go" }],
    });
    assert.equal(result.isError, false, `${result.text}\n--- server log ---\n${serverLog}`);
    assert.match(result.text, /Recipe "shop" \(browser\)/);
    assert.deepEqual(await toolNames("shop__"), [
      "shop__get_api_me", "shop__get_api_orders", "shop__get_api_products", "shop__get_api_products_product", "shop__get_api_products_product_reviews",
      "shop__get_api_search", "shop__gql_GetCart", "shop__graphql", "shop__post_auth_login", "shop__request",
    ]);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(toolListChanges > before, "tools/list_changed notification received");
  });

  it("calls generated REST tools with new parameter values", TIMEOUT, async () => {
    const product = await call("shop__get_api_products_product", { path: { product: "red-chair" } });
    assert.equal(product.isError, false, product.text);
    assert.match(product.text, /HTTP 200[\s\S]*"name":"Product red-chair"/);
    assert.match((await call("shop__get_api_search", { query: { q: "desk" } })).text, /"query":"desk"/);
    assert.match((await call("shop__get_api_products_product_reviews", { path: { product: "x1" } })).text, /"product":"x1"/);
  });

  it("trims responses with pick and max_chars", async () => {
    const picked = await call("shop__get_api_products", { query: { page: 2 }, pick: "items[*].name" });
    assert.match(picked.text, /\[\s*"Blue lamp",\s*"Red chair"\s*\]/);
    assert.match((await call("shop__get_api_products", { max_chars: 40 })).text, /truncated/);
  });

  it("replays GraphQL operations with new variables, and raw GraphQL", async () => {
    assert.match((await call("shop__gql_GetCart", { variables: { id: "c9" } })).text, /"id":"c9"/);
    assert.match((await call("shop__graphql", { query: "{ __typename }" })).text, /"__typename":"Query"/);
  });

  it("reuses the browser session cookie and the captured bearer token", async () => {
    const me = await call("shop__get_api_me");
    assert.equal(me.isError, false, me.text);
    assert.match(me.text, /"user":"demo"/);
    const orders = await call("shop__get_api_orders");
    assert.equal(orders.isError, false, orders.text);
    assert.match(orders.text, /"o1"/);
  });

  it("keeps secrets out of the recipe and out of inspect output", async () => {
    const recipeFile = readFileSync(join(home, "recipes", "shop.json"), "utf8");
    assert.ok(!recipeFile.includes("tok-123"), "token must not be written in the recipe");
    const inspected = await call("inspect_recipe", { name: "shop" });
    assert.match(inspected.text, /authorization/);
    assert.ok(!inspected.text.includes("tok-123"));
    const stored = readFileSync(join(home, "secrets", "shop.json"), "utf8");
    assert.ok(!stored.includes("tok-123") && JSON.parse(stored).alg === "aes-256-gcm", "secrets are encrypted at rest");
  });

  it("supports free-form requests", async () => {
    assert.match((await call("shop__request", { method: "GET", url: "/api/products/abc" })).text, /"Product abc"/);
    const missing = await call("shop__request", { method: "GET", url: "/nope" });
    assert.equal(missing.isError, true);
  });

  it("reloads recipes after a restart and still has the session", TIMEOUT, async () => {
    await client.close();
    client = await connect();
    assert.ok((await toolNames("shop__")).includes("shop__get_api_me"));
    assert.match((await call("shop__get_api_me")).text, /HTTP 200/);
    assert.match((await call("shop__get_api_orders")).text, /HTTP 200/);
  });

  it("discovers a published OpenAPI description and uses credentials", TIMEOUT, async () => {
    const result = await call("discover", { name: "pets", url: fixtures.petsUrl });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /\(openapi\)[\s\S]*4 routes, 3 with dedicated tools/);
    assert.deepEqual(await toolNames("pets__"), ["pets__create_pet", "pets__get_pet", "pets__list_pets", "pets__request", "pets__routes"]);
    assert.match((await call("pets__list_pets", { query: { limit: 1 } })).text, /"Rex"/);
    assert.match((await call("pets__get_pet", { path: { petId: "7" } })).text, /"Pet 7"/);
    assert.match((await call("pets__routes", { filter: "old" })).text, /GET \/old/);

    const denied = await call("pets__create_pet", { body: { name: "Kitty" } });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /HTTP 401/);
    const host = new URL(fixtures.petsUrl).host;
    assert.match((await call("set_credentials", { name: "pets", host, headers: { "X-API-Key": "k1" } })).text, /x-api-key/);
    const created = await call("pets__create_pet", { body: { name: "Kitty" } });
    assert.equal(created.isError, false, created.text);
    assert.match(created.text, /HTTP 201[\s\S]*"Kitty"/);
  });

  it("imports a HAR capture", TIMEOUT, async () => {
    const harPath = join(home, "capture.har");
    const entry = (path, body) => ({
      _resourceType: "fetch",
      request: { method: "GET", url: `${fixtures.petsUrl}${path}`, headers: [{ name: "X-API-Key", value: "k1" }] },
      response: { status: 200, content: { mimeType: "application/json", text: JSON.stringify(body) } },
    });
    writeFileSync(harPath, JSON.stringify({ log: { entries: [entry("/v1/pets/11", { id: "11" }), entry("/v1/pets?limit=2", [])] } }));
    const result = await call("discover_har", { name: "pets-har", har_path: harPath });
    assert.equal(result.isError, false, result.text);
    assert.match((await call("pets-har__get_v1_pets_pet", { path: { pet: "12" } })).text, /"Pet 12"/);
    assert.match((await call("inspect_recipe", { name: "pets-har" })).text, /x-api-key/);
  });

  it("merges a second capture into an existing recipe", TIMEOUT, async () => {
    const result = await call("discover", { name: "shop", url: `${fixtures.shopUrl}/search`, mode: "browser", merge: true });
    assert.equal(result.isError, false, result.text);
    assert.ok((await toolNames("shop__")).includes("shop__get_api_products_product_reviews"), "earlier endpoints are kept");
  });

  it("works from the command line", TIMEOUT, async () => {
    const run = promisify(execFile);
    const env = { ...process.env, UNIVERSAL_MCP_HOME: home };
    assert.match((await run(process.execPath, [BIN, "--version"], { env })).stdout, /^\d+\.\d+\.\d+/);
    const list = await run(process.execPath, [BIN, "list"], { env });
    assert.match(list.stdout, /Recipe "pets" \(openapi\)/);
    await assert.rejects(run(process.execPath, [BIN, "inspect", "missing"], { env }), /Unknown recipe/);
  });

  it("forgets recipes and removes their tools", async () => {
    const before = toolListChanges;
    assert.match((await call("forget", { name: "shop", delete_profile: true })).text, /deleted/);
    assert.deepEqual(await toolNames("shop__"), []);
    assert.match((await call("forget", { name: "shop" })).text, /Unknown recipe/);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(toolListChanges > before);
  });
});
