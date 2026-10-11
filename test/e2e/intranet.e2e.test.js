// End-to-end on the example internal app (examples/intranet): sign in through the browser once, then answer from the
// generated tools, with the session kept. This is the scenario of the README demo and of the benchmark.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 170_000 });
  return { text: /** @type {any} */ (result.content)[0].text, isError: !!result.isError };
}

describe("example internal app", () => {
  before(async () => {
    home = mkdtempSync(join(tmpdir(), "unwalled-intranet-"));
    intranet = await startIntranet();
    client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN], env: { ...process.env, UNWALLED_HOME: home }, stderr: "ignore" }));
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

    const order = intranet.orders.find((o) => o.id === 1050);
    const flat = await call("bo__get_api_v2_orders_order", { order: "1050", pick: "total" });
    assert.match(flat.text, new RegExp(`HTTP 200[\\s\\S]*${order.total}`));

    const note = await call("bo__post_api_v2_orders_order_notes", { path: { order: "1050" }, body: { text: "called the customer" } });
    assert.match(note.text, /HTTP 200[\s\S]*called the customer/, note.text);
  });

  it("lists the page's real fields when a step cannot be resolved", { timeout: 120_000 }, async () => {
    const discovered = await call("discover", { name: "bo2", url: `${intranet.url}/login`, mode: "browser", actions: [{ fill: "#search-box", text: "x" }] });
    assert.match(discovered.text, /fields on .*\/login: #user \(text "User"\), #password \(password "Password"\), button\[type=submit\] \(button "Sign in"\)/);
  });
});
