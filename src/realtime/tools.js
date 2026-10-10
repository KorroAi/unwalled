// MCP tools for the WebSocket / SSE streams of a recipe: connect for a bounded time, send frames, collect messages.
import { formatStreamResult, listenSse, listenWebSocket } from "./client.js";
import { listenMqtt } from "./mqtt.js";

/**
 * @typedef {object} StreamAuth
 * @property {Record<string, string>} headers handshake headers (cookies, origin, stored credentials)
 * @property {Record<string, string>} query secret query parameter values, by name
 * @property {Record<string, string>} frames original secret client frames, by "<stream id>#<index>"
 */

/**
 * @typedef {object} StreamRuntime
 * @property {(recipe: any, url: string) => Promise<StreamAuth>} [streamAuth]
 * @property {number} maxOutputChars
 */

const DESCRIPTION_MAX = 1200;
const NO_AUTH = async () => ({ headers: {}, query: {}, frames: {} });

const MQTT_PROPERTIES = {
  topics: { type: "array", items: { type: "string" }, description: 'Topic filters to subscribe to, wildcards allowed ("home/+/temperature", "zigbee2mqtt/#").' },
  publish: {
    type: "array",
    items: { type: "object", properties: { topic: { type: "string" }, message: {}, retain: { type: "boolean" } }, required: ["topic", "message"] },
    description: "Messages to publish once connected (objects are sent as JSON).",
  },
};

/** Credentials: stored "mqtt-username" / "mqtt-password" of the host, or user:password in the URL. @param {StreamAuth} auth @param {URL} url */
function mqttCredentials(auth, url) {
  return {
    username: auth.headers["mqtt-username"] ?? (url.username ? decodeURIComponent(url.username) : undefined),
    password: auth.headers["mqtt-password"] ?? (url.password ? decodeURIComponent(url.password) : undefined),
  };
}

/** @param {any} args */
const mqttPublish = (args) => (Array.isArray(args.publish) ? args.publish : []).map((m) => ({ topic: String(m.topic), message: asFrame(m.message), retain: !!m.retain }));
const clip = (/** @type {string} */ text) => (text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text);

const LISTEN_PROPERTIES = {
  duration_seconds: { type: "number", minimum: 0.5, maximum: 300, description: "How long to stay connected (default 10)." },
  max_messages: { type: "integer", minimum: 1, maximum: 2000, description: "Stop after this many kept messages (default 50)." },
  filter: { type: "string", description: 'Keep only messages containing this text, or matching "/regex/flags".' },
  pick: { type: "string", description: 'Keep only part of each JSON message, e.g. "data.price" or "p,s".' },
  max_chars: { type: "integer", minimum: 20, description: "Maximum characters returned." },
};

/** @param {any} args */
function limits(args) {
  return {
    durationMs: Math.round(Math.min(Math.max(Number(args.duration_seconds ?? 10), 0.5), 300) * 1000),
    maxMessages: Math.min(Math.max(Number.parseInt(String(args.max_messages ?? 50), 10) || 50, 1), 2000),
    filter: typeof args.filter === "string" && args.filter ? args.filter : undefined,
  };
}

/** @param {unknown} value */
const asFrame = (value) => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * Rebuilds the connection URL: stored secret query values replace "REDACTED", then caller overrides apply.
 * @param {string} template @param {Record<string, string>} secretQuery @param {Record<string, unknown> | undefined} query
 */
export function streamUrl(template, secretQuery, query) {
  const url = new URL(template);
  for (const [name, value] of [...url.searchParams]) if (value === "REDACTED" && secretQuery[name] !== undefined) url.searchParams.set(name, secretQuery[name]);
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) url.searchParams.delete(name);
    else url.searchParams.set(name, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return url.toString();
}

/**
 * @param {any} stream recipe stream
 * @param {StreamAuth} auth
 * @param {any} args
 * @returns {import("./client.js").OutgoingFrame[]}
 */
export function framesToSend(stream, auth, args) {
  const captured = args.skip_captured_frames
    ? []
    : stream.send.map((/** @type {{ data: string, afterReceived: number }} */ frame, /** @type {number} */ index) => ({
        data: auth.frames[`${stream.id}#${index}`] ?? frame.data,
        afterReceived: frame.afterReceived,
      }));
  const extra = Array.isArray(args.send) ? args.send.map((value) => ({ data: asFrame(value) })) : [];
  return [...captured, ...extra];
}

/** @param {any} stream */
function describeStream(recipeName, stream) {
  const types = stream.messageTypes.map((t) => `${t.key}: ${Object.keys(t.values).slice(0, 12).join(", ")}`).join("; ");
  const sends = stream.send.length ? ` On connect it sends ${stream.send.length} captured frame(s), first: ${stream.send[0].data.slice(0, 200)}.` : "";
  return clip(
    `[${recipeName}] ${stream.kind === "sse" ? "Server-Sent Events" : stream.kind === "mqtt" ? `MQTT (topics ${(stream.topics ?? []).join(", ")})` : "WebSocket"} stream ${stream.url} — seen ${stream.observed}×, ${stream.received} message(s).` +
      `${sends} Messages: ${stream.messageShape}.${types ? ` Message types (${types}).` : ""}` +
      `${stream.samples.length ? ` Sample: ${stream.samples[0].slice(0, 200)}` : ""} Connects for duration_seconds and returns the messages received.`,
  );
}

/**
 * @param {any} recipe
 * @param {StreamRuntime} runtime
 * @param {(suffix: string) => string} name
 */
export function buildStreamTools(recipe, runtime, name) {
  const streams = recipe.streams ?? [];
  const tools = streams.map((stream) => {
    const isSocket = stream.kind === "websocket";
    const isMqtt = stream.kind === "mqtt";
    /** @type {Record<string, any>} */ const properties = {
      ...LISTEN_PROPERTIES,
      query: { type: "object", additionalProperties: true, description: "Override or add URL query parameters (null removes one)." },
    };
    if (isMqtt) Object.assign(properties, MQTT_PROPERTIES);
    else if (isSocket) {
      properties.send = { type: "array", items: {}, description: "Extra frames to send after the captured ones (objects are sent as JSON), e.g. a subscription." };
      properties.skip_captured_frames = { type: "boolean", description: "Do not replay the frames captured during discovery." };
    } else if (stream.method && stream.method !== "GET") {
      properties.body = { description: "Request body (defaults to the captured one). Objects are sent as JSON." };
    }
    return {
      name: name(`stream_${stream.id}`),
      description: describeStream(recipe.name, stream),
      inputSchema: { type: "object", properties },
      annotations: { title: `${recipe.name} ${stream.kind} ${stream.id}`, readOnlyHint: !isSocket || !stream.send.length, destructiveHint: false, openWorldHint: true },
      /** @param {Record<string, any>} args */
      run: async (args) => {
        const auth = await (runtime.streamAuth ?? NO_AUTH)(recipe, stream.url);
        const url = streamUrl(stream.url, auth.query, args.query);
        const { durationMs, maxMessages, filter } = limits(args);
        const result = isMqtt
          ? await listenMqtt(url, { topics: Array.isArray(args.topics) && args.topics.length ? args.topics : (stream.topics ?? ["#"]), publish: mqttPublish(args), ...mqttCredentials(auth, new URL(url)), durationMs, maxMessages, filter })
          : isSocket
          ? await listenWebSocket(url, { headers: auth.headers, send: framesToSend(stream, auth, args), durationMs, maxMessages, filter })
          : await listenSse(url, {
              headers: { ...stream.headers, ...auth.headers }, method: stream.method ?? "GET",
              body: args.body !== undefined ? asFrame(args.body) : (auth.frames[`${stream.id}#body`] ?? stream.body), durationMs, maxMessages, filter,
            });
        return formatStreamResult(`${stream.kind} ${new URL(stream.url).origin}${new URL(stream.url).pathname}`, result, { pick: args.pick, maxChars: args.max_chars ?? runtime.maxOutputChars });
      },
    };
  });

  if (streams.length) {
    tools.push({
      name: name("stream"),
      description: clip(
        `[${recipe.name}] Connect to any WebSocket (ws:// wss://), Server-Sent Events (http:// https://) or MQTT (mqtt:// mqtts://; ws:// with topics) URL ` +
          "with the recipe's cookies and credentials, optionally send frames or publish, and return the messages received during duration_seconds.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "ws://, wss:// (WebSocket), http(s):// (event stream) or mqtt://, mqtts:// (MQTT broker) URL." },
          ...MQTT_PROPERTIES,
          send: { type: "array", items: {}, description: "WebSocket frames to send once connected (objects are sent as JSON)." },
          protocols: { type: "array", items: { type: "string" }, description: "WebSocket subprotocols, e.g. graphql-transport-ws." },
          headers: { type: "object", additionalProperties: { type: "string" } },
          ...LISTEN_PROPERTIES,
        },
        required: ["url"],
      },
      annotations: { title: `${recipe.name} stream`, readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      /** @param {Record<string, any>} args */
      run: async (args) => {
        const url = new URL(String(args.url));
        if (!/^(wss?|https?|mqtts?):$/.test(url.protocol)) return { text: "url must start with ws://, wss://, http://, https://, mqtt:// or mqtts://", isError: true };
        const auth = await (runtime.streamAuth ?? NO_AUTH)(recipe, url.toString());
        // MQTT over TCP/TLS, or over WebSocket when topics are given.
        if (/^mqtts?:$/.test(url.protocol) || (/^wss?:$/.test(url.protocol) && Array.isArray(args.topics) && args.topics.length)) {
          const { durationMs, maxMessages, filter } = limits(args);
          const result = await listenMqtt(url.toString(), { topics: Array.isArray(args.topics) && args.topics.length ? args.topics : ["#"], publish: mqttPublish(args), ...mqttCredentials(auth, url), durationMs, maxMessages, filter });
          return formatStreamResult(`mqtt ${url.host}`, result, { pick: args.pick, maxChars: args.max_chars ?? runtime.maxOutputChars });
        }
        const headers = { ...auth.headers, ...Object.fromEntries(Object.entries(args.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])) };
        const { durationMs, maxMessages, filter } = limits(args);
        const result = /^wss?:$/.test(url.protocol)
          ? await listenWebSocket(url.toString(), { headers, protocols: args.protocols, send: (Array.isArray(args.send) ? args.send : []).map((v) => ({ data: asFrame(v) })), durationMs, maxMessages, filter })
          : await listenSse(url.toString(), { headers, durationMs, maxMessages, filter });
        return formatStreamResult(`stream ${url.origin}${url.pathname}`, result, { pick: args.pick, maxChars: args.max_chars ?? runtime.maxOutputChars });
      },
    });
  }
  return tools;
}

/** One line per stream, for recipe summaries. @param {any} recipe */
export function describeStreams(recipe) {
  return (recipe.streams ?? []).map((s) => `  ${s.kind === "sse" ? "SSE" : s.kind === "mqtt" ? `MQTT [${(s.topics ?? []).join(", ")}]` : "WebSocket"} ${s.url} (${s.observed}×, ${s.received} messages${s.send.length ? `, ${s.send.length} frame(s) sent on connect` : ""})`);
}
