// End-to-end on the example internal app (examples/intranet): sign in through the browser once, then answer from the
// generated tools, with the session kept. This is the scenario of the README demo and of the benchmark.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startIntranet } from "../../examples/intranet/server.js";

const BIN = fileURLToPath(new URL("../../bin/unwalled.js", import.meta.url));
let home;
let intranet;
/** @type {Client} */ let client;
/** The server's log: shown when a call fails outright (the server stopped), to find out why. */
let serverLog = "";

async function call(name, args = {}) {
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 170_000 });
    return { text: /** @type {any} */ (result.content)[0].text, isError: !!result.isError };
  } catch (error) {
    throw new Error(`${name} failed: ${error?.message ?? error}
--- server log (end) ---
${serverLog.slice(-4000)}`);
  }
}

describe("example internal app", () => {
  before(async () => {
    home = mkdtempSync(join(tmpdir(), "unwalled-intranet-"));
    intranet = await startIntranet();
    client = new Client({ name: "e2e", version: "0.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env: { ...process.env, UNWALLED_HOME: home }, stderr: "pipe" });
    transport.stderr?.on("data", (chunk) => (serverLog = (serverLog + chunk).slice(-20_000)));
    await client.connect(transport);
  });

  after(async () => {
    await client?.close().catch(() => {});
    await intranet?.close();
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  it("signs in once, then answers from tools with the saved session", { timeout: 180_000 }, async () => {
    const discovered = await call("discover", {
      name: "acme", url: `${intranet.url}/login`, mode: "browser",
      actions: [{ fill: "#user", text: "alice" }, { fill: "#password", text: "demo" }, { click: "button[type=submit]" }, { goto: "/orders/1001" }],
    });
    assert.equal(discovered.isError, false, discovered.text);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const expected of ["acme__get_api_v2_orders", "acme__get_api_v2_orders_order", "acme__get_api_v2_customers_customer"])
      assert.ok(names.includes(expected), `${expected} missing from ${names.join(", ")}`);

    const order = intranet.orders.find((o) => o.id === 1042);
    const answer = await call("acme__get_api_v2_orders_order", { path: { order: "1042" }, pick: "status,total" });
    assert.match(answer.text, /HTTP 200/);
    assert.match(answer.text, new RegExp(`"${order.status}"[\\s\\S]*${order.total}`));
    const paid = await call("acme__get_api_v2_orders", { query: { status: "paid", per_page: 3 }, pick: "orders[*].id" });
    assert.match(paid.text, /HTTP 200[\s\S]*\d{4}/, "a query parameter the capture never saw with this value");
  });

  // What a real agent did (bench/agent.js): it guessed the sign-in selectors, passed path values at the top level,
  // and wrote to a form protected by a Rails-style CSRF token without knowing about the token.
  it("signs in with guessed selectors, accepts flat arguments and fills a form's CSRF token", { timeout: 180_000 }, async () => {
    const discovered = await call("discover", {
      name: "bo", url: `${intranet.url}/login`, mode: "browser",
      actions: [
        { fill: "input[name=username]", text: "alice" }, { fill: "#pass", text: "demo" }, { click: "#login-button" },
        { goto: "/orders/1003" }, { fill: "#note", text: "first" }, { click: "#add-note" }, { wait: 500 },
      ],
    });
    assert.equal(discovered.isError, false, discovered.text);
    assert.match(discovered.text, /used the page's user field \(#user\)/);
    assert.match(discovered.text, /used the page's password field \(#password\)/);
    assert.match(discovered.text, /used the page's submit button/);
    // What was typed never reaches the shareable recipe: not in warnings, not in captured bodies.
    const saved = readFileSync(join(home, "recipes", "bo.json"), "utf8");
    assert.doesNotMatch(saved, /\bdemo\b/);
    assert.doesNotMatch(discovered.text, /"text":"demo"/);

    const order = intranet.orders.find((o) => o.id === 1050);
    const flat = await call("bo__get_api_v2_orders_order", { order: "1050", pick: "total" });
    assert.match(flat.text, new RegExp(`HTTP 200[\\s\\S]*${order.total}`));

    const note = await call("bo__post_api_v2_orders_order_notes", { path: { order: "1050" }, body: { text: "called the customer" } });
    assert.match(note.text, /HTTP 200[\s\S]*called the customer/, note.text);
  });

  it("turns server-rendered pages into tools, and reports an ended session instead of reading the sign-in page", { timeout: 180_000 }, async () => {
    const discovered = await call("discover", {
      name: "crm", url: `${intranet.url}/login`, mode: "browser",
      actions: [
        { fill: "#user", text: "alice" }, { fill: "#password", text: "demo" }, { click: "button[type=submit]" }, { goto: "/customers?city=Lyon" }, { goto: "/customers/512" },
        { fill: "#contact-note", text: "first call" }, { click: "#save-note" },
      ],
    });
    assert.match(discovered.text, /Page http:\/\/127\.0\.0\.1:\d+\/customers\?city \(server-rendered, 1 table\(s\)\)/, discovered.text);
    assert.match(discovered.text, /Page http:\/\/127\.0\.0\.1:\d+\/customers\/\{customer\}/);
    assert.doesNotMatch(discovered.text, /No API call was observed/);
    assert.doesNotMatch(discovered.text, /crm__post_login/, "the sign-in form is not a tool (seen with a real agent: it called it for nothing)");

    const customer = intranet.customers.find((c) => c.id === 530);
    const record = await call("crm__page_customers_customer", { customer: "530", pick: "fields" });
    assert.match(record.text, new RegExp(`"City": "${customer.city}"`), record.text);
    assert.match(record.text, /"Total ordered": "\d+ EUR"/);

    const list = await call("crm__page_customers", { query: { city: "Nantes" }, pick: "tables[0].rows[*].Company" });
    const expected = intranet.customers.filter((c) => c.city === "Nantes").map((c) => c.company);
    for (const company of expected) assert.ok(list.text.includes(company), `${company} missing from ${list.text}`);

    // The HTML form posted during discovery is a tool too; its Django-style CSRF field is filled with the session's token.
    const saved = await call("crm__post_customers_customer_notes", { path: { customer: "530" }, body: { note: "asked for a quote" } });
    assert.match(saved.text, /HTTP 200[\s\S]*asked for a quote/, saved.text);

    // Signing out ends the session server-side: the page now redirects to /login, which must not pass for data.
    await call("crm__request", { method: "GET", url: "/logout" });
    const after = await call("crm__page_customers_customer", { path: { customer: "530" } });
    assert.match(after.text, /HTTP 401 Redirected to the sign-in page/, after.text);
    assert.equal(after.isError, true);
  });

  it("lists the page's real fields when a step cannot be resolved", { timeout: 120_000 }, async () => {
    const discovered = await call("discover", { name: "bo2", url: `${intranet.url}/login`, mode: "browser", actions: [{ fill: "#search-box", text: "x" }] });
    assert.match(discovered.text, /fields on .*\/login: #user \(text "User"\), #password \(password "Password"\), button\[type=submit\] \(button "Sign in"\)/);
  });
});
