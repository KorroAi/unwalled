// Found on archive.org: "config.php?key=feature.zendesk_enabled" made "key" a stored secret of the host, which was then
// added to every other call to that host and broke the search. A secret query parameter goes only to endpoints seen with it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

describe("stored secret query parameters", () => {
  const home = mkdtempSync(join(tmpdir(), "unwalled-secret-query-"));
  /** @type {any} */ let engine;
  before(async () => {
    process.env.UNWALLED_HOME = home;
    const { loadConfig } = await import("../../src/config.js");
    const { Engine } = await import("../../src/core.js");
    engine = new Engine(loadConfig());
    engine.setCredentials({ name: "site", host: "archive.test", headers: { "?key": "feature.flag" } });
  });
  after(async () => {
    await engine?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  const recipe = { name: "site", kind: "browser", baseUrl: "https://archive.test" };

  it("are added to endpoints seen with them", () => {
    const out = engine.withCredentials(recipe, { method: "GET", url: "https://archive.test/config.php", queryNames: ["key"] });
    assert.equal(new URL(out.url).searchParams.get("key"), "feature.flag");
    assert.equal("queryNames" in out, false);
  });

  it("are not added to other endpoints of the host", () => {
    const out = engine.withCredentials(recipe, { method: "GET", url: "https://archive.test/search?q=hubble", queryNames: ["q"] });
    assert.equal(new URL(out.url).searchParams.has("key"), false);
  });

  it("are added to free-form requests, which have no endpoint (the request tool)", () => {
    const out = engine.withCredentials(recipe, { method: "GET", url: "https://archive.test/anything" });
    assert.equal(new URL(out.url).searchParams.get("key"), "feature.flag");
  });
});
