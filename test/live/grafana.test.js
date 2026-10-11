// A real internal tool behind a sign-in: Grafana. Skipped unless UNWALLED_GRAFANA_URL is set, e.g. a throwaway container
// whose session token rotates every minute:
//   docker run -d --name umcp-grafana -p 127.0.0.1:3300:3000 -e GF_SECURITY_ADMIN_PASSWORD=unwalled-test \
//     -e GF_AUTH_TOKEN_ROTATION_INTERVAL_MINUTES=1 grafana/grafana:12.1.1
//   UNWALLED_GRAFANA_URL=http://127.0.0.1:3300 UNWALLED_GRAFANA_PASSWORD=unwalled-test node --test test/live/grafana.test.js
// It signs in with selectors an agent would guess (not Grafana's real ones), discovers the app's internal API, answers
// from a generated tool, then again after the session token has rotated. Takes about two minutes.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const base = process.env.UNWALLED_GRAFANA_URL;
const password = process.env.UNWALLED_GRAFANA_PASSWORD ?? "admin";
const TITLE = `Unwalled sales ${Date.now()}`;

describe("Grafana behind a sign-in", { skip: !base && "set UNWALLED_GRAFANA_URL to run" }, () => {
  /** @type {string} */ let home;
  /** @type {any} */ let engine;
  before(async () => {
    // A dashboard to look for, created through Grafana's own API.
    const auth = `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
    const created = await fetch(`${base}/api/dashboards/db`, {
      method: "POST", headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ dashboard: { title: TITLE, panels: [] }, overwrite: true }),
    });
    assert.equal(created.status, 200, await created.text());
    home = mkdtempSync(join(tmpdir(), "umcp-grafana-"));
    process.env.UNWALLED_HOME = home;
    const { loadConfig } = await import("../../src/config.js");
    const { Engine } = await import("../../src/core.js");
    engine = new Engine(loadConfig());
  });
  after(async () => {
    await engine?.close();
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  const search = () => [...engine.tools.keys()].find((n) => /^grafana__get_api_search/.test(n));

  it("signs in with guessed selectors and discovers the internal API", async () => {
    const recipe = await engine.discover({
      name: "grafana", url: `${base}/login`, mode: "browser",
      actions: [{ fill: "input[name=username]", text: "admin" }, { fill: "#password-field", text: password }, { click: "button.login-submit" }, { wait: 2000 }, { goto: "/dashboards" }],
    });
    assert.ok(search(), `no search tool: ${[...engine.tools.keys()].filter((n) => n.startsWith("grafana__")).join(", ")} / ${JSON.stringify(recipe.warnings)}`);
    assert.ok(!readFileSync(join(home, "recipes", "grafana.json"), "utf8").includes(password), "the password stays out of the recipe");
  });

  it("answers from the generated tool, and still does after the session token rotated", async () => {
    const tool = engine.tools.get(search());
    const ask = async () => {
      const result = await tool.run({ query: { query: TITLE.slice(0, 20) }, pick: "[*].title" });
      assert.equal(result.isError, false, result.text);
      assert.match(result.text, new RegExp(TITLE));
    };
    await ask();
    await new Promise((resolve) => setTimeout(resolve, 75_000)); // past the one-minute rotation interval
    await ask();
    await new Promise((resolve) => setTimeout(resolve, 75_000));
    await ask();
  });
});
