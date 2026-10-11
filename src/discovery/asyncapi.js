// AsyncAPI 2.x / 3.x descriptions: WebSocket channels become stream tools (same as captured streams).
import { describeShape } from "../tools/schema.js";

/** @param {any} doc */
export function isAsyncApi(doc) {
  return !!doc && typeof doc === "object" && typeof doc.asyncapi === "string" && !!doc.channels;
}

/** Resolves local "$ref"s (one level is enough for messages and payloads). @param {any} doc @param {any} node */
function deref(doc, node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return node;
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    const target = node.$ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~")).reduce((n, k) => n?.[k], doc);
    return deref(doc, target, depth + 1);
  }
  return node;
}

/** @param {any} doc @param {any} schema @returns {any} */
function resolveSchema(doc, schema, depth = 0) {
  const node = deref(doc, schema);
  if (!node || typeof node !== "object" || depth > 8) return node;
  if (Array.isArray(node)) return node.map((n) => resolveSchema(doc, n, depth + 1));
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, typeof v === "object" ? resolveSchema(doc, v, depth + 1) : v]));
}

/** Messages of an operation or channel (single, oneOf, or v3 map). @param {any} doc @param {any} value @returns {any[]} */
function messagesOf(doc, value) {
  const node = deref(doc, value);
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap((m) => messagesOf(doc, m));
  if (Array.isArray(node.oneOf)) return node.oneOf.flatMap((m) => messagesOf(doc, m));
  if (node.payload || node.examples || node.name) return [node];
  return Object.values(node).flatMap((m) => messagesOf(doc, m));
}

/** @param {any} message */
function exampleOf(message) {
  const example = message.examples?.[0];
  const payload = example?.payload ?? example ?? message.payload?.example ?? message.payload?.examples?.[0];
  return payload === undefined ? undefined : typeof payload === "string" ? payload : JSON.stringify(payload);
}

/**
 * @param {any} doc AsyncAPI document
 * @returns {{ title: string, baseUrl: string, streams: import("../realtime/infer.js").Stream[], warnings: string[] }}
 */
export function asyncApiToStreams(doc) {
  const warnings = [];
  const servers = Object.entries(doc.servers ?? {}).map(([name, raw]) => {
    const server = deref(doc, raw);
    const protocol = String(server?.protocol ?? "").toLowerCase();
    let url = server?.url ?? (server?.host ? `${protocol}://${server.host}${server.pathname ?? ""}` : "");
    for (const [variable, def] of Object.entries(server?.variables ?? {})) url = url.replace(`{${variable}}`, /** @type {any} */ (def)?.default ?? /** @type {any} */ (def)?.enum?.[0] ?? "");
    if (url && !/^[a-z]+:\/\//i.test(url)) url = `${protocol}://${url}`;
    return { name, protocol, url };
  });
  const socketServers = servers.filter((s) => /^wss?$/.test(s.protocol) || /^wss?:\/\//i.test(s.url));
  const mqttServers = servers.filter((s) => /^(mqtt|secure-mqtt|mqtts)$/.test(s.protocol) || /^mqtts?:\/\//i.test(s.url));
  for (const s of servers) if (!socketServers.includes(s) && !mqttServers.includes(s)) warnings.push(`Server "${s.name}" uses ${s.protocol || "an unknown protocol"}: only WebSocket and MQTT servers become tools.`);
  if (!socketServers.length && !mqttServers.length) throw new Error("This AsyncAPI document has no WebSocket (ws/wss) or MQTT server.");
  const mqtt = !socketServers.length;
  if (!mqtt) for (const s of mqttServers) warnings.push(`Server "${s.name}" (${s.protocol}) is not used: the WebSocket server is preferred.`);
  const server = mqtt ? mqttServers[0] : socketServers[0];
  if (mqtt) server.url = server.url.replace(/^[a-z-]+:\/\//i, /secure|mqtts/i.test(server.protocol) || /^mqtts:/i.test(server.url) ? "mqtts://" : "mqtt://");

  /** @type {{ id: string, address: string, receive: any[], send: any[], description: string }[]} */ const channels = [];
  const v3 = /^3\./.test(doc.asyncapi);
  for (const [id, raw] of Object.entries(doc.channels ?? {})) {
    const channel = deref(doc, raw);
    const address = v3 ? (channel.address ?? "") : id;
    let receive = [];
    let send = [];
    if (v3) {
      for (const op of Object.values(doc.operations ?? {})) {
        const operation = deref(doc, op);
        if (deref(doc, operation?.channel) !== channel) continue;
        const messages = operation.messages ? operation.messages.flatMap((m) => messagesOf(doc, m)) : messagesOf(doc, channel.messages);
        if (operation.action === "send") send.push(...messages);
        else receive.push(...messages);
      }
      if (!receive.length && !send.length) receive = messagesOf(doc, channel.messages);
    } else {
      // In AsyncAPI 2, "subscribe" means the client receives and "publish" means the client sends.
      receive = messagesOf(doc, channel.subscribe?.message);
      send = messagesOf(doc, channel.publish?.message);
    }
    channels.push({ id, address: mqtt || address.startsWith("/") || !address ? address : `/${address}`, receive, send, description: channel.description ?? "" });
  }

  const base = new URL(server.url);
  const usedIds = new Set();
  /** @type {import("../realtime/infer.js").Stream[]} */ const streams = channels.map((channel, index) => {
    const url = new URL(base.toString());
    if (!mqtt && channel.address && !channel.address.includes("{")) url.pathname = `${base.pathname.replace(/\/$/, "")}${channel.address}`;
    // Ids name tools and key stored secrets: two channels ("a/b", "a.b") must not share one.
    let id = (channel.id.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `channel_${index + 1}`).slice(0, 40);
    for (let n = 2; usedIds.has(id); n++) id = `${id.slice(0, 36)}_${n}`;
    usedIds.add(id);
    const examples = channel.send.map(exampleOf).filter(Boolean);
    const receivePayloads = channel.receive.map((m) => resolveSchema(doc, m.payload)).filter(Boolean);
    const names = channel.receive.map((m) => m.name ?? m.title).filter(Boolean);
    return {
      id, kind: mqtt ? "mqtt" : "websocket", url: mqtt ? `${base.protocol}//${base.host}` : url.toString(), headers: {},
      // MQTT: the channel is the topic; {parameters} become single-level wildcards.
      ...(mqtt ? { topics: [channel.address.replace(/\{[^}]+\}/g, "+")] } : {}),
      // Example messages the client may send are offered as the default frames (e.g. a subscription).
      send: mqtt ? [] : examples.slice(0, 5).map((data) => ({ data: String(data), afterReceived: 0 })),
      messageTypes: names.length ? [{ key: "message", values: Object.fromEntries(names.map((n) => [n, 0])) }] : [],
      messageShape: receivePayloads.length ? receivePayloads.map((p) => describeShape(p)).join(" | ").slice(0, 600) : "not described",
      samples: channel.receive.map(exampleOf).filter(Boolean).slice(0, 3).map((s) => String(s).slice(0, 300)),
      observed: 0, received: 0,
    };
  });
  // Built as text: the URL standard ignores a protocol change from "mqtt:" (not a special scheme) to "http:".
  const httpBase = `${base.protocol === "wss:" || base.protocol === "mqtts:" ? "https:" : "http:"}//${base.host}`;
  return { title: doc.info?.title ?? "AsyncAPI", baseUrl: httpBase, streams, warnings };
}
