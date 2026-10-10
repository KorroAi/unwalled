// Minimal MQTT 3.1.1 client (QoS 0): connect, subscribe to topics, optionally publish, collect messages for a bounded time.
// Transports: mqtt:// (TCP), mqtts:// (TLS), ws:// and wss:// (WebSocket, "mqtt" subprotocol).
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { messageFilter } from "./client.js";

/** @param {number} length */
function encodeLength(length) {
  const bytes = [];
  do {
    let byte = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) byte |= 0x80;
    bytes.push(byte);
  } while (length > 0);
  return Buffer.from(bytes);
}

/** @param {string} text */
function encodeString(text) {
  const bytes = Buffer.from(text, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** @param {number} type first byte @param {Buffer[]} parts */
function packet(type, parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([type]), encodeLength(body.length), body]);
}

/** @param {{ clientId: string, username?: string, password?: string, keepAlive?: number }} options */
export function connectPacket({ clientId, username, password, keepAlive = 60 }) {
  let flags = 0x02; // clean session
  if (username !== undefined) flags |= 0x80;
  if (password !== undefined) flags |= 0x40;
  const keep = Buffer.alloc(2);
  keep.writeUInt16BE(keepAlive);
  return packet(0x10, [encodeString("MQTT"), Buffer.from([4, flags]), keep, encodeString(clientId), ...(username !== undefined ? [encodeString(username)] : []), ...(password !== undefined ? [encodeString(password)] : [])]);
}

/** @param {number} id @param {string[]} topics @param {0 | 1} [qos] */
export function subscribePacket(id, topics, qos = 0) {
  const packetId = Buffer.alloc(2);
  packetId.writeUInt16BE(id);
  return packet(0x82, [packetId, ...topics.flatMap((t) => [encodeString(t), Buffer.from([qos])])]);
}

/** @param {string} topic @param {string} message @param {boolean} [retain] */
export function publishPacket(topic, message, retain = false) {
  return packet(0x30 | (retain ? 1 : 0), [encodeString(topic), Buffer.from(message, "utf8")]);
}

/**
 * Incremental packet reader.
 * @returns {{ push: (chunk: Buffer) => { type: number, flags: number, body: Buffer }[] }}
 */
export function packetReader() {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const packets = [];
      for (;;) {
        if (buffer.length < 2) break;
        let multiplier = 1;
        let length = 0;
        let offset = 1;
        let complete = false;
        for (; offset < Math.min(buffer.length, 5); offset++) {
          length += (buffer[offset] & 0x7f) * multiplier;
          multiplier *= 128;
          if (!(buffer[offset] & 0x80)) {
            complete = true;
            offset++;
            break;
          }
        }
        if (!complete || buffer.length < offset + length) break;
        packets.push({ type: buffer[0] >> 4, flags: buffer[0] & 0x0f, body: buffer.subarray(offset, offset + length) });
        buffer = buffer.subarray(offset + length);
      }
      return packets;
    },
  };
}

/** @param {{ flags: number, body: Buffer }} p */
export function parsePublish(p) {
  const topicLength = p.body.readUInt16BE(0);
  const topic = p.body.subarray(2, 2 + topicLength).toString("utf8");
  const qos = (p.flags >> 1) & 3;
  const payload = p.body.subarray(2 + topicLength + (qos ? 2 : 0));
  return { topic, payload, qos, packetId: qos ? p.body.readUInt16BE(2 + topicLength) : undefined };
}

/**
 * @param {string} url mqtt://, mqtts://, ws:// or wss://
 * @param {{ topics: string[], qos?: 0 | 1, publish?: { topic: string, message: string, retain?: boolean }[], username?: string, password?: string,
 *   durationMs: number, maxMessages: number, filter?: string, connectTimeoutMs?: number }} options
 * @returns {Promise<import("./client.js").StreamResult>}
 */
export function listenMqtt(url, { topics, qos = 0, publish = [], username, password, durationMs, maxMessages, filter, connectTimeoutMs = 15_000 }) {
  const keep = messageFilter(filter);
  const target = new URL(url);
  /** @type {import("./client.js").StreamResult} */ const result = { opened: false, messages: [], received: 0, sent: 0, durationMs: 0 };
  return new Promise((resolve) => {
    let finished = false;
    let openedAt = Date.now();
    const reader = packetReader();
    /** @type {NodeJS.Timeout | undefined} */ let timer;
    /** @type {NodeJS.Timeout | undefined} */ let pinger;
    /** @type {(data: Buffer) => void} */ let write = () => {};
    /** @type {() => void} */ let close = () => {};
    const finish = (/** @type {string | undefined} */ error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(pinger);
      if (error) result.error = error;
      result.durationMs = result.opened ? Date.now() - openedAt : 0;
      try {
        write(Buffer.from([0xe0, 0])); // DISCONNECT
      } catch {}
      close();
      resolve(result);
    };
    timer = setTimeout(() => finish(`no CONNACK within ${connectTimeoutMs} ms`), connectTimeoutMs);
    const onData = (/** @type {Buffer} */ chunk) => {
      for (const p of reader.push(chunk)) {
        if (p.type === 2) {
          const code = p.body[1];
          if (code !== 0) return finish(`connection refused by the broker (CONNACK code ${code}${code === 4 || code === 5 ? ": bad credentials / not authorized" : ""})`);
          result.opened = true;
          openedAt = Date.now();
          clearTimeout(timer);
          timer = setTimeout(() => finish(undefined), durationMs);
          pinger = setInterval(() => write(Buffer.from([0xc0, 0])), 30_000);
          if (topics.length) write(subscribePacket(1, topics, qos));
          for (const message of publish) {
            write(publishPacket(message.topic, message.message, message.retain));
            result.sent++;
          }
        } else if (p.type === 3) {
          const message = parsePublish(p);
          if (message.qos === 1 && message.packetId !== undefined) write(Buffer.from([0x40, 2, message.packetId >> 8, message.packetId & 0xff])); // PUBACK
          result.received++;
          const text = message.payload.toString("utf8");
          const data = JSON.stringify({ topic: message.topic, payload: /^\s*[[{]/.test(text) ? safeJson(text) : text });
          if (finished || !keep(data)) continue;
          result.messages.push({ at: Date.now() - openedAt, data });
          if (result.messages.length >= maxMessages) return finish(undefined);
        } else if (p.type === 9 && p.body.subarray(2).some((code) => code === 0x80)) {
          result.error = "the broker refused a subscription (SUBACK 0x80)";
        }
      }
    };
    const connectFrame = connectPacket({ clientId: `unwalled-${Math.random().toString(16).slice(2, 10)}`, username, password });

    if (/^wss?:$/.test(target.protocol)) {
      const socket = new WebSocket(url, ["mqtt"]);
      socket.binaryType = "arraybuffer";
      write = (data) => socket.readyState === socket.OPEN && socket.send(data);
      close = () => socket.close();
      socket.addEventListener("open", () => write(connectFrame));
      socket.addEventListener("message", (event) => onData(Buffer.from(/** @type {ArrayBuffer} */ (event.data))));
      socket.addEventListener("close", (event) => finish(result.opened ? undefined : `connection closed (${event.code})`));
      socket.addEventListener("error", () => finish(result.opened ? undefined : "connection failed"));
      return;
    }
    const secure = target.protocol === "mqtts:";
    const port = Number(target.port || (secure ? 8883 : 1883));
    const socket = secure ? tlsConnect({ host: target.hostname, port, servername: target.hostname }) : tcpConnect({ host: target.hostname, port });
    write = (data) => !socket.destroyed && socket.write(data);
    close = () => socket.end();
    socket.on(secure ? "secureConnect" : "connect", () => write(connectFrame));
    socket.on("data", onData);
    socket.on("error", (error) => finish(result.opened ? undefined : `connection failed: ${error.message}`));
    socket.on("close", () => finish(undefined));
  });
}

/** @param {string} text */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
