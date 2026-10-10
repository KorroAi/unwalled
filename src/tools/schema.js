// JSON Schema inference from observed sample values, and compact shape descriptions.

const MAX_DEPTH = 6;
const MAX_KEYS = 40;

/** @param {unknown} value */
function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value; // "string" | "number" | "boolean" | "object"
}

/**
 * Infers a JSON Schema describing every sample. Object keys present in all samples are required.
 * @param {unknown[]} samples
 * @param {number} [depth]
 * @returns {Record<string, any>}
 */
export function inferSchema(samples, depth = 0) {
  const values = samples.filter((v) => v !== undefined);
  if (!values.length) return {};
  if (depth >= MAX_DEPTH) return {};
  const byType = new Map();
  for (const value of values) {
    const type = typeOf(value);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(value);
  }
  // "integer" is a subset of "number": merge when both appear.
  if (byType.has("integer") && byType.has("number")) {
    byType.get("number").push(...byType.get("integer"));
    byType.delete("integer");
  }
  const variants = [...byType.entries()].map(([type, group]) => {
    if (type === "object") {
      const keys = [];
      for (const obj of group) for (const key of Object.keys(obj)) if (!keys.includes(key) && keys.length < MAX_KEYS) keys.push(key);
      const properties = {};
      for (const key of keys) properties[key] = inferSchema(group.map((obj) => obj[key]), depth + 1);
      const required = keys.filter((key) => group.every((obj) => key in obj));
      return { type: "object", properties, ...(required.length ? { required } : {}) };
    }
    if (type === "array") return { type: "array", items: inferSchema(group.flat(), depth + 1) };
    return { type };
  });
  if (variants.length === 1) return variants[0];
  const simple = variants.every((v) => Object.keys(v).length === 1);
  return simple ? { type: variants.map((v) => v.type) } : { anyOf: variants };
}

/**
 * Compact, TypeScript-like description of a schema, for tool descriptions.
 * @param {Record<string, any>} schema
 * @param {number} [depth]
 * @returns {string}
 */
export function describeShape(schema, depth = 0) {
  if (!schema || typeof schema !== "object") return "unknown";
  if (schema.anyOf) return schema.anyOf.map((s) => describeShape(s, depth)).join(" | ");
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (schema.type === "array") return `${describeShape(schema.items ?? {}, depth)}[]`;
  if (schema.type === "object") {
    if (depth >= 2) return "{…}";
    const entries = Object.entries(schema.properties ?? {});
    const shown = entries.slice(0, 12).map(([key, value]) => `${key}: ${describeShape(value, depth + 1)}`);
    if (entries.length > 12) shown.push(`…+${entries.length - 12}`);
    return `{ ${shown.join(", ")} }`;
  }
  return schema.type ?? "unknown";
}
