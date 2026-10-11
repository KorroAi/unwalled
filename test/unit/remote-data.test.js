import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { remoteExtension } from "../../src/data/remote.js";

describe("remote data", () => {
  it("guesses the format from the address or the content type", () => {
    assert.equal(remoteExtension("https://x.io/export/data.CSV"), ".csv");
    assert.equal(remoteExtension("https://docs.google.com/spreadsheets/d/abc/export?format=csv"), ".csv");
    assert.equal(remoteExtension("https://calendar.example.com/private-123/basic", "text/calendar; charset=utf-8"), ".ics");
    assert.equal(remoteExtension("https://x.io/api/items", "application/json"), ".json");
    assert.equal(remoteExtension("https://x.io/page", "text/html"), undefined);
  });

  let server, base, home, engine;
  let csv = "symbol,price\nBTC,60000\nETH,3000\n";
  const hits = { csv: 0 };
  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/s3cr3t-token/prices.csv") {
        hits.csv++;
        return res.writeHead(200, { "content-type": "text/csv" }).end(csv);
      }
      if (url.pathname === "/calendar/private-abc123/basic") {
        return res.writeHead(200, { "content-type": "text/calendar" }).end("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20261012T090000Z\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
      }
      res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
    home = mkdtempSync(join(tmpdir(), "umcp-remote-"));
    process.env.UNWALLED_HOME = home;
    const { loadConfig } = await import("../../src/config.js");
    const { Engine } = await import("../../src/core.js");
    engine = new Engine(loadConfig());
  });
  after(async () => {
    await engine?.close();
    await new Promise((resolve) => {
      server.close(() => resolve(undefined));
      server.closeAllConnections(); // open sockets at exit can crash Node on Windows (UV_HANDLE_CLOSING)
    });
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  const query = async (name, sql) => JSON.parse((await /** @type {any} */ (engine.tools.get(`${name}__sql`)).run({ sql })).text.split("\n")[0]).rows;

  it("imports a remote CSV, keeps its address secret and refreshes it after the delay", async () => {
    const recipe = await engine.importFile({ name: "prices", path: `${base}/s3cr3t-token/prices.csv`, refreshSeconds: 10 });
    assert.equal(recipe.kind, "data");
    assert.ok(!readFileSync(join(home, "recipes", "prices.json"), "utf8").includes("s3cr3t"), "the address stays out of the recipe");
    assert.deepEqual(await query("prices", "SELECT symbol FROM prices ORDER BY price DESC"), [{ symbol: "BTC" }, { symbol: "ETH" }]);
    const before = hits.csv;
    await query("prices", "SELECT 1");
    assert.equal(hits.csv, before, "served from the cache within the refresh delay");
    csv = "symbol,price\nSOL,150\n";
    engine.recipes.get("prices").source.refreshSeconds = 0; // force the next call to refresh
    assert.deepEqual(await query("prices", "SELECT symbol FROM prices"), [{ symbol: "SOL" }]);
    await engine.forget("prices");
    assert.equal(existsSync(join(home, "cache", "prices.csv")), false, "forget removes the cached copy");
  });

  it("imports a private calendar address without extension", async () => {
    await engine.importFile({ name: "agenda", path: `${base}/calendar/private-abc123/basic` });
    assert.ok(!readFileSync(join(home, "recipes", "agenda.json"), "utf8").includes("abc123"));
    assert.deepEqual(await query("agenda", "SELECT summary FROM events"), [{ summary: "Standup" }]);
  });

  it("refuses an address whose format is unknown", async () => {
    await assert.rejects(engine.importFile({ name: "nope", path: `${base}/missing` }), /Download failed: HTTP 404/);
  });
});
