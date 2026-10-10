// Records the WebSocket and Server-Sent Events streams a page opens during a browser capture.
import { sseMessageText } from "./client.js";

/**
 * @typedef {object} RawFrame
 * @property {"sent" | "received"} direction
 * @property {string} data text, or "base64:..." for binary frames
 * @property {number} receivedBefore number of server messages received before this frame (for sent frames)
 */

/**
 * @typedef {object} RawStream
 * @property {"websocket" | "sse"} kind
 * @property {string} url
 * @property {string} [method] SSE only
 * @property {string} [requestBody] SSE only
 * @property {Record<string, string>} [requestHeaders] SSE only
 * @property {RawFrame[]} frames
 */

const MAX_FRAMES = 300;
const MAX_FRAME_CHARS = 64 * 1024;

/** @param {string | Buffer} payload */
const frameData = (payload) => {
  const text = typeof payload === "string" ? payload : `base64:${payload.toString("base64")}`;
  return text.length > MAX_FRAME_CHARS ? text.slice(0, MAX_FRAME_CHARS) : text;
};

/**
 * @param {import("playwright-core").BrowserContext} context
 * @param {(hostname: string) => boolean} allowed
 */
export function attachRealtimeCapture(context, allowed) {
  /** @type {RawStream[]} */ const streams = [];
  /** @type {Promise<unknown>[]} */ const pending = [];
  const isAllowed = (/** @type {string} */ address) => {
    try {
      return allowed(new URL(address).hostname);
    } catch {
      return false;
    }
  };

  /** @param {import("playwright-core").Page} page */
  const watchPage = (page) => {
    page.on("websocket", (socket) => {
      if (!isAllowed(socket.url())) return;
      /** @type {RawStream} */ const stream = { kind: "websocket", url: socket.url(), frames: [] };
      streams.push(stream);
      let received = 0;
      socket.on("framesent", ({ payload }) => {
        if (stream.frames.length < MAX_FRAMES) stream.frames.push({ direction: "sent", data: frameData(payload), receivedBefore: received });
      });
      socket.on("framereceived", ({ payload }) => {
        received++;
        if (stream.frames.length < MAX_FRAMES) stream.frames.push({ direction: "received", data: frameData(payload), receivedBefore: received - 1 });
      });
    });

    // EventSource messages are only visible through the DevTools protocol (Chromium only).
    pending.push(
      (async () => {
        const session = await context.newCDPSession(page);
        /** @type {Map<string, RawStream>} */ const byRequest = new Map();
        /** @type {Map<string, { url: string, method: string, body?: string, headers: Record<string, string> }>} */ const requests = new Map();
        session.on("Network.requestWillBeSent", (event) => {
          if (event.type !== "EventSource" && event.type !== "Fetch") return;
          requests.set(event.requestId, { url: event.request.url, method: event.request.method, body: event.request.postData, headers: event.request.headers });
          const oldest = requests.keys().next().value;
          if (requests.size > 2000 && oldest !== undefined) requests.delete(oldest);
        });
        session.on("Network.responseReceived", (event) => {
          const contentType = event.response.headers["content-type"] ?? event.response.headers["Content-Type"] ?? event.response.mimeType ?? "";
          if (!/text\/event-stream/i.test(contentType)) return;
          const request = requests.get(event.requestId);
          if (!request || !isAllowed(request.url)) return;
          /** @type {RawStream} */ const stream = {
            kind: "sse", url: request.url, method: request.method, requestBody: request.body,
            requestHeaders: Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), String(v)])), frames: [],
          };
          byRequest.set(event.requestId, stream);
          streams.push(stream);
        });
        session.on("Network.eventSourceMessageReceived", (event) => {
          const stream = byRequest.get(event.requestId);
          if (!stream || stream.frames.length >= MAX_FRAMES) return;
          const data = sseMessageText({ event: event.eventName, data: event.data });
          stream.frames.push({ direction: "received", data: frameData(data), receivedBefore: stream.frames.length });
        });
        // Streams read with fetch() are recorded without samples: their messages are not exposed as events.
        await session.send("Network.enable");
      })().catch(() => {}),
    );
  };

  for (const page of context.pages()) watchPage(page);
  context.on("page", watchPage);

  return {
    streams,
    /** Waits for the DevTools sessions to be ready (call right after attaching, before loading the page). */
    ready: async () => {
      await Promise.allSettled(pending.slice());
    },
  };
}
