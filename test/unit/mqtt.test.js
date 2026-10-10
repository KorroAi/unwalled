import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { asyncApiToStreams } from "../../src/discovery/asyncapi.js";
import { listenMqtt, packetReader, parsePublish, publishPacket, subscribePacket } from "../../src/realtime/mqtt.js";

/** MQTT topic filter matching with + and # wildcards. */
function matches(filter, topic) {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/** Tiny QoS 0 broker: user "u" / password "p", periodic temperature readings, relays client publications. */
async function startBroker() {
  /** @type {Set<{ socket: import("node:net").Socket, filters: string[] }>} */ const clients = new Set();
  const published = [];
  const server = createServer((socket) => {
    const client = { socket, filters: /** @type {string[]} */ ([]) };
    const reader = packetReader();
    let n = 0;
    const ticker = setInterval(() => {
      n++;
      for (const [topic, value] of [["home/livingroom/temperature", 20 + n], ["home/kitchen/temperature", 18 + n], ["home/door", "closed"]]) {
        if (client.filters.some((f) => matches(f, String(topic)))) socket.write(publishPacket(String(topic), typeof value === "number" ? JSON.stringify({ celsius: value }) : String(value)));
      }
    }, 30);
    socket.on("close", () => {
      clearInterval(ticker);
      clients.delete(client);
    });
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      for (const p of reader.push(chunk)) {
        if (p.type === 1) {
          const body = p.body;
          const flags = body[7];
          let offset = 10;
          const read = () => {
            const length = body.readUInt16BE(offset);
            const text = body.subarray(offset + 2, offset + 2 + length).toString("utf8");
            offset += 2 + length;
            return text;
          };
          read(); // client id
          const username = flags & 0x80 ? read() : undefined;
          const password = flags & 0x40 ? read() : undefined;
          const ok = username === "u" && password === "p";
          socket.write(Buffer.from([0x20, 2, 0, ok ? 0 : 5]));
          if (ok) clients.add(client);
          else socket.end();
        } else if (p.type === 8) {
          let offset = 2;
          const codes = [];
          while (offset < p.body.length) {
            const length = p.body.readUInt16BE(offset);
            client.filters.push(p.body.subarray(offset + 2, offset + 2 + length).toString("utf8"));
            offset += 3 + length;
            codes.push(0);
          }
          socket.write(Buffer.from([0x90, 2 + codes.length, p.body[0], p.body[1], ...codes]));
        } else if (p.type === 3) {
          const message = parsePublish(p);
          published.push({ topic: message.topic, payload: message.payload.toString("utf8") });
          for (const other of clients) if (other.filters.some((f) => matches(f, message.topic))) other.socket.write(publishPacket(message.topic, message.payload.toString("utf8")));
        } else if (p.type === 12) socket.write(Buffer.from([0xd0, 0]));
        else if (p.type === 14) socket.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  return {
    url: `mqtt://127.0.0.1:${port}`,
    published,
    close: () => new Promise((resolve) => {
      for (const c of clients) c.socket.destroy();
      server.close(() => resolve(undefined));
    }),
  };
}

describe("MQTT", () => {
  let broker;
  before(async () => (broker = await startBroker()));
  after(() => broker.close());

  it("subscribes with wildcards, publishes and collects messages", async () => {
    const result = await listenMqtt(broker.url, {
      topics: ["home/+/temperature"], publish: [{ topic: "home/livingroom/temperature", message: '{"celsius":99}' }],
      username: "u", password: "p", durationMs: 2000, maxMessages: 6,
    });
    assert.equal(result.opened, true, result.error);
    assert.equal(result.messages.length, 6);
    const topics = new Set(result.messages.map((m) => JSON.parse(m.data).topic));
    assert.deepEqual([...topics].sort(), ["home/kitchen/temperature", "home/livingroom/temperature"]);
    assert.ok(result.messages.every((m) => typeof JSON.parse(m.data).payload.celsius === "number"));
    assert.deepEqual(broker.published, [{ topic: "home/livingroom/temperature", payload: '{"celsius":99}' }]);
  });

  it("encodes the requested subscription QoS", () => {
    assert.deepEqual([...subscribePacket(7, ["a/b"], 1)], [0x82, 8, 0, 7, 0, 3, 0x61, 0x2f, 0x62, 1]);
    assert.equal(subscribePacket(7, ["a/b"]).at(-1), 0);
  });

  it("reports refused credentials", async () => {
    const result = await listenMqtt(broker.url, { topics: ["#"], username: "u", password: "wrong", durationMs: 1000, maxMessages: 1 });
    assert.equal(result.opened, false);
    assert.match(result.error ?? "", /not authorized/);
  });

  it("turns AsyncAPI MQTT channels into stream tools that use stored credentials", async () => {
    const home = mkdtempSync(join(tmpdir(), "umcp-mqtt-"));
    process.env.UNIVERSAL_MCP_HOME = home;
    const { loadConfig } = await import("../../src/config.js");
    const { Engine } = await import("../../src/core.js");
    const engine = new Engine(loadConfig());
    try {
      const port = new URL(broker.url).port;
      const doc = {
        asyncapi: "2.6.0", info: { title: "Home", version: "1" },
        servers: { broker: { url: `127.0.0.1:${port}`, protocol: "mqtt" } },
        channels: { "home/{room}/temperature": { subscribe: { message: { payload: { type: "object", properties: { celsius: { type: "number" } } } } } } },
      };
      assert.deepEqual(asyncApiToStreams(doc).streams.map((s) => [s.kind, s.url, s.topics]), [["mqtt", `mqtt://127.0.0.1:${port}`, ["home/+/temperature"]]]);
      const file = join(home, "home.asyncapi.json");
      writeFileSync(file, JSON.stringify(doc));
      await engine.importFile({ name: "home", path: file });
      engine.setCredentials({ name: "home", host: `127.0.0.1:${port}`, headers: { "mqtt-username": "u", "mqtt-password": "p" } });
      const tool = engine.tools.get("home__stream_home_room_temperature");
      assert.ok(tool, engine.toolsOf("home").map((t) => t.name).join(", "));
      const result = await tool.run({ duration_seconds: 2, max_messages: 2, pick: "payload.celsius" });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.text.split("\n").filter((line) => /^\[\+\d+ms\] \d+$/.test(line)).length, 2, result.text);
      const generic = await engine.tools.get("home__stream").run({ url: `mqtt://u:p@127.0.0.1:${port}`, topics: ["home/door"], duration_seconds: 2, max_messages: 1 });
      assert.match(generic.text, /"payload":"closed"/);
    } finally {
      await engine.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
