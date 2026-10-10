// Connects to a WebSocket or Server-Sent Events stream for a bounded time and collects its messages.
import { pick } from "../tools/pick.js";

/**
 * @typedef {object} OutgoingFrame
 * @property {string} data text frame to send
 * @property {number} [afterReceived] wait until this many server messages arrived before sending (as during the capture)
 */

/**
 * @typedef {object} StreamResult
 * @property {boolean} opened
 * @property {{ at: number, data: string }[]} messages at = milliseconds since the connection opened
 * @property {number} received total messages received, including filtered-out ones
 * @property {number} sent
 * @property {string} [closed] close code and reason, when the server closed the stream
 * @property {string} [error]
 * @property {number} durationMs
 */

const MAX_MESSAGE_CHARS = 64 * 1024;
const WAIT_FOR_SERVER_MS = 3000;

/** @param {string | undefined} filter @returns {(text: string) => boolean} */
export function messageFilter(filter) {
  if (!filter) return () => true;
  const regex = /^\/(.+)\/([a-z]*)$/.exec(filter);
  if (regex) {
    const pattern = new RegExp(regex[1], regex[2]);
    return (text) => pattern.test(text);
  }
  return (text) => text.includes(filter);
}

/** Heartbeats some protocols require from the client: Engine.IO (Socket.IO), graphql-ws, generic JSON ping. @param {string} text */
export function autoReply(text) {
  if (text === "2") return "3"; // Engine.IO ping -> pong
  if (text.length > 64 || !text.startsWith("{")) return undefined;
  try {
    const message = JSON.parse(text);
    if (message?.type === "ping") return JSON.stringify({ type: "pong", ...(message.payload ? { payload: message.payload } : {}) });
    if (message?.op === "ping") return JSON.stringify({ op: "pong" });
  } catch {}
  return undefined;
}

/** @param {unknown} data @returns {Promise<string>} */
async function frameText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return `base64:${Buffer.from(data).toString("base64")}`;
  if (data && typeof (/** @type {any} */ (data).arrayBuffer) === "function") return `base64:${Buffer.from(await /** @type {Blob} */ (data).arrayBuffer()).toString("base64")}`;
  return String(data);
}

/**
 * @param {string} url ws:// or wss://
 * @param {{ headers?: Record<string, string>, protocols?: string[], send?: OutgoingFrame[], durationMs: number, maxMessages: number,
 *   filter?: string, connectTimeoutMs?: number }} options
 * @returns {Promise<StreamResult>}
 */
export function listenWebSocket(url, { headers = {}, protocols, send = [], durationMs, maxMessages, filter, connectTimeoutMs = 15_000 }) {
  const keep = messageFilter(filter);
  /** @type {StreamResult} */ const result = { opened: false, messages: [], received: 0, sent: 0, durationMs: 0 };
  return new Promise((resolve) => {
    let openedAt = Date.now();
    let finished = false;
    /** @type {NodeJS.Timeout | undefined} */ let timer;
    /** @type {(() => void) | undefined} */ let wake; // resolves a pending "wait for server messages"
    // Node's WebSocket (undici) accepts extra handshake headers (cookies, origin) as a non-standard option.
    const socket = new WebSocket(url, /** @type {any} */ ({ headers, ...(protocols?.length ? { protocols } : {}) }));
    socket.binaryType = "arraybuffer";
    const finish = (/** @type {string | undefined} */ error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      wake?.();
      if (error) result.error = error;
      result.durationMs = result.opened ? Date.now() - openedAt : 0;
      try {
        socket.close(1000);
      } catch {}
      resolve(result);
    };
    timer = setTimeout(() => finish(`connection not opened within ${connectTimeoutMs} ms`), connectTimeoutMs);

    socket.addEventListener("open", async () => {
      result.opened = true;
      openedAt = Date.now();
      clearTimeout(timer);
      timer = setTimeout(() => finish(undefined), durationMs);
      for (const frame of send) {
        const needed = frame.afterReceived ?? 0;
        const deadline = Date.now() + WAIT_FOR_SERVER_MS;
        while (!finished && result.received < needed && Date.now() < deadline) {
          await new Promise((done) => {
            wake = () => done(undefined);
            setTimeout(done, 100);
          });
        }
        if (finished) return;
        socket.send(frame.data);
        result.sent++;
      }
    });
    socket.addEventListener("message", async (event) => {
      const text = await frameText(event.data);
      result.received++;
      wake?.();
      const reply = autoReply(text);
      if (reply !== undefined && socket.readyState === socket.OPEN) socket.send(reply);
      if (finished || !keep(text)) return;
      result.messages.push({ at: Date.now() - openedAt, data: text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text });
      if (result.messages.length >= maxMessages) finish(undefined);
    });
    socket.addEventListener("close", (event) => {
      if (!finished) result.closed = `${event.code}${event.reason ? ` ${event.reason}` : ""}`;
      finish(result.opened ? undefined : `connection refused or closed during the handshake (${event.code})`);
    });
    socket.addEventListener("error", (event) => {
      if (!result.opened) finish(`connection failed: ${/** @type {any} */ (event).message ?? "error"}`);
    });
  });
}

/**
 * Incremental Server-Sent Events parser.
 * @returns {{ push: (chunk: string) => { event: string, data: string, id?: string }[] }}
 */
export function sseParser() {
  let buffer = "";
  /** @type {{ event?: string, data: string[], id?: string }} */ let current = { data: [] };
  return {
    push(chunk) {
      buffer += chunk;
      const events = [];
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          if (current.data.length) events.push({ event: current.event ?? "message", data: current.data.join("\n"), ...(current.id ? { id: current.id } : {}) });
          current = { data: [] };
          continue;
        }
        if (line.startsWith(":")) continue; // comment / keep-alive
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "data") current.data.push(value);
        else if (field === "event") current.event = value;
        else if (field === "id") current.id = value;
      }
      return events;
    },
  };
}

/**
 * Text of one event-stream message: the data itself for plain messages; {"event", "data"} for named events,
 * with JSON data parsed so that its shape stays visible.
 * @param {{ event: string, data: string, id?: string }} event
 */
export function sseMessageText(event) {
  if (!event.event || event.event === "message") return event.data;
  let data = event.data;
  try {
    if (/^\s*[[{]/.test(data)) data = JSON.parse(data);
  } catch {}
  return JSON.stringify({ event: event.event, data });
}

/**
 * @param {string} url http(s) URL of an event stream
 * @param {{ headers?: Record<string, string>, method?: string, body?: string, durationMs: number, maxMessages: number, filter?: string, connectTimeoutMs?: number }} options
 * @returns {Promise<StreamResult>}
 */
export async function listenSse(url, { headers = {}, method = "GET", body, durationMs, maxMessages, filter, connectTimeoutMs = 15_000 }) {
  const keep = messageFilter(filter);
  /** @type {StreamResult} */ const result = { opened: false, messages: [], received: 0, sent: 0, durationMs: 0 };
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), connectTimeoutMs);
  let openedAt = Date.now();
  /** @type {NodeJS.Timeout | undefined} */ let durationTimer;
  try {
    const response = await fetch(url, { method, body, headers: { accept: "text/event-stream", ...headers }, signal: controller.signal });
    clearTimeout(connectTimer);
    if (!response.ok || !response.body) {
      result.error = `HTTP ${response.status} ${response.statusText}: ${(await response.text().catch(() => "")).slice(0, 500)}`;
      return result;
    }
    result.opened = true;
    openedAt = Date.now();
    durationTimer = setTimeout(() => controller.abort(), durationMs);
    const parser = sseParser();
    const decoder = new TextDecoder();
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (response.body))) {
      for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
        result.received++;
        const text = sseMessageText(event);
        if (!keep(text)) continue;
        result.messages.push({ at: Date.now() - openedAt, data: text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text });
        if (result.messages.length >= maxMessages) {
          controller.abort();
          break;
        }
      }
      if (controller.signal.aborted) break;
    }
    if (!controller.signal.aborted) result.closed = "server ended the stream";
  } catch (error) {
    if (!controller.signal.aborted || !result.opened) result.error = `connection failed: ${error?.cause?.message ?? error?.message ?? error}`;
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(durationTimer);
    result.durationMs = result.opened ? Date.now() - openedAt : 0;
  }
  return result;
}

/**
 * @param {string} label
 * @param {StreamResult} result
 * @param {{ pick?: string, maxChars: number }} options
 */
export function formatStreamResult(label, result, { pick: pickExpression, maxChars }) {
  const status = result.opened
    ? `${result.received} message(s) received in ${(result.durationMs / 1000).toFixed(1)}s, ${result.messages.length} kept, ${result.sent} sent` +
      (result.closed ? `; closed by the server (${result.closed})` : "")
    : "not connected";
  const lines = [`${label} — ${status}${result.error ? `\nError: ${result.error}` : ""}`];
  for (const message of result.messages) {
    let data = message.data;
    if (pickExpression) {
      try {
        const selected = pick(JSON.parse(data), pickExpression);
        if (selected === undefined) continue;
        data = JSON.stringify(selected);
      } catch {
        continue; // not JSON: pick cannot apply
      }
    }
    lines.push(`[+${message.at}ms] ${data}`);
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… [truncated: ${text.length} characters; use filter, pick, max_messages or max_chars]`;
  return { text, isError: !result.opened || (!!result.error && !result.messages.length) };
}
