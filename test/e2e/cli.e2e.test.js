// End-to-end first steps, as a new user takes them: the help, "unwalled demo" (sample back office discovered by itself),
// "unwalled add" for a file, then an MCP client asking the generated tools.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BIN = fileURLToPath(new URL("../../bin/unwalled.js", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
let home;
/** @type {import("node:child_process").ChildProcess | undefined} */ let demo;

/** @param {string[]} args */
const run = (args) => spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, UNWALLED_HOME: home }, encoding: "utf8", timeout: 120_000 });

describe("first steps from the command line", () => {
  before(() => {
    home = mkdtempSync(join(tmpdir(), "unwalled-cli-"));
  });
  after(() => {
    demo?.kill();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  it("starts with the getting-started commands and refuses a wizard without a terminal", () => {
    const help = run(["--help"]);
    assert.match(help.stdout, /^Getting started:\n {2}unwalled setup/m);
    const setup = run(["setup"]);
    assert.equal(setup.status, 1);
    assert.match(setup.stderr, /run it in a terminal, or add --yes/);
  });

  it("runs the demo, then an MCP client answers from its tools", { timeout: 180_000 }, async () => {
    demo = spawn(process.execPath, [BIN, "demo", "--port", "0"], { env: { ...process.env, UNWALLED_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    demo.stdout?.on("data", (chunk) => (out += chunk));
    demo.stderr?.on("data", (chunk) => (out += chunk));
    const deadline = Date.now() + 150_000;
    while (!/Press Ctrl\+C/.test(out)) {
      if (Date.now() > deadline || demo.exitCode !== null) assert.fail(`the demo did not start:\n${out}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.match(out, /✔ "acme" is ready: \d+ tools/);
    assert.match(out, /alice, password demo/);
    assert.match(out, /order 1042/);

    const client = new Client({ name: "cli-e2e", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN], env: { ...process.env, UNWALLED_HOME: home }, stderr: "ignore" }));
    try {
      const result = await client.callTool({ name: "acme__get_api_v2_orders_order", arguments: { order: "1042", pick: "status,total" } }, undefined, { timeout: 120_000 });
      const text = /** @type {any} */ (result.content)[0].text;
      assert.equal(result.isError, false, text);
      assert.match(text, /HTTP 200[\s\S]*"status"/);
    } finally {
      await client.close();
    }
  });

  it("adds a file with one command and lists it", () => {
    const added = run(["add", fixture("sample.xlsx")]);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /✔ "sample" is ready: 2 tools/);
    assert.match(added.stdout, /Ask your agent, for example/);
    const again = run(["add", fixture("sample.xlsx")]);
    assert.match(again.stdout, /"sample-2" is ready/, "an existing recipe is never replaced by a new add");
    assert.match(run(["list"]).stdout, /Recipe "acme"[\s\S]*Recipe "sample"/);
  });
});
