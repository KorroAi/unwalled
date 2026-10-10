// Converts a Google API Discovery document (YouTube Data/Analytics, Drive, Gmail, Sheets, Calendar...) into OpenAPI 3,
// so it goes through the same normalization as any other published API description.
// Documents: https://www.googleapis.com/discovery/v1/apis/<api>/<version>/rest (list: https://www.googleapis.com/discovery/v1/apis).

/** @param {any} doc */
export function isGoogleDiscovery(doc) {
  return !!doc && typeof doc === "object" && doc.kind === "discovery#restDescription" && !!(doc.resources || doc.methods);
}

/** Rewrites Discovery schema references and types into JSON Schema / OpenAPI. @param {any} schema @returns {any} */
function convertSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 30) return schema;
  if (Array.isArray(schema)) return schema.map((item) => convertSchema(item, depth + 1));
  if (typeof schema.$ref === "string") return { $ref: `#/components/schemas/${schema.$ref}` };
  /** @type {Record<string, any>} */ const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (["id", "location", "repeated", "annotations", "enumDescriptions", "enumDeprecated", "deprecated", "readOnly"].includes(key)) continue;
    if (key === "type" && value === "any") continue;
    if (key === "required" && !Array.isArray(value)) continue; // Discovery flags; JSON Schema "required" is a list
    if (key === "properties" || key === "additionalProperties" || key === "items") {
      out[key] = key === "properties" ? Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, convertSchema(sub, depth + 1)])) : convertSchema(value, depth + 1);
    } else out[key] = value;
  }
  if (Array.isArray(schema.enum) && Array.isArray(schema.enumDescriptions)) {
    const described = schema.enum.map((v, i) => (schema.enumDescriptions[i] ? `${v}: ${schema.enumDescriptions[i]}` : null)).filter(Boolean);
    if (described.length) out.description = `${out.description ? `${out.description} ` : ""}Values — ${described.join("; ")}`.slice(0, 600);
  }
  return out;
}

/** @param {string} name @param {any} param */
function convertParameter(name, param) {
  const { description, ...rest } = param;
  const base = convertSchema(rest);
  const schema = param.repeated ? { type: "array", items: base } : base;
  return { name, in: param.location === "path" ? "path" : "query", required: !!param.required || param.location === "path", description: description ?? "", schema };
}

/**
 * @param {any} doc Discovery document
 * @returns {any} OpenAPI 3.0 description
 */
export function discoveryToOpenApi(doc) {
  /** @type {Record<string, Record<string, any>>} */ const paths = {};
  /** @param {Record<string, any>} methods */
  const addMethods = (methods) => {
    for (const method of Object.values(methods ?? {})) {
      if (!method?.path || !method.httpMethod) continue;
      // "{+name}" (reserved expansion) is filled like a normal path parameter.
      const path = `/${String(method.flatPath ?? method.path).replace(/\{\+/g, "{")}`;
      const parameters = Object.entries(method.parameters ?? {}).map(([name, param]) => convertParameter(name, param));
      // flatPath may rename path parameters ("{name}" -> "{namesId}"): keep the declared ones only if present in the path.
      const pathNames = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      for (const name of pathNames) if (!parameters.some((p) => p.name === name)) parameters.push({ name, in: "path", required: true, description: "", schema: { type: "string" } });
      const operation = {
        operationId: method.id,
        summary: (method.description ?? "").split("\n")[0],
        description: method.description ?? "",
        parameters: parameters.filter((p) => p.in !== "path" || pathNames.includes(p.name)),
        ...(method.request ? { requestBody: { required: true, content: { "application/json": { schema: convertSchema(method.request) } } } } : {}),
        responses: { 200: { description: "OK", ...(method.response ? { content: { "application/json": { schema: convertSchema(method.response) } } } : {}) } },
        ...(method.deprecated ? { deprecated: true } : {}),
        ...(method.scopes ? { "x-scopes": method.scopes } : {}),
      };
      paths[path] = { ...(paths[path] ?? {}), [String(method.httpMethod).toLowerCase()]: operation };
    }
  };
  /** @param {Record<string, any>} resources */
  const walk = (resources, depth = 0) => {
    if (depth > 10) return;
    for (const resource of Object.values(resources ?? {})) {
      addMethods(resource?.methods);
      walk(resource?.resources, depth + 1);
    }
  };
  addMethods(doc.methods);
  walk(doc.resources);
  const root = String(doc.rootUrl ?? "").replace(/\/$/, "");
  const servicePath = String(doc.servicePath ?? "").replace(/^\/|\/$/g, "");
  return {
    openapi: "3.0.3",
    info: { title: doc.title ?? doc.name ?? "Google API", version: doc.version ?? "", description: doc.description ?? "" },
    servers: [{ url: servicePath ? `${root}/${servicePath}` : root }],
    paths,
    components: { schemas: Object.fromEntries(Object.entries(doc.schemas ?? {}).map(([name, schema]) => [name, convertSchema(schema)])) },
  };
}
