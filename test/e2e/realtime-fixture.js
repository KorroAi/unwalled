// Local "live prices" site used by the realtime tests: a page that opens a WebSocket and an EventSource.
// The WebSocket requires a cookie, the site's Origin, a token in the URL and an auth frame, in this order:
//   server: {"type":"welcome"} → client: {"type":"auth","token":...} → server (200 ms later): {"type":"authed"}
//   → client: {"type":"subscribe","channel":"BTC"} → server: {"type":"price",...} every 50 ms.
// A subscribe sent before "authed" closes the connection with 4401, like graphql-ws does.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

export const WS_TOKEN = "t-999";
export const AUTH_TOKEN = "frame-secret-42";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Live prices</title></head><body><pre id="out"></pre>
<script>
document.cookie = "sid=abc; path=/";
const out = (v) => (document.getElementById("out").textContent += v + "\\n");
const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/ws/prices?token=${WS_TOKEN}&t=" + Date.now());
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "welcome") ws.send(JSON.stringify({ type: "auth", token: "${AUTH_TOKEN}" }));
  if (message.type === "authed") ws.send(JSON.stringify({ type: "subscribe", channel: "BTC" }));
  if (message.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
  out(event.data);
};
const events = new EventSource("/events?topic=news");
events.addEventListener("tick", (event) => out(event.data));
</script></body></html>`;

/** @param {string} text */
function encodeFrame(text, opcode = 1) {
  const payload = Buffer.from(text, "utf8");
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, length]) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (length >= 126 && length < 65536) {
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else if (length >= 65536) {
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Minimal RFC 6455 server side: text frames, ping/pong and close. @param {import("node:net").Socket} socket @param {(text: string) => void} onText */
function readFrames(socket, onText) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2 || socket.writableEnded) return;
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (buffer[1] & 0x80) !== 0;
      const total = offset + (masked ? 4 : 0) + length;
      if (buffer.length < total) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), total));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(total);
      if (opcode === 8) {
        if (!socket.writableEnded) socket.end(encodeFrame("", 8));
        return;
      }
      if (opcode === 9) socket.write(encodeFrame(payload.toString("utf8"), 10));
      if (opcode === 1) onText(payload.toString("utf8"));
    }
  });
}

/** @param {import("node:net").Socket} socket @param {number} code @param {string} reason */
function closeWith(socket, code, reason) {
  if (socket.writableEnded) return;
  const body = Buffer.alloc(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2);
  socket.end(Buffer.concat([Buffer.from([0x88, body.length]), body]));
}

export async function startRealtimeFixture() {
  const stats = { connections: 0, rejected: 0, subscribed: 0, lastHeaders: /** @type {Record<string, any>} */ ({}) };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let n = 0;
      const timer = setInterval(() => {
        n++;
        res.write(n % 3 === 0 ? ": keep-alive\n\n" : `event: tick\nid: ${n}\ndata: ${JSON.stringify({ topic: url.searchParams.get("topic"), n })}\n\n`);
      }, 50);
      req.on("close", () => clearInterval(timer));
      res.on("error", () => {});
      return;
    }
    res.writeHead(404).end();
  });
  /** @type {Set<import("node:net").Socket>} */ const sockets = new Set();
  server.on("upgrade", (req, socket) => {
    sockets.add(/** @type {any} */ (socket));
    socket.on("error", () => {}); // the browser may reset the connection when it closes
    socket.on("close", () => sockets.delete(/** @type {any} */ (socket)));
    const url = new URL(req.url ?? "/", "http://localhost");
    const origin = `http://${req.headers.host}`;
    stats.lastHeaders = req.headers;
    if (url.pathname !== "/ws/prices" || url.searchParams.get("token") !== WS_TOKEN || !(req.headers.cookie ?? "").includes("sid=abc") || req.headers.origin !== origin) {
      stats.rejected++;
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    stats.connections++;
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (/** @type {unknown} */ value) => socket.writable && !socket.writableEnded && socket.write(encodeFrame(JSON.stringify(value)));
    send({ type: "welcome", server: "fixture" });
    let authed = false;
    /** @type {NodeJS.Timeout | undefined} */ let ticker;
    socket.on("close", () => clearInterval(ticker));
    readFrames(/** @type {any} */ (socket), (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.type === "auth") {
        if (message.token !== AUTH_TOKEN) return closeWith(/** @type {any} */ (socket), 4403, "bad token");
        setTimeout(() => {
          authed = true;
          send({ type: "authed" });
        }, 200);
      } else if (message.type === "subscribe") {
        if (!authed) return closeWith(/** @type {any} */ (socket), 4401, "subscribe before auth");
        stats.subscribed++;
        let price = 60_000;
        ticker = setInterval(() => {
          price += 1;
          send({ type: "price", channel: message.channel, p: price, ts: Date.now() });
          if (price % 5 === 0) send({ type: "ping" });
        }, 50);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    stats,
    close: () =>
      new Promise((done) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => done(undefined));
      }),
  };
}
