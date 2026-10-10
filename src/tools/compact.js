// Keeps tool definitions small: every tool definition is sent to the model with each request, so a recipe with
// verbose schemas (deep request bodies, long descriptions, huge enums) would eat the context and blur tool choice.
// Schemas over the budget are shrunk step by step; the arguments stay accepted (additionalProperties).

/** @param {any} schema @param {(node: any, depth: number) => any} visit @returns {any} */
function walk(schema, visit, depth = 0) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((item) => walk(item, visit, depth));
  const node = visit(schema, depth);
  if (!node || typeof node !== "object") return node;
  /** @type {Record<string, any>} */ const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && value && typeof value === "object") out.properties = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, walk(sub, visit, depth + 1)]));
    else if (["items", "additionalProperties"].includes(key) && value && typeof value === "object") out[key] = walk(value, visit, depth + 1);
    else if (["anyOf", "oneOf", "allOf"].includes(key) && Array.isArray(value)) out[key] = value.map((v) => walk(v, visit, depth + 1));
    else out[key] = value;
  }
  return out;
}

/** @param {number} max */
const trimDescriptions = (max) => (/** @type {any} */ node) =>
  typeof node.description === "string" && node.description.length > max ? { ...node, description: `${node.description.slice(0, max - 1)}…` } : node;

/** @param {number} max */
const trimEnums = (max) => (/** @type {any} */ node) =>
  Array.isArray(node.enum) && node.enum.length > max ? { ...node, enum: undefined, description: `${node.description ? `${node.description} ` : ""}One of: ${node.enum.slice(0, max).join(", ")}…` } : node;

/** Replaces object schemas deeper than `depth` (relative to the tool arguments) by a free-form object. @param {number} limit */
const collapseBelow = (limit) => (/** @type {any} */ node, /** @type {number} */ depth) =>
  depth >= limit && (node.properties || node.items?.properties)
    ? {
        type: node.type ?? "object",
        additionalProperties: true,
        description: `${node.description ? `${String(node.description).slice(0, 80)} ` : ""}(fields: ${Object.keys(node.properties ?? node.items.properties).slice(0, 40).join(", ")}; details omitted)`,
      }
    : node;

/** @param {any} value */
const size = (value) => JSON.stringify(value).length;

/** Drops undefined keys left by the steps above. @param {any} schema */
const clean = (schema) => JSON.parse(JSON.stringify(schema));

/**
 * @param {{ description: string, inputSchema: any }} tool
 * @param {number} budget maximum characters for description + schema
 * @returns {{ description: string, inputSchema: any, compacted: boolean }}
 */
export function compactTool(tool, budget) {
  let description = tool.description;
  let schema = tool.inputSchema;
  const total = () => description.length + size(schema);
  if (total() <= budget) return { description, inputSchema: schema, compacted: false };
  const steps = [
    () => (schema = clean(walk(schema, trimDescriptions(160)))),
    () => (schema = clean(walk(schema, trimEnums(20)))),
    () => (description = description.length > 500 ? `${description.slice(0, 499)}…` : description),
    () => (schema = clean(walk(schema, collapseBelow(4)))),
    () => (schema = clean(walk(schema, trimDescriptions(60)))),
    () => (schema = clean(walk(schema, collapseBelow(3)))),
    () => (schema = clean(walk(schema, collapseBelow(2)))),
    () => (schema = clean(walk(schema, trimEnums(8)))),
    () => (schema = clean(walk(schema, collapseBelow(1)))),
  ];
  for (const step of steps) {
    step();
    if (total() <= budget) break;
  }
  return { description, inputSchema: schema, compacted: true };
}
