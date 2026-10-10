import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { autoReply, listenSse, listenWebSocket, messageFilter, sseParser } from "../../src/realtime/client.js";
import { inferStreams, isHeartbeat, SECRET_FRAME_HOST, streamsFromHar } from "../../src/realtime/infer.js";
import { buildStreamTools, streamUrl } from "../../src/realtime/tools.js";
import { toolNamer } from "../../src/tools/generate.js";
import { AUTH_TOKEN, startRealtimeFixture, WS_TOKEN } from "../e2e/realtime-fixture.js";

describe("SSE parser", () => {
  it("parses events split across chunks, ignores comments and keeps ids and names", () => {
    const parser = sseParser();
    assert.deepEqual(parser.push("event: tick\nid: 1\nda"), []);
    assert.deepEqual(parser.push('ta: {"n":1}\n\n: keep-alive\n\ndata: a\ndata: b\n\n'), [
      { event: "tick", data: '{"n":1}', id: "1" },
      { event: "message", data: "a\nb" },
    ]);
  });
});

describe("stream helpers", () => {
  it("filters messages by text or regex", () => {
    assert.equal(messageFilter("BTC")("price BTC"), true);
    assert.equal(messageFilter("/^\\{\"type\":\"price/")('{"type":"price"}'), true);
    assert.equal(messageFilter("/eth/i")("BTC"), false);
  });
  it("answers protocol heartbeats", () => {
    assert.equal(autoReply("2"), "3");
    assert.equal(autoReply('{"type":"ping"}'), '{"type":"pong"}');
    assert.equal(autoReply('{"type":"price"}'), undefined);
  });
  it("recognises heartbeats", () => {
    for (const text of ["2", "ping", '{"type":"ping"}', '{"op":"heartbeat","d":1}']) assert.equal(isHeartbeat(text), true, text);
    assert.equal(isHeartbeat('{"type":"subscribe","channel":"ping-pong-news","id":1,"extra":2}'), false);
  });
  it("restores secret query values in stream URLs", () => {
    assert.equal(streamUrl("wss://x.io/ws?token=REDACTED&a=1", { token: "s" }, { a: 2, b: "c" }), "wss://x.io/ws?token=s&a=2&b=c");
  });
});

describe("inferStreams", () => {
  const raw = [
    {
      kind: /** @type {const} */ ("websocket"),
      url: `wss://live.example.com/ws/prices?token=${WS_TOKEN}&t=123`,
      frames: [
        { direction: /** @type {const} */ ("received"), data: '{"type":"welcome"}', receivedBefore: 0 },
        { direction: /** @type {const} */ ("sent"), data: JSON.stringify({ type: "auth", token: AUTH_TOKEN }), receivedBefore: 1 },
        { direction: /** @type {const} */ ("received"), data: '{"type":"authed"}', receivedBefore: 1 },
        { direction: /** @type {const} */ ("sent"), data: '{"type":"subscribe","channel":"BTC"}', receivedBefore: 2 },
        { direction: /** @type {const} */ ("sent"), data: '{"type":"pong"}', receivedBefore: 2 },
        { direction: /** @type {const} */ ("received"), data: '{"type":"price","channel":"BTC","p":1}', receivedBefore: 2 },
        { direction: /** @type {const} */ ("received"), data: '{"type":"price","channel":"BTC","p":2}', receivedBefore: 3 },
      ],
    },
    { kind: /** @type {const} */ ("websocket"), url: "wss://www.google-analytics.com/x", frames: [] },
  ];

  it("keeps the protocol, removes heartbeats and moves secrets out of the recipe", () => {
    const { streams, secrets } = inferStreams(raw);
    assert.equal(streams.length, 1);
    const [stream] = streams;
    assert.equal(stream.url, "wss://live.example.com/ws/prices?token=REDACTED");
    assert.deepEqual(stream.send.map((f) => f.afterReceived), [1, 2]);
    assert.equal(stream.send[0].data, '{"type":"auth","token":"REDACTED"}');
    assert.equal(secrets["live.example.com"]["?token"], WS_TOKEN);
    assert.equal(secrets[SECRET_FRAME_HOST("live.example.com")][`${stream.id}#0`], JSON.stringify({ type: "auth", token: AUTH_TOKEN }));
    assert.deepEqual(stream.messageTypes.find((t) => t.key === "type")?.values, { welcome: 1, authed: 1, price: 2 });
    assert.ok(!JSON.stringify(streams).includes(AUTH_TOKEN) && !JSON.stringify(streams).includes(WS_TOKEN));
  });

  it("drops the Engine.IO session id", () => {
    const { streams } = inferStreams([{ kind: "websocket", url: "wss://s.io/socket.io/?EIO=4&transport=websocket&sid=abc", frames: [{ direction: "sent", data: "40", receivedBefore: 1 }] }]);
    assert.equal(streams[0].url, "wss://s.io/socket.io/?EIO=4&transport=websocket");
    assert.equal(streams[0].send[0].data, "40");
  });

  it("reads WebSocket messages and event streams from a HAR file", () => {
    const har = {
      log: {
        entries: [
          {
            request: { url: "https://live.example.com/ws/prices?token=x", method: "GET", headers: [] },
            response: { status: 101, content: {} },
            _resourceType: "websocket",
            _webSocketMessages: [
              { type: "receive", opcode: 1, data: '{"type":"welcome"}' },
              { type: "send", opcode: 1, data: '{"type":"subscribe"}' },
            ],
          },
          {
            request: { url: "https://live.example.com/events", method: "GET", headers: [{ name: "Cookie", value: "sid=1" }] },
            response: { status: 200, content: { mimeType: "text/event-stream", text: "event: tick\ndata: 1\n\ndata: 2\n\n" } },
          },
        ],
      },
    };
    const raw = streamsFromHar(JSON.stringify(har));
    assert.equal(raw[0].url, "wss://live.example.com/ws/prices?token=x");
    assert.deepEqual(raw[0].frames.map((f) => [f.direction, f.receivedBefore]), [["received", 0], ["sent", 1]]);
    assert.deepEqual(raw[1].frames.map((f) => f.data), ['{"event":"tick","data":"1"}', "2"]);
    const { secrets } = inferStreams(raw, { secretCookies: true });
    assert.equal(secrets["live.example.com"].cookie, "sid=1");
  });
});

describe("stream client and tools against a live fixture", () => {
  /** @type {Awaited<ReturnType<typeof startRealtimeFixture>>} */ let fixture;
  before(async () => (fixture = await startRealtimeFixture()));
  after(() => fixture.close());

  const wsUrl = () => `${fixture.url.replace(/^http/, "ws")}/ws/prices?token=${WS_TOKEN}`;
  const headers = () => ({ cookie: "sid=abc", origin: fixture.url });

  it("waits for the server before sending frames that depend on it", async () => {
    const result = await listenWebSocket(wsUrl(), {
      headers: headers(),
      send: [{ data: JSON.stringify({ type: "auth", token: AUTH_TOKEN }), afterReceived: 1 }, { data: '{"type":"subscribe","channel":"BTC"}', afterReceived: 2 }],
      durationMs: 3000, maxMessages: 5, filter: '"price"',
    });
    assert.equal(result.opened, true, result.error);
    assert.equal(result.messages.length, 5);
    assert.equal(result.closed, undefined);
  });

  it("fails without waiting (the fixture is strict about ordering)", async () => {
    const result = await listenWebSocket(wsUrl(), {
      headers: headers(),
      send: [{ data: JSON.stringify({ type: "auth", token: AUTH_TOKEN }) }, { data: '{"type":"subscribe","channel":"BTC"}' }],
      durationMs: 2000, maxMessages: 5, filter: '"price"',
    });
    assert.equal(result.messages.length, 0);
    assert.match(result.closed ?? "", /^4401/);
  });

  it("is rejected without the handshake cookie", async () => {
    const result = await listenWebSocket(wsUrl(), { headers: { origin: fixture.url }, durationMs: 1000, maxMessages: 1 });
    assert.equal(result.opened, false);
    assert.match(result.error ?? "", /connection/);
  });

  it("reads an event stream", async () => {
    const result = await listenSse(`${fixture.url}/events?topic=x`, { durationMs: 2000, maxMessages: 3 });
    assert.equal(result.opened, true, result.error);
    assert.deepEqual(result.messages.map((m) => JSON.parse(m.data).event), ["tick", "tick", "tick"]);
  });

  it("builds tools that replay the captured protocol with stored secrets", async () => {
    const { streams } = inferStreams([
      {
        kind: "websocket", url: wsUrl(),
        frames: [
          { direction: "received", data: '{"type":"welcome"}', receivedBefore: 0 },
          { direction: "sent", data: JSON.stringify({ type: "auth", token: AUTH_TOKEN }), receivedBefore: 1 },
          { direction: "received", data: '{"type":"authed"}', receivedBefore: 1 },
          { direction: "sent", data: '{"type":"subscribe","channel":"BTC"}', receivedBefore: 2 },
        ],
      },
    ]);
    const recipe = { name: "live", kind: "browser", baseUrl: fixture.url, streams };
    const runtime = {
      maxOutputChars: 10_000,
      streamAuth: async () => ({ headers: headers(), query: { token: WS_TOKEN }, frames: { [`${streams[0].id}#0`]: JSON.stringify({ type: "auth", token: AUTH_TOKEN }) } }),
    };
    const tools = buildStreamTools(recipe, runtime, toolNamer("live"));
    assert.deepEqual(tools.map((t) => t.name), ["live__stream_ws_prices", "live__stream"]);
    const result = await tools[0].run({ duration_seconds: 3, max_messages: 3, filter: "price", pick: "p" });
    assert.equal(result.isError, false, result.text);
    assert.equal(result.text.split("\n").filter((line) => /^\[\+\d+ms\] \d+$/.test(line)).length, 3, result.text);
  });
});
