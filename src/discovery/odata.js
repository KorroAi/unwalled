// Converts an OData service description ($metadata, CSDL XML, OData v2 to v4) into OpenAPI 3:
// one list / get / create / update / delete operation per entity set, plus function imports.
import { xmlToJson } from "../tools/formats.js";

/** @param {string} text */
export function isODataMetadata(text) {
  return /<(\w+:)?Edmx[\s>]/.test(text.slice(0, 2000));
}

/** @param {unknown} value @returns {any[]} */
const list = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** Strips the XML namespace prefix of element names ("edmx:DataServices" -> "DataServices"). @param {any} node @returns {any} */
function unprefix(node) {
  if (Array.isArray(node)) return node.map(unprefix);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key.startsWith("@") ? key : key.replace(/^[\w-]+:/, ""), unprefix(value)]));
}

const EDM_TYPES = {
  "Edm.String": { type: "string" }, "Edm.Guid": { type: "string", format: "uuid" }, "Edm.Boolean": { type: "boolean" },
  "Edm.Byte": { type: "integer" }, "Edm.SByte": { type: "integer" }, "Edm.Int16": { type: "integer" }, "Edm.Int32": { type: "integer" },
  "Edm.Int64": { type: "string", description: "64-bit integer" }, "Edm.Decimal": { type: "number" }, "Edm.Double": { type: "number" }, "Edm.Single": { type: "number" },
  "Edm.Date": { type: "string", format: "date" }, "Edm.DateTime": { type: "string", format: "date-time" }, "Edm.DateTimeOffset": { type: "string", format: "date-time" },
  "Edm.TimeOfDay": { type: "string" }, "Edm.Duration": { type: "string" }, "Edm.Binary": { type: "string", description: "base64" },
};

/** @param {string} type */
function schemaOf(type) {
  const collection = /^Collection\((.+)\)$/.exec(type ?? "");
  if (collection) return { type: "array", items: schemaOf(collection[1]) };
  return EDM_TYPES[/** @type {keyof typeof EDM_TYPES} */ (type)] ?? { type: "object", description: type };
}

const LIST_PARAMS = [
  ["$filter", "Filter expression, e.g. Price gt 10 and contains(Name,'lamp')"],
  ["$select", "Comma-separated properties to return"],
  ["$orderby", "e.g. Name desc"],
  ["$top", "Maximum number of entities"],
  ["$skip", "Number of entities to skip"],
  ["$expand", "Navigation properties to include"],
  ["$search", "Free-text search (when supported)"],
  ["$count", "true to include the total count (v4)"],
];

/**
 * @param {string} xml $metadata document
 * @param {string} serviceRoot service root URL (the $metadata URL without "/$metadata")
 */
export function odataToOpenApi(xml, serviceRoot) {
  const root = unprefix(xmlToJson(xml) ?? {});
  const dataServices = root?.Edmx?.DataServices;
  if (!dataServices) throw new Error("Invalid OData $metadata: no DataServices element.");
  const schemas = list(dataServices.Schema);
  /** @type {Map<string, any>} */ const entityTypes = new Map();
  for (const schema of schemas) {
    const namespace = schema["@Namespace"];
    const alias = schema["@Alias"];
    for (const type of list(schema.EntityType)) {
      entityTypes.set(`${namespace}.${type["@Name"]}`, type);
      if (alias) entityTypes.set(`${alias}.${type["@Name"]}`, type);
    }
  }
  /** @type {Record<string, Record<string, any>>} */ const paths = {};
  /** @type {Record<string, any>} */ const components = {};
  const version = /^4/.test(root?.Edmx?.["@Version"] ?? "") ? 4 : 2;
  for (const schema of schemas) {
    for (const container of list(schema.EntityContainer)) {
      for (const set of list(container.EntitySet)) {
        const setName = set["@Name"];
        const type = entityTypes.get(set["@EntityType"]);
        if (!setName || !type) continue;
        const properties = Object.fromEntries(list(type.Property).map((p) => [p["@Name"], schemaOf(p["@Type"])]));
        const edmType = Object.fromEntries(list(type.Property).map((p) => [p["@Name"], p["@Type"]]));
        components[type["@Name"]] = { type: "object", properties };
        const keys = list(type.Key?.PropertyRef).map((k) => k["@Name"]).filter(Boolean);
        const keyPath = keys.length === 1 ? `(${keyLiteral(keys[0], edmType[keys[0]], version)})` : `(${keys.map((k) => `${k}=${keyLiteral(k, edmType[k], version)}`).join(",")})`;
        const keyParams = keys.map((k) => ({ name: k, in: "path", required: true, schema: { type: "string" }, description: `Key ${k} (${properties[k]?.type ?? "string"})` }));
        const ref = { $ref: `#/components/schemas/${type["@Name"]}` };
        paths[`/${setName}`] = {
          get: {
            operationId: `list_${setName}`, summary: `List ${setName}`,
            parameters: LIST_PARAMS.filter(([name]) => version === 4 || !["$search", "$count"].includes(name)).map(([name, description]) => ({ name, in: "query", required: false, schema: { type: "string" }, description })),
          },
          post: { operationId: `create_${setName}`, summary: `Create an entity in ${setName}`, requestBody: { content: { "application/json": { schema: ref } } } },
        };
        if (keys.length) {
          paths[`/${setName}${keyPath}`] = {
            get: { operationId: `get_${setName}`, summary: `Get one entity of ${setName} by key`, parameters: [...keyParams, { name: "$select", in: "query", required: false, schema: { type: "string" } }, { name: "$expand", in: "query", required: false, schema: { type: "string" } }] },
            patch: { operationId: `update_${setName}`, summary: `Update an entity of ${setName}`, parameters: keyParams, requestBody: { content: { "application/json": { schema: ref } } } },
            delete: { operationId: `delete_${setName}`, summary: `Delete an entity of ${setName}`, parameters: keyParams },
          };
        }
      }
      for (const fn of [...list(container.FunctionImport), ...list(container.ActionImport)]) {
        const name = fn["@Name"];
        if (!name) continue;
        const isAction = !!fn["@Action"] || fn["@m:HttpMethod"] === "POST" || fn["@HttpMethod"] === "POST";
        const params = list(fn.Parameter).map((p) => ({ name: p["@Name"], in: "query", required: false, schema: schemaOf(p["@Type"]) }));
        // Action parameters travel in a JSON body; function parameters in the query string.
        const body = { content: { "application/json": { schema: { type: "object", properties: Object.fromEntries(params.map((p) => [p.name, p.schema])), additionalProperties: true } } } };
        paths[`/${name}`] = { [isAction ? "post" : "get"]: { operationId: `call_${name}`, summary: `${isAction ? "Action" : "Function"} ${name}`, parameters: isAction ? [] : params, ...(isAction ? { requestBody: body } : {}) } };
      }
    }
  }
  return {
    openapi: "3.0.3",
    info: { title: `OData service ${serviceRoot}`, version: `OData v${version}` },
    servers: [{ url: serviceRoot.replace(/\/$/, "") }],
    paths,
    components: { schemas: components },
  };
}

/**
 * Key placeholder as OData writes it: strings quoted ('ALFKI'), numbers bare (42, including 64-bit ones), GUIDs bare in
 * v4 and as guid'...' in v2.
 * @param {string} name @param {string | undefined} type EDM type of the key property @param {number} version
 */
function keyLiteral(name, type, version) {
  if (!type || type === "Edm.String") return `'{${name}}'`;
  if (type === "Edm.Guid") return version === 2 ? `guid'{${name}}'` : `{${name}}`;
  return `{${name}}`;
}
