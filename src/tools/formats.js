// Converts CSV and XML response bodies (including RSS / Atom feeds) into JSON, so pick, filters and pagination apply to them.

const MAX_ROWS = 100_000;

/** Detects the delimiter from the first line. @param {string} line */
function delimiterOf(line) {
  const counts = [",", ";", "\t", "|"].map((d) => [d, line.split(d).length - 1]);
  counts.sort((a, b) => Number(b[1]) - Number(a[1]));
  return /** @type {string} */ (counts[0][1] ? counts[0][0] : ",");
}

/** RFC 4180 CSV (quoted fields, doubled quotes, newlines inside quotes). @param {string} text @returns {Record<string, string>[]} */
export function parseCsv(text) {
  const source = text.replace(/^﻿/, "");
  const delimiter = delimiterOf(source.split(/\r?\n/, 1)[0] ?? "");
  /** @type {string[][]} */ const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) break;
    } else field += char;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  const names = header.map((name, index) => name.trim() || `column${index + 1}`);
  return body.map((values) => Object.fromEntries(names.map((name, index) => [name, values[index] ?? ""])));
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** @param {string} text */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[/** @type {keyof typeof ENTITIES} */ (entity.toLowerCase())] ?? match;
  });
}

/**
 * Small XML to JSON converter: elements become keys (repeated ones become arrays), attributes are prefixed with "@",
 * text of elements that also have attributes or children goes to "#text". No DTD, no external entities.
 * @param {string} text @returns {Record<string, unknown> | null}
 */
export function xmlToJson(text) {
  const source = text
    .replace(/^﻿/, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, "");
  /** @type {{ name: string, node: Record<string, unknown>, text: string }[]} */ const stack = [{ name: "#root", node: {}, text: "" }];
  const token = /<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+)/g;
  for (const match of source.matchAll(token)) {
    const top = stack[stack.length - 1];
    if (match[1] !== undefined) top.text += match[1];
    else if (match[2] !== undefined) {
      if (stack.length < 2 || top.name !== match[2]) return null; // malformed
      stack.pop();
      close(stack[stack.length - 1].node, top);
    } else if (match[3] !== undefined) {
      /** @type {Record<string, unknown>} */ const node = {};
      for (const attr of match[4].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) node[`@${attr[1]}`] = decodeEntities(attr[2] ?? attr[3] ?? "");
      const entry = { name: match[3], node, text: "" };
      if (match[5]) close(top.node, entry);
      else stack.push(entry);
    } else if (match[6] !== undefined) top.text += decodeEntities(match[6]);
  }
  if (stack.length !== 1) return null;
  return stack[0].node;
}

/** @param {Record<string, unknown>} parent @param {{ name: string, node: Record<string, unknown>, text: string }} entry */
function close(parent, { name, node, text }) {
  const trimmed = text.trim();
  /** @type {unknown} */ let value = node;
  if (!Object.keys(node).length) value = trimmed;
  else if (trimmed) node["#text"] = trimmed;
  if (name in parent) {
    const existing = parent[name];
    parent[name] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  } else parent[name] = value;
}

/** Anti-hijacking prefixes some APIs put before JSON (Google, Angular, Facebook...). */
const JSON_PREFIX = /^\s*(\)\]\}'\s*,?\s*\n?|while\s*\(1\);|for\s*\(;;\);|&&&START&&&)/;

/**
 * Parses a JSON body even when it is served with a non-JSON content type or behind an anti-hijacking prefix.
 * @param {string} text @returns {unknown} undefined when the text is not JSON
 */
export function parseJsonLoose(text) {
  const body = text.replace(/^﻿/, "").replace(JSON_PREFIX, "");
  if (!/^\s*[[{"]/.test(body)) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * JSON text for a CSV or XML body, or undefined for other content types (or when the body does not parse).
 * @param {string} body @param {string} contentType
 */
export function convertToJson(body, contentType) {
  if (/csv/i.test(contentType)) return JSON.stringify(parseCsv(body));
  if (/xml|rss|atom/i.test(contentType) && !/html/i.test(contentType)) {
    const json = xmlToJson(body);
    return json ? JSON.stringify(json) : undefined;
  }
  return undefined;
}
