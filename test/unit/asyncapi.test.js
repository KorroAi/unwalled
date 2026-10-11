import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { asyncApiToStreams } from "../../src/discovery/asyncapi.js";
import { readVariablesFile } from "../../src/discovery/variables.js";
import { AUTH_TOKEN, startRealtimeFixture, WS_TOKEN } from "../e2e/realtime-fixture.js";

describe("variables files", () => {
  let dir;
  before(() => (dir = mkdtempSync(join(tmpdir(), "umcp-vars-"))));
  after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));

  it("reads Postman environments, .env files and JSON objects", () => {
    writeFileSync(join(dir, "env.json"), JSON.stringify({ name: "prod", values: [{ key: "baseUrl", value: "https://a.io", enabled: true }, { key: "off", value: "x", enabled: false }] }));
    assert.deepEqual(readVariablesFile(join(dir, "env.json")), { baseUrl: "https://a.io" });
    writeFileSync(join(dir, ".env"), '# comment\nexport HOST="https://b.io"\nTOKEN=abc # trailing\nEMPTY=\n');
    assert.deepEqual(readVariablesFile(join(dir, ".env")), { HOST: "https://b.io", TOKEN: "abc", EMPTY: "" });
    writeFileSync(join(dir, "plain.json"), '{"host":"c.io","port":8080,"nested":{"x":1}}');
    assert.deepEqual(readVariablesFile(join(dir, "plain.json")), { host: "c.io", port: "8080" });
  });
});

describe("AsyncAPI", () => {
  it("converts a 3.0 document: send examples become default frames, receive payloads the message shape", () => {
    const doc = {
      asyncapi: "3.0.0",
      info: { title: "Ticker" },
      servers: { prod: { host: "stream.example.com", pathname: "/v1", protocol: "wss" }, broker: { host: "mq.example.com", protocol: "mqtt" } },
      channels: { prices: { address: "prices", messages: { tick: { $ref: "#/components/messages/Tick" }, sub: { $ref: "#/components/messages/Subscribe" } } } },
      operations: {
        receiveTicks: { action: "receive", channel: { $ref: "#/channels/prices" }, messages: [{ $ref: "#/components/messages/Tick" }] },
        subscribe: { action: "send", channel: { $ref: "#/channels/prices" }, messages: [{ $ref: "#/components/messages/Subscribe" }] },
      },
      components: {
        messages: {
          Tick: { name: "tick", payload: { type: "object", properties: { symbol: { type: "string" }, price: { type: "number" } } } },
          Subscribe: { name: "subscribe", payload: { type: "object" }, examples: [{ payload: { op: "subscribe", symbols: ["BTC"] } }] },
        },
      },
    };
    const { title, baseUrl, streams, warnings } = asyncApiToStreams(doc);
    assert.equal(title, "Ticker");
    assert.equal(baseUrl, "https://stream.example.com");
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, "wss://stream.example.com/v1/prices");
    assert.deepEqual(streams[0].send, [{ data: '{"op":"subscribe","symbols":["BTC"]}', afterReceived: 0 }]);
    assert.match(streams[0].messageShape, /symbol: string/);
    assert.match(warnings.join(" "), /mqtt/);
  });

  describe("import_file with a live WebSocket server", () => {
    let fixture, home, engine;
    before(async () => {
      fixture = await startRealtimeFixture();
      home = mkdtempSync(join(tmpdir(), "umcp-async-"));
      process.env.UNWALLED_HOME = home;
      const { loadConfig } = await import("../../src/config.js");
      const { Engine } = await import("../../src/core.js");
      engine = new Engine(loadConfig());
    });
    after(async () => {
      await engine?.close();
      await fixture?.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    });

    it("creates a stream tool that connects with stored credentials", async () => {
      const file = join(home, "asyncapi.yaml");
      writeFileSync(
        file,
        [
          "asyncapi: '2.6.0'",
          "info: { title: Live prices, version: '1' }",
          "servers:",
          `  local: { url: '${fixture.url.replace(/^http/, "ws")}', protocol: ws }`,
          "channels:",
          "  /ws/prices:",
          "    publish:",
          "      message:",
          `        examples: [{ payload: { type: auth, token: '${AUTH_TOKEN}' } }]`,
          "    subscribe:",
          "      message: { payload: { type: object, properties: { type: { type: string } } } }",
        ].join("\n"),
      );
      const recipe = await engine.importFile({ name: "async", path: file });
      assert.equal(recipe.source.format, "asyncapi");
      const host = new URL(fixture.url).host;
      engine.setCredentials({ name: "async", host, headers: { cookie: "sid=abc", "?token": WS_TOKEN } });
      const tool = engine.tools.get("async__stream_ws_prices");
      assert.ok(tool, engine.toolsOf("async").map((t) => t.name).join(", "));
      const result = await tool.run({ query: { token: WS_TOKEN }, duration_seconds: 2, max_messages: 1, filter: "authed" });
      assert.equal(result.isError, false, result.text);
      assert.match(result.text, /"authed"/);
    });
  });
});
