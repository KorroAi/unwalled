// Turns recorded WebSocket / SSE streams into replayable stream descriptions (shareable, secrets removed).
import { isTracker, redact, redactText, redactUrl, splitHeaders } from "../discovery/infer.js";
import { describeShape, inferSchema } from "../tools/schema.js";
import { sseMessageText, sseParser } from "./client.js";

/**
 * @typedef {object} Stream
 * @property {string} id stable identifier within the recipe
 * @property {"websocket" | "sse"} kind
 * @property {string} url secrets replaced by "REDACTED" (their values are stored as "?name" secrets of the host)
 * @property {string} [method] SSE only
 * @property {string} [body] SSE only, redacted
 * @property {Record<string, string>} headers non-secret request headers worth replaying
 * @property {{ data: string, afterReceived: number }[]} send client frames replayed on connection (heartbeats removed), redacted
 * @property {{ key: string, values: Record<string, number> }[]} messageTypes discriminator values seen in server messages
 * @property {string} messageShape
 * @property {string[]} samples a few short server messages
 * @property {number} observed connections seen
 * @property {number} received server messages seen
 */

// Placeholder for a secret client frame: the original frame is a local secret.
export const SECRET_FRAME_HOST = (/** @type {string} */ host) => `~frames~${host}`;

const MAX_SEND_FRAMES = 10;
const MAX_SAMPLES = 3;
const SAMPLE_CHARS = 300;
const DISCRIMINATORS = ["type", "event", "op", "e", "channel", "topic", "action", "method", "stream", "ch", "kind"];
const HEARTBEAT = /^(2|3|ping|pong|heartbeat|hb|keepalive|keep-alive)$/i;

/** @param {string} text */
function parseJson(text) {
  if (!/^\s*[[{]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Engine.IO frames are a digit prefix followed by JSON ("42["event",{...}]"). @param {string} text */
function engineIoPayload(text) {
  const match = /^(\d{1,3})([[{].*)$/s.exec(text);
  return match ? parseJson(match[2]) : undefined;
}

/** @param {string} text */
export function isHeartbeat(text) {
  if (HEARTBEAT.test(text.trim())) return true;
  const json = parseJson(text);
  if (!json || typeof json !== "object" || Array.isArray(json)) return false;
  const values = DISCRIMINATORS.map((key) => json[key]).filter((v) => typeof v === "string");
  return values.some((v) => HEARTBEAT.test(v)) && Object.keys(json).length <= 3;
}

/** Redacts a client frame. Returns the redacted text and whether it changed. @param {string} text */
function redactFrame(text) {
  const json = parseJson(text);
  if (json !== undefined) {
    const redacted = JSON.stringify(redact(json));
    return { text: redacted, changed: redacted !== JSON.stringify(json) };
  }
  const prefixed = /^(\d{1,3})([[{].*)$/s.exec(text);
  if (prefixed) {
    const inner = parseJson(prefixed[2]);
    if (inner !== undefined) {
      const redacted = JSON.stringify(redact(inner));
      return { text: prefixed[1] + redacted, changed: redacted !== JSON.stringify(inner) };
    }
  }
  const redacted = redactText(text);
  return { text: redacted, changed: redacted !== text };
}

/** @param {string} url */
function streamKey(kind, url) {
  const parsed = new URL(url);
  return `${kind} ${parsed.origin}${parsed.pathname}`;
}

/** Drops per-connection query parameters (Engine.IO session id, cache busters) that would break a replay. @param {URL} url */
function dropVolatileQuery(url) {
  if (url.searchParams.has("EIO")) {
    url.searchParams.delete("sid");
    url.searchParams.set("transport", "websocket");
  }
  for (const key of ["t", "_", "cb", "cachebuster", "nocache"]) url.searchParams.delete(key);
}

/**
 * @param {import("./capture.js").RawStream[]} raw
 * @param {{ secretCookies?: boolean }} [options]
 * @returns {{ streams: Stream[], secrets: Record<string, Record<string, string>> }}
 */
export function inferStreams(raw, { secretCookies = false } = {}) {
  /** @type {Record<string, Record<string, string>>} */ const secrets = {};
  const addSecret = (/** @type {string} */ host, /** @type {string} */ key, /** @type {string} */ value) => {
    secrets[host] = { ...(secrets[host] ?? {}), [key]: value };
  };
  /** @type {Map<string, import("./capture.js").RawStream[]>} */ const groups = new Map();
  for (const stream of raw) {
    let url;
    try {
      url = new URL(stream.url);
    } catch {
      continue;
    }
    if (!/^(wss?|https?):$/.test(url.protocol) || isTracker(url.hostname)) continue;
    const key = streamKey(stream.kind, stream.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(stream);
  }

  /** @type {Stream[]} */ const streams = [];
  const usedIds = new Set();
  for (const group of groups.values()) {
    // The connection with the most client frames is the most complete example of the protocol.
    const main = group.reduce((best, s) => (s.frames.filter((f) => f.direction === "sent").length > best.frames.filter((f) => f.direction === "sent").length ? s : best), group[0]);
    const url = new URL(main.url);
    dropVolatileQuery(url);
    const host = url.host;
    const redactedUrl = new URL(redactUrl(url.toString()));
    for (const [name, value] of url.searchParams) if (redactedUrl.searchParams.get(name) === "REDACTED" && value !== "REDACTED") addSecret(host, `?${name}`, value);

    let id = url.pathname.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "root";
    if (main.kind === "sse") id = `sse_${id}`;
    for (let n = 2; usedIds.has(id); n++) id = `${id.replace(/_\d+$/, "")}_${n}`;
    usedIds.add(id);

    /** @type {Stream["send"]} */ const send = [];
    for (const frame of main.frames) {
      if (frame.direction !== "sent" || isHeartbeat(frame.data) || frame.data.startsWith("base64:")) continue;
      if (send.length >= MAX_SEND_FRAMES) break;
      const redacted = redactFrame(frame.data);
      if (redacted.changed) addSecret(SECRET_FRAME_HOST(host), `${id}#${send.length}`, frame.data);
      send.push({ data: redacted.text, afterReceived: frame.receivedBefore });
    }

    const receivedFrames = group.flatMap((s) => s.frames.filter((f) => f.direction === "received" && !isHeartbeat(f.data)));
    const parsed = receivedFrames.map((f) => parseJson(f.data) ?? engineIoPayload(f.data)).filter((v) => v !== undefined);
    /** @type {Map<string, Map<string, number>>} */ const types = new Map();
    for (const value of parsed) {
      const object = Array.isArray(value) ? { event: typeof value[0] === "string" ? value[0] : undefined } : value;
      if (!object || typeof object !== "object") continue;
      for (const discriminator of DISCRIMINATORS) {
        const v = object[discriminator];
        if (typeof v !== "string" && typeof v !== "number") continue;
        if (!types.has(discriminator)) types.set(discriminator, new Map());
        const counts = types.get(discriminator);
        if (counts && (counts.size < 30 || counts.has(String(v)))) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      }
    }

    /** @type {Record<string, string>} */ let headers = {};
    let body;
    if (main.kind === "sse") {
      const split = splitHeaders(main.requestHeaders ?? {}, { secretCookies });
      headers = split.keep;
      if (Object.keys(split.secret).length) secrets[host] = { ...(secrets[host] ?? {}), ...split.secret };
      if (main.requestBody) {
        const redacted = redactFrame(main.requestBody);
        body = redacted.text;
        if (redacted.changed) addSecret(SECRET_FRAME_HOST(host), `${id}#body`, main.requestBody);
      }
    }

    streams.push({
      id, kind: main.kind, url: redactedUrl.toString(), ...(main.kind === "sse" ? { method: main.method ?? "GET", ...(body ? { body } : {}) } : {}),
      headers,
      send,
      messageTypes: [...types].filter(([, counts]) => counts.size > 0).map(([k, counts]) => ({ key: k, values: Object.fromEntries(counts) })).slice(0, 3),
      messageShape: parsed.length ? describeShape(inferSchema(parsed.slice(0, 200).map((v) => redact(v)))) : receivedFrames.length ? "text messages" : "no message observed",
      samples: receivedFrames.slice(0, MAX_SAMPLES).map((f) => {
        const json = parseJson(f.data);
        const text = json === undefined ? f.data : JSON.stringify(redact(json));
        return text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS)}…` : text;
      }),
      observed: group.length,
      received: receivedFrames.length,
    });
  }
  return { streams, secrets };
}

/**
 * Reads WebSocket messages (Chrome's "_webSocketMessages") and event-stream bodies from a HAR file.
 * @param {string} text HAR JSON
 * @param {{ hosts?: string[] }} [options]
 * @returns {import("./capture.js").RawStream[]}
 */
export function streamsFromHar(text, { hosts = [] } = {}) {
  let har;
  try {
    har = JSON.parse(text);
  } catch {
    return [];
  }
  const wanted = hosts.map((h) => h.toLowerCase());
  /** @type {import("./capture.js").RawStream[]} */ const streams = [];
  for (const entry of har?.log?.entries ?? []) {
    const address = entry?.request?.url;
    if (typeof address !== "string") continue;
    let url;
    try {
      url = new URL(address);
    } catch {
      continue;
    }
    if (wanted.length && !wanted.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) continue;
    const requestHeaders = Object.fromEntries((entry.request.headers ?? []).filter((h) => h?.name && !h.name.startsWith(":")).map((h) => [h.name.toLowerCase(), h.value]));
    if (Array.isArray(entry._webSocketMessages)) {
      const wsUrl = new URL(address);
      if (wsUrl.protocol === "https:") wsUrl.protocol = "wss:";
      if (wsUrl.protocol === "http:") wsUrl.protocol = "ws:";
      let received = 0;
      /** @type {RawFrameList} */ const frames = [];
      for (const message of entry._webSocketMessages.slice(0, 300)) {
        if (typeof message?.data !== "string") continue;
        const data = message.opcode === 2 ? `base64:${message.data}` : message.data;
        if (message.type === "send") frames.push({ direction: "sent", data, receivedBefore: received });
        else if (message.type === "receive") frames.push({ direction: "received", data, receivedBefore: received++ });
      }
      streams.push({ kind: "websocket", url: wsUrl.toString(), frames });
      continue;
    }
    const mimeType = entry?.response?.content?.mimeType ?? "";
    if (/text\/event-stream/i.test(mimeType)) {
      const events = typeof entry.response.content.text === "string" ? sseParser().push(`${entry.response.content.text}\n\n`) : [];
      streams.push({
        kind: "sse", url: address, method: entry.request.method ?? "GET", requestBody: entry.request.postData?.text, requestHeaders,
        frames: events.slice(0, 300).map((event, index) => ({ direction: "received", data: sseMessageText(event), receivedBefore: index })),
      });
    }
  }
  return streams;
}

/** @typedef {import("./capture.js").RawFrame[]} RawFrameList */
