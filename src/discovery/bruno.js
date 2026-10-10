// Reads a Bruno collection (a folder with bruno.json and .bru request files) into an OpenAPI description.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { substitute, toOpenApi } from "./collections.js";

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const MAX_FILES = 2000;

/**
 * Parses the block structure of a .bru file: `name {` ... `}` with dictionary lines or raw text (bodies).
 * @param {string} text @returns {Map<string, string[]>} block name → content lines (one level of indentation removed)
 */
export function parseBru(text) {
  /** @type {Map<string, string[]>} */ const blocks = new Map();
  /** @type {string | null} */ let current = null;
  /** @type {string[]} */ let lines = [];
  for (const line of text.split(/\r?\n/)) {
    if (current === null) {
      const start = /^([\w:.-]+)\s*\{\s*$/.exec(line);
      if (start) {
        current = start[1];
        lines = [];
      }
      continue;
    }
    if (line === "}") {
      blocks.set(current, lines);
      current = null;
      continue;
    }
    lines.push(line.replace(/^ {2}/, ""));
  }
  return blocks;
}

/** "key: value" lines; "~key" lines are disabled. @param {string[] | undefined} lines @returns {[string, string][]} */
function dictionary(lines) {
  return (lines ?? [])
    .map((line) => /^([^:~][^:]*):\s?(.*)$/.exec(line.trim()))
    .filter((m) => m !== null)
    .map((m) => [/** @type {RegExpExecArray} */ (m)[1].trim(), /** @type {RegExpExecArray} */ (m)[2].trim()]);
}

/** @param {string} dir */
export function isBrunoCollection(dir) {
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, "bruno.json"));
  } catch {
    return false;
  }
}

/**
 * @param {string} dir collection folder
 * @param {{ variables?: Record<string, string>, environment?: string }} [options]
 */
export function brunoToOpenApi(dir, { variables = {}, environment } = {}) {
  let title = basename(dir);
  try {
    title = JSON.parse(readFileSync(join(dir, "bruno.json"), "utf8")).name ?? title;
  } catch {}
  /** @type {Record<string, string>} */ const vars = {};
  const envDir = join(dir, "environments");
  if (existsSync(envDir)) {
    const files = readdirSync(envDir).filter((f) => f.endsWith(".bru")).sort();
    const chosen = environment ? files.find((f) => f === `${environment}.bru`) : files[0];
    if (environment && !chosen) throw new Error(`Bruno environment "${environment}" not found (available: ${files.map((f) => f.slice(0, -4)).join(", ") || "none"}).`);
    if (chosen) for (const [key, value] of dictionary(parseBru(readFileSync(join(envDir, chosen), "utf8")).get("vars"))) vars[key] = value;
  }
  for (const file of ["collection.bru"]) {
    if (existsSync(join(dir, file))) for (const [key, value] of dictionary(parseBru(readFileSync(join(dir, file), "utf8")).get("vars:pre-request"))) vars[key] ??= value;
  }
  Object.assign(vars, variables);

  /** @type {import("./collections.js").CollectedRequest[]} */ const requests = [];
  let count = 0;
  /** @param {string} folder @param {string | undefined} label */
  const walk = (folder, label, depth = 0) => {
    if (depth > 10) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (++count > MAX_FILES) return;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!["environments", "node_modules", ".git"].includes(entry.name)) walk(path, entry.name, depth + 1);
        continue;
      }
      if (!entry.name.endsWith(".bru") || entry.name === "collection.bru" || entry.name === "folder.bru") continue;
      const blocks = parseBru(readFileSync(path, "utf8"));
      const method = METHODS.find((m) => blocks.has(m));
      if (!method) continue;
      const main = Object.fromEntries(dictionary(blocks.get(method)));
      const meta = Object.fromEntries(dictionary(blocks.get("meta")));
      if (meta.type && meta.type !== "http" && meta.type !== "graphql") continue;
      let body = null;
      const bodyKind = main.body && main.body !== "none" ? main.body : undefined;
      if (bodyKind === "json" || bodyKind === "graphql") {
        const raw = (blocks.get("body:json") ?? blocks.get("body:graphql") ?? []).join("\n").trim();
        if (raw) {
          /** @type {unknown} */ let example = raw;
          try {
            example = JSON.parse(raw);
          } catch {}
          if (bodyKind === "graphql") example = { query: raw, variables: safeJson((blocks.get("body:graphql:vars") ?? []).join("\n")) ?? {} };
          body = { contentType: "application/json", example, raw: typeof example === "string" ? raw : JSON.stringify(example) };
        }
      } else if (bodyKind === "form-urlencoded" || bodyKind === "multipart-form") {
        body = { contentType: "application/x-www-form-urlencoded", example: Object.fromEntries(dictionary(blocks.get(`body:${bodyKind}`))) };
      } else if (bodyKind === "text" || bodyKind === "xml") {
        const raw = (blocks.get(`body:${bodyKind}`) ?? []).join("\n").trim();
        if (raw) body = { contentType: bodyKind === "xml" ? "application/xml" : "text/plain", example: raw, raw };
      }
      const url = String(main.url ?? "");
      requests.push({
        name: meta.name ?? entry.name.slice(0, -4), folder: label, method: method.toUpperCase(),
        url: substitute(url.split("?")[0], vars),
        query: dictionary(blocks.get("params:query") ?? blocks.get("query")).map(([k, v]) => [k, substitute(v, vars)]),
        body, description: (blocks.get("docs") ?? []).join("\n").trim() || undefined,
      });
    }
  };
  walk(dir, undefined);
  return toOpenApi(title, requests);
}

/** @param {string} text */
function safeJson(text) {
  try {
    return text.trim() ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}
