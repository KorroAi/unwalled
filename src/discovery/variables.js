// Reads variables for collection imports from a file: Postman environment, Insomnia environment export, .env, or plain JSON object.
import { readFileSync } from "node:fs";

/**
 * @param {string} path absolute path
 * @returns {Record<string, string>}
 */
export function readVariablesFile(path) {
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  if (/^\s*\{/.test(text)) {
    const doc = JSON.parse(text);
    // Postman environment: { values: [{ key, value, enabled }] }
    if (Array.isArray(doc.values)) return Object.fromEntries(doc.values.filter((v) => v?.key && v.enabled !== false).map((v) => [v.key, String(v.value ?? "")]));
    // Insomnia export: environments' data
    if (doc._type === "export" && Array.isArray(doc.resources)) {
      /** @type {Record<string, string>} */ const vars = {};
      for (const r of doc.resources) if (r?._type === "environment" && r.data) for (const [k, v] of Object.entries(r.data)) if (typeof v !== "object") vars[k] = String(v);
      return vars;
    }
    return Object.fromEntries(Object.entries(doc).filter(([, v]) => v === null || typeof v !== "object").map(([k, v]) => [k, String(v ?? "")]));
  }
  // .env: KEY=value, optional quotes, comments, "export " prefix
  /** @type {Record<string, string>} */ const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith("#")) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    vars[match[1]] = value;
  }
  return vars;
}
