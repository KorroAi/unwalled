// End-to-end: a real MCP client drives the server (spawned like an MCP host would) against local fixture servers.
// Requires a Chromium-based browser (Chrome by default; set UNWALLED_BROWSER=chromium on CI).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { MANAGEMENT_TOOLS } from "../../src/server.js";
import { Store } from "../../src/store.js";
import { startFixtureServers } from "./fixture-servers.js";

const BIN = fileURLToPath(new URL("../../bin/unwalled.js", import.meta.url));
const TIMEOUT = { timeout: 180_000 };
const MANAGEMENT = MANAGEMENT_TOOLS.map((t) => t.name).sort();

let home;
let fixtures;
/** @type {Client} */ let client;
let toolListChanges = 0;
let serverLog = "";

/** @param {Record<string, string>} [env] */
async function connect(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: { ...process.env, UNWALLED_HOME: home, ...env },
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

/** @returns {Promise<{ text: string, isError: boolean, content: any[] }>} */
async function call(name, args = {}, on = client) {
  const result = await on.callTool({ name, arguments: args }, undefined, { timeout: 170_000 });
  const content = /** @type {any[]} */ (result.content);
  return { text: content[0].text, isError: !!result.isError, content };
}

async function toolNames(prefix = "", on = client) {
  const { tools } = await on.listTools();
  return tools.map((t) => t.name).filter((n) => n.startsWith(prefix)).sort();
}

const stats = async () => (await fetch(`${fixtures.shopUrl}/__stats`)).json();

before(async () => {
  home = mkdtempSync(join(tmpdir(), "unwalled-e2e-"));
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

describe("unwalled end to end", () => {
  it("starts with only the management tools", async () => {
    assert.deepEqual(await toolNames(), MANAGEMENT);
    assert.match((await call("list_recipes")).text, /No recipe yet/);
  });

  it("rejects invalid input cleanly", async () => {
    assert.match((await call("discover", { name: "Bad Name", url: fixtures.shopUrl })).text, /Invalid recipe name/);
    assert.match((await call("discover", { name: "x", url: "file:///etc/passwd" })).text, /Only http\(s\)/);
    assert.match((await call("discover", { name: "x", url: fixtures.shopUrl, actions: [{ click: "#a", goto: "/b" }] })).text, /exactly one of/);
    assert.match((await call("discover", { name: "x", url: fixtures.shopUrl, mode: "openapi" })).text, /No OpenAPI/);
    assert.match((await call("discover", { name: "x", url: fixtures.shopUrl, explore_pages: 500 })).text, /explore_pages/);
    const unknown = await call("nope__tool");
    assert.equal(unknown.isError, true);
  });

  it("discovers a single-page app through the browser (REST, GraphQL, cookie and bearer auth, CSRF)", TIMEOUT, async () => {
    const before = toolListChanges;
    const result = await call("discover", {
      name: "shop",
      url: fixtures.shopUrl,
      actions: [{ click: "#login" }, { goto: "/product/blue-lamp" }, { fill: "#q", text: "lamp" }, { click: "#go" }, { click: "#add" }],
    });
    assert.equal(result.isError, false, `${result.text}\n--- server log ---\n${serverLog}`);
    assert.match(result.text, /Recipe "shop" \(browser\)/);
    const names = await toolNames("shop__");
    for (const expected of [
      "shop__get_api_me", "shop__get_api_orders", "shop__get_api_products", "shop__get_api_products_product", "shop__get_api_products_product_reviews",
      "shop__get_api_search", "shop__get_api_protected", "shop__gql_GetCart", "shop__graphql", "shop__post_auth_login", "shop__post_api_cart", "shop__request",
    ])
      assert.ok(names.includes(expected), `${expected} missing from ${names.join(", ")}`);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(toolListChanges > before, "tools/list_changed notification received");
  });

  it("captures JSON served as text or behind an anti-hijacking prefix", async () => {
    assert.match((await call("shop__get_api_plain", { pick: "items" })).text, /HTTP 200[\s\S]*1,[\s\S]*2/);
    assert.match((await call("shop__get_api_prefixed", { pick: "kind" })).text, /"prefixed"/);
  });

  it("describes tools in plain language", async () => {
    const { tools } = await client.listTools();
    const describe = (name) => tools.find((t) => t.name === name)?.description ?? "";
    assert.match(describe("shop__get_api_products_product"), /^Get one product by product\./);
    assert.match(describe("shop__get_api_search"), /^Search\./);
    assert.match(describe("shop__gql_GetCart"), /^Read data with the GetCart GraphQL query/);
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

  it("uses in-page requests against bot protection only when the recipe opts in", TIMEOUT, async () => {
    const refused = await call("shop__get_api_protected");
    assert.equal(refused.isError, true, "no in-page retry by default");
    assert.match(refused.text, /"transport": "auto"/, "the hint explains how to opt in");
    const optIn = await call("configure_recipe", { name: "shop", policy: { transport: "auto" } });
    assert.equal(optIn.isError, false, optIn.text);
    const refusedBefore = (await stats()).protectedRefused;
    const result = await call("shop__get_api_protected");
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /"protected":"ok"/);
    assert.ok((await stats()).protectedRefused > refusedBefore, "the direct request was refused first");
    assert.match((await call("shop__get_api_protected")).text, /"protected":"ok"/, "later calls go through the page directly");
  });

  it("refreshes a stale CSRF token from the site's cookie", TIMEOUT, async () => {
    // Loading a page rotates the XSRF-TOKEN cookie: the token captured during discovery is now stale.
    assert.match((await call("ui", { name: "shop", action: "open", url: fixtures.shopUrl })).text, /Interactive elements/);
    const cart = await call("shop__post_api_cart", { body: { product: "red-chair", qty: 1 } });
    assert.equal(cart.isError, false, cart.text);
    assert.match(cart.text, /"added":"red-chair"/);
  });

  it("re-authenticates by itself when the bearer token is rotated", TIMEOUT, async () => {
    await fetch(`${fixtures.shopUrl}/__rotate`);
    const orders = await call("shop__get_api_orders");
    assert.equal(orders.isError, false, `${orders.text}\n${serverLog.slice(-2000)}`);
    assert.match(orders.text, /"o1"/);
    assert.match(readFileSync(join(home, "audit.log"), "utf8"), /"reauth":"browser"/);
  });

  it("previews requests with dry_run and holds destructive calls for confirmation", async () => {
    const dry = await call("shop__get_api_products", { dry_run: true });
    assert.match(dry.text, /^Dry run: nothing was sent\.\nGET http/);
    const held = await call("shop__request", { method: "DELETE", url: "/api/products" });
    assert.equal(held.isError, false);
    assert.match(held.text, /needs confirmation/);
    assert.equal((await stats()).deleteHits, 0, "nothing was sent");
    const confirmed = await call("shop__request", { method: "DELETE", url: "/api/products", confirm: true });
    assert.match(confirmed.text, /HTTP 200[\s\S]*"deleted":"all"/);
    assert.equal((await stats()).deleteHits, 1);
  });

  it("uploads files (multipart) and downloads binary responses", async () => {
    const file = join(home, "hello.txt");
    writeFileSync(file, "hello upload");
    const upload = await call("shop__request", { method: "POST", url: "/api/upload", body: { note: "hi" }, files: { doc: file } });
    assert.equal(upload.isError, false, upload.text);
    assert.match(upload.text, /"multipart":true,"file":"hello.txt","note":"hi","hasContent":true/);
    const target = join(home, "report.bin");
    const image = /** @type {any} */ (await client.callTool({ name: "shop__request", arguments: { method: "GET", url: "/assets/logo.png" } }));
    assert.equal(image.content[1]?.type, "image", "image responses reach the agent as images");
    assert.equal(image.content[1].mimeType, "image/png");
    const download = await call("shop__request", { method: "GET", url: "/files/report.bin", save_to: target });
    assert.match(download.text, /Saved 10 bytes/);
    assert.equal(statSync(target).size, 10);
  });

  it("reads server-rendered HTML pages as text", async () => {
    const page = await call("shop__request", { method: "GET", url: "/ssr" });
    assert.match(page.text, /# Catalogue/);
    assert.match(page.text, /Blue lamp/);
    assert.doesNotMatch(page.text, /<table>|color:red/);
    assert.match((await call("shop__request", { method: "GET", url: "/ssr", raw: true })).text, /<table>/);
  });

  it("drives the interface: snapshot, read, act, risky clicks held, screenshot", TIMEOUT, async () => {
    const ssr = await call("ui", { name: "shop", action: "open", url: `${fixtures.shopUrl}/ssr` });
    assert.match(ssr.text, /\[e\d+\] text input "Find"/);
    assert.match((await call("ui", { name: "shop", action: "read" })).text, /Catalogue[\s\S]*Blue lamp/);

    const home = await call("ui", { name: "shop", action: "open", url: fixtures.shopUrl });
    const ref = (label) => new RegExp(`\\[(e\\d+)\\] [^\\n]*"${label}"`).exec(home.text)?.[1];
    assert.ok(ref("Delete all") && ref("Search") && ref("Search text"), home.text);
    const held = await call("ui", { name: "shop", action: "act", steps: [{ click: ref("Delete all") }] });
    assert.match(held.text, /may delete, pay or send/);
    assert.equal((await stats()).deleteHits, 1, "the risky click was not performed");
    const acted = await call("ui", { name: "shop", action: "act", steps: [{ fill: ref("Search text"), text: "chair" }, { click: ref("Search") }, { wait: 300 }] });
    assert.equal(acted.isError, false, acted.text);
    assert.match(acted.text, /1\. ok[\s\S]*2\. ok/);
    assert.match((await call("ui", { name: "shop", action: "read", selector: "#out" })).text, /"query":"chair"/);
    const shot = await call("ui", { name: "shop", action: "screenshot" });
    assert.equal(shot.content[1]?.type, "image");
    assert.match((await call("ui", { name: "shop", action: "close" })).text, /closed/);
  });

  it("applies agent-written annotations and runs macros", TIMEOUT, async () => {
    const annotated = await call("annotate_recipe", { name: "shop", annotations: { shop__get_api_search: { name: "search_products", description: "Search the catalogue", params: { "query.q": "Search text" } } } });
    assert.equal(annotated.isError, false, annotated.text);
    const names = await toolNames("shop__");
    assert.ok(names.includes("shop__search_products") && !names.includes("shop__get_api_search"), names.join(", "));
    const { tools } = await client.listTools();
    assert.match(tools.find((t) => t.name === "shop__search_products")?.description ?? "", /^Search the catalogue/);

    const macro = await call("define_macro", {
      name: "shop",
      macro: {
        id: "first_result_price", description: "Price of the first search result", params: { q: { type: "string", required: true } },
        steps: [{ tool: "search_products", args: { query: { q: "{{params.q}}" } }, as: "search" }, { tool: "get_api_products_product", args: { path: { product: "{{steps.search.results[0].id}}" } } }],
        result: "{{steps.1.price}}",
      },
    });
    assert.equal(macro.isError, false, macro.text);
    const run = await call("shop__m_first_result_price", { q: "lamp" });
    assert.equal(run.isError, false, run.text);
    assert.match(run.text, /1\. shop__search_products: HTTP 200[\s\S]*2\. shop__get_api_products_product: HTTP 200[\s\S]*\n42$/);
    assert.match((await call("define_macro", { name: "shop", macro: { id: "bad", description: "x", steps: [{ tool: "nope" }] } })).text, /does not exist/);
  });

  it("lists only search tools in search mode, and finds and runs any tool", TIMEOUT, async () => {
    // One server at a time: a browser profile can only be opened by one process.
    await client.close();
    const other = await connect({ UNWALLED_TOOL_MODE: "search" });
    try {
      assert.deepEqual(await toolNames("", other), MANAGEMENT);
      const found = await call("search_tools", { query: "product reviews" }, other);
      assert.match(found.text, /## shop__get_api_products_product_reviews/);
      const ran = await call("call_tool", { name: "shop__get_api_products_product_reviews", arguments: { path: { product: "p7" } } }, other);
      assert.match(ran.text, /"product":"p7"/);
      await call("search_tools", { query: "orders", pin: true }, other);
      assert.ok((await toolNames("shop__", other)).includes("shop__get_api_orders"), "pinned tools are listed");
    } finally {
      await other.close();
      client = await connect();
    }
  });

  it("reloads recipes after a restart and still has the session", TIMEOUT, async () => {
    await client.close();
    client = await connect();
    assert.ok((await toolNames("shop__")).includes("shop__get_api_me"));
    assert.match((await call("shop__get_api_me")).text, /HTTP 200/);
    assert.match((await call("shop__get_api_orders")).text, /HTTP 200/);
  });

  it("discovers a published OpenAPI description, uses credentials and enforces policies", TIMEOUT, async () => {
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

    await call("configure_recipe", { name: "pets", policy: { readOnly: true } });
    const blocked = await call("pets__create_pet", { body: { name: "Nope" } });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /^Blocked: This recipe is read-only/);
    assert.match((await call("pets__list_pets")).text, /HTTP 200/, "reads still work");
    await call("configure_recipe", { name: "pets", policy: { confirm: "writes", readOnly: false } });
    assert.match((await call("pets__create_pet", { body: { name: "Held" } })).text, /needs confirmation/);
    assert.match((await call("pets__create_pet", { body: { name: "Held" }, confirm: true })).text, /HTTP 201/);
    await call("configure_recipe", { name: "pets", policy: null });
  });

  it("renews an expired access token with the OAuth refresh token", async () => {
    const host = new URL(fixtures.petsUrl).host;
    await call("set_credentials", { name: "pets", host, headers: { authorization: "Bearer acc-old" } });
    const configured = await call("configure_recipe", { name: "pets", oauth: { host, token_url: `${fixtures.petsUrl}/oauth/token`, refresh_token: "r1" } });
    assert.equal(configured.isError, false, configured.text);
    const secure = await call("pets__request", { method: "GET", url: "/v1/secure" });
    assert.equal(secure.isError, false, secure.text);
    assert.match(secure.text, /"secure":true/);
    // Secrets are encrypted at rest: read them back through the store (same user, so the same DPAPI or passphrase key).
    const config = { home, recipesDir: join(home, "recipes"), profilesDir: join(home, "profiles"), secretsDir: join(home, "secrets"), stateDir: join(home, "state"), encryptSecrets: true };
    const oauth = /** @type {any} */ (new Store(/** @type {any} */ (config)).loadSecrets("pets")[host]?.["@oauth"]);
    assert.equal(oauth?.refresh_token, "r2", "the rotated refresh token is kept");
  });

  it("applies saved default arguments, recipe headers and per-call timeouts", TIMEOUT, async () => {
    const saved = await call("annotate_recipe", { name: "pets", annotations: { pets__get_pet: { defaults: { path: { petId: "42" } } } } });
    assert.equal(saved.isError, false, saved.text);
    assert.match((await call("pets__get_pet")).text, /"Pet 42"/, "defaults fill omitted arguments");
    assert.match((await call("pets__get_pet", { path: { petId: "5" } })).text, /"Pet 5"/, "explicit arguments win");

    assert.match((await call("configure_recipe", { name: "pets", headers: { "X-Lang": "fr" } })).text, /"x-lang":"fr"/);
    assert.match((await call("pets__request", { method: "GET", url: "/v1/echo-headers" })).text, /"lang":"fr"/);
    assert.match((await call("configure_recipe", { name: "pets", headers: { authorization: "x" } })).text, /Use set_credentials/);
    await call("configure_recipe", { name: "pets", headers: { "x-lang": null } });
    assert.match((await call("pets__request", { method: "GET", url: "/v1/echo-headers" })).text, /"lang":null/);

    const started = Date.now();
    const slow = await call("pets__request", { method: "GET", url: "/v1/slow", timeout_ms: 1000 });
    assert.equal(slow.isError, true, slow.text);
    assert.match(slow.text, /timeout|aborted/i);
    assert.ok(Date.now() - started < 15_000, "the call gave up early");
    assert.match((await call("pets__request", { method: "GET", url: "/v1/slow", timeout_ms: 10000 })).text, /"slow":true/);
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

  it("detects a changed API and repairs the recipe", TIMEOUT, async () => {
    const healthy = await call("check_recipe", { name: "shop" });
    assert.match(healthy.text, /ok\s+shop__get_api_products —/, healthy.text);
    await fetch(`${fixtures.shopUrl}/__drift`);
    const broken = await call("check_recipe", { name: "shop" });
    assert.equal(broken.isError, true);
    assert.match(broken.text, /broken\s+shop__get_api_products — HTTP 404/);
    const repaired = await call("check_recipe", { name: "shop", repair: true });
    assert.match(repaired.text, /added: [^\n]*shop__get_api_v2_products/, repaired.text);
    assert.ok((await toolNames("shop__")).includes("shop__get_api_v2_products"));
    const recipe = JSON.parse(readFileSync(join(home, "recipes", "shop.json"), "utf8"));
    assert.ok(recipe.annotations?.shop__get_api_search && recipe.macros?.length === 1, "annotations and macros survive the repair");
  });

  it("explores a site on its own without following unsafe links", TIMEOUT, async () => {
    const result = await call("discover", { name: "shopx", url: fixtures.shopUrl, mode: "browser", explore_pages: 3 });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /Explored \d+ pages/);
    const names = await toolNames("shopx__");
    assert.ok(names.includes("shopx__get_api_team"), `the About page was explored: ${names.join(", ")}`);
    assert.ok(names.includes("shopx__get_api_products_product"), "the product link was explored");
    assert.equal((await stats()).logoutHits, 0, "the logout link was never followed");
  });

  it("keeps secrets out of recipes, inspect output and the audit log", async () => {
    const recipeFile = readFileSync(join(home, "recipes", "shop.json"), "utf8");
    for (const secret of ["tok-1", "tok-2", "sid=abc"]) assert.ok(!recipeFile.includes(secret), `${secret} must not be written in the recipe`);
    const inspected = await call("inspect_recipe", { name: "shop" });
    assert.match(inspected.text, /authorization/);
    assert.ok(!/tok-\d/.test(inspected.text));
    const stored = readFileSync(join(home, "secrets", "shop.json"), "utf8");
    assert.ok(!stored.includes("tok-2") && JSON.parse(stored).alg === "aes-256-gcm", "secrets are encrypted at rest");
    const audit = readFileSync(join(home, "audit.log"), "utf8");
    for (const secret of ["tok-", "acc-2", "k1\"", "r1", "sid=abc"]) assert.ok(!audit.includes(secret), `${secret} must not be in the audit log`);
    assert.ok(existsSync(join(home, "state", "shop.json")));
  });

  it("works from the command line", TIMEOUT, async () => {
    const run = promisify(execFile);
    const env = { ...process.env, UNWALLED_HOME: home };
    assert.match((await run(process.execPath, [BIN, "--version"], { env })).stdout, /^\d+\.\d+\.\d+/);
    const list = await run(process.execPath, [BIN, "list"], { env });
    assert.match(list.stdout, /Recipe "pets" \(openapi\)/);
    assert.match((await run(process.execPath, [BIN, "check", "pets"], { env })).stdout, /Health of "pets"/);
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
