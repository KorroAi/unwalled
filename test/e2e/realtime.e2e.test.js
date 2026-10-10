// End-to-end: a real browser captures a page's WebSocket and EventSource, then the generated tools replay them.
// Requires a Chromium-based browser (Chrome by default; set UNIVERSAL_MCP_BROWSER=chromium on CI).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import { Engine } from "../../src/core.js";
import { AUTH_TOKEN, startRealtimeFixture, WS_TOKEN } from "./realtime-fixture.js";

const TIMEOUT = { timeout: 120_000 };

describe("realtime streams (browser capture)", TIMEOUT, () => {
  /** @type {string} */ let home;
  /** @type {Awaited<ReturnType<typeof startRealtimeFixture>>} */ let fixture;
  /** @type {Engine} */ let engine;

  before(async () => {
    home = mkdtempSync(join(tmpdir(), "umcp-rt-"));
    process.env.UNIVERSAL_MCP_HOME = home;
    fixture = await startRealtimeFixture();
    engine = new Engine(loadConfig());
  });
  after(async () => {
    await engine?.close();
    await fixture?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("captures the WebSocket protocol and the event stream", TIMEOUT, async () => {
    const recipe = await engine.discover({ name: "live", url: fixture.url, mode: "browser", actions: [{ wait: 1500 }] });
    const ws = recipe.streams.find((s) => s.kind === "websocket");
    const sse = recipe.streams.find((s) => s.kind === "sse");
    assert.ok(ws, JSON.stringify(recipe.streams));
    assert.ok(sse, JSON.stringify(recipe.streams));
    assert.match(ws.url, /\/ws\/prices\?token=REDACTED$/);
    assert.deepEqual(ws.send.map((f) => JSON.parse(f.data).type), ["auth", "subscribe"]);
    assert.ok(ws.messageTypes.some((t) => t.key === "type" && t.values.price > 0));
    assert.ok(sse.received > 0 && /topic/.test(sse.messageShape), JSON.stringify(sse));

    const saved = readFileSync(join(home, "recipes", "live.json"), "utf8");
    assert.ok(!saved.includes(WS_TOKEN) && !saved.includes(AUTH_TOKEN), "secrets must not be written into the recipe");
    const names = engine.toolsOf("live").map((t) => t.name);
    assert.ok(names.includes("live__stream_ws_prices") && names.includes("live__stream_sse_events") && names.includes("live__stream"), names.join(", "));
  });

  it("replays the WebSocket with the profile cookie, the Origin and the stored secrets", TIMEOUT, async () => {
    const before = fixture.stats.subscribed;
    const result = await engine.tools.get("live__stream_ws_prices")?.run({ duration_seconds: 4, max_messages: 4, filter: '"price"', pick: "p" });
    assert.equal(result?.isError, false, result?.text);
    assert.equal(result?.text.split("\n").filter((line) => /^\[\+\d+ms\] \d+$/.test(line)).length, 4, result?.text);
    assert.equal(fixture.stats.subscribed, before + 1);
    assert.match(String(fixture.stats.lastHeaders.cookie), /sid=abc/);
  });

  it("listens to the event stream", TIMEOUT, async () => {
    const result = await engine.tools.get("live__stream_sse_events")?.run({ duration_seconds: 3, max_messages: 2 });
    assert.equal(result?.isError, false, result?.text);
    assert.equal(result?.text.split("\n").filter((line) => line.includes('"tick"')).length, 2, result?.text);
  });

  it("connects to an arbitrary stream URL with the generic tool", TIMEOUT, async () => {
    const result = await engine.tools.get("live__stream")?.run({
      url: `${fixture.url.replace(/^http/, "ws")}/ws/prices?token=${WS_TOKEN}`,
      duration_seconds: 1, max_messages: 1,
    });
    assert.equal(result?.isError, false, result?.text);
    assert.match(result?.text ?? "", /"welcome"/);
  });
});
