// SOAP web services: a WSDL (1.1) description becomes one tool per operation. Parameters are given as JSON,
// sent as XML in a SOAP 1.1 or 1.2 envelope, and the XML response comes back as JSON.
import { xmlToJson } from "../tools/formats.js";

/** @param {string} text */
export function isWsdl(text) {
  return /<(\w+:)?definitions[\s>][\s\S]{0,4000}(wsdl|schemas\.xmlsoap\.org)/i.test(text.slice(0, 6000));
}

/** @param {unknown} value @returns {any[]} */
const list = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
/** @param {string | undefined} qname */
const local = (qname) => String(qname ?? "").replace(/^[\w.-]+:/, "");

/** Strips namespace prefixes from element names. @param {any} node @returns {any} */
function unprefix(node) {
  if (Array.isArray(node)) return node.map(unprefix);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key.startsWith("@") ? key : key.replace(/^[\w.-]+:/, ""), unprefix(value)]));
}

/** Prefixed binding element names ("soap12:binding") tell the SOAP version. @param {any} raw @param {string} name */
function soapVersionOf(raw, name) {
  const definitions = Object.values(raw).find((v) => v && typeof v === "object");
  const bindings = list(definitions && Object.entries(definitions).find(([k]) => /(^|:)binding$/.test(k))?.[1]);
  const binding = bindings.find((b) => b?.["@name"] === name);
  return binding && Object.keys(binding).some((k) => /^soap12:/.test(k)) ? "1.2" : "1.1";
}

const XSD_TYPES = { string: "string", int: "integer", integer: "integer", long: "integer", short: "integer", decimal: "number", double: "number", float: "number", boolean: "boolean", dateTime: "string", date: "string" };

/**
 * @typedef {object} SoapOperation
 * @property {string} name
 * @property {string} soapAction
 * @property {string} element request element name (document/literal) or operation name (rpc)
 * @property {string} namespace target namespace of the request element
 * @property {Record<string, any>} paramsSchema
 * @property {string} documentation
 */

/**
 * @param {string} xml WSDL document
 * @param {string} wsdlUrl where it came from (relative addresses resolve against it)
 * @returns {{ title: string, endpoint: string, version: "1.1" | "1.2", operations: SoapOperation[] }}
 */
export function parseWsdl(xml, wsdlUrl) {
  const raw = xmlToJson(xml);
  const root = unprefix(raw ?? {});
  const definitions = root.definitions;
  if (!definitions) throw new Error("Invalid WSDL: no definitions element.");
  const targetNamespace = definitions["@targetNamespace"] ?? "";

  // XSD elements of the embedded schemas: name -> { namespace, params }.
  /** @type {Map<string, { namespace: string, schema: Record<string, any> }>} */ const elements = new Map();
  /** @type {Map<string, any>} */ const complexTypes = new Map();
  for (const schema of list(definitions.types?.schema)) {
    for (const type of list(schema.complexType)) if (type?.["@name"]) complexTypes.set(type["@name"], type);
  }
  /** @param {any} complex @returns {Record<string, any>} */
  const fieldsOf = (complex, depth = 0) => {
    const properties = {};
    if (!complex || depth > 6) return { type: "object", properties };
    const sequence = complex.sequence ?? complex.all ?? complex.complexContent?.extension?.sequence;
    for (const field of list(sequence?.element)) {
      const name = field?.["@name"] ?? local(field?.["@ref"]);
      if (!name) continue;
      const type = local(field["@type"]);
      let schema = XSD_TYPES[/** @type {keyof typeof XSD_TYPES} */ (type)] ? { type: XSD_TYPES[/** @type {keyof typeof XSD_TYPES} */ (type)] } : complexTypes.has(type) ? fieldsOf(complexTypes.get(type), depth + 1) : field.complexType ? fieldsOf(field.complexType, depth + 1) : { type: "string" };
      if (field["@maxOccurs"] && field["@maxOccurs"] !== "1") schema = { type: "array", items: schema };
      properties[name] = schema;
    }
    return { type: "object", properties };
  };
  for (const schema of list(definitions.types?.schema)) {
    const namespace = schema["@targetNamespace"] ?? targetNamespace;
    for (const element of list(schema.element)) {
      if (!element?.["@name"]) continue;
      const complex = element.complexType ?? complexTypes.get(local(element["@type"]));
      elements.set(element["@name"], { namespace, schema: fieldsOf(complex) });
    }
  }

  const messages = new Map(list(definitions.message).map((m) => [m?.["@name"], list(m?.part)]));
  const portTypes = new Map(list(definitions.portType).map((p) => [p?.["@name"], p]));
  // First SOAP port: its binding and address.
  let endpoint = "";
  let bindingName = "";
  for (const service of list(definitions.service)) {
    for (const port of list(service.port)) {
      const address = port.address?.["@location"];
      if (address && !endpoint) {
        endpoint = new URL(address, wsdlUrl).toString();
        bindingName = local(port["@binding"]);
      }
    }
  }
  const bindings = list(definitions.binding);
  const binding = bindings.find((b) => b?.["@name"] === bindingName) ?? bindings[0];
  if (!binding) throw new Error("Invalid WSDL: no binding.");
  const style = binding.binding?.["@style"] ?? "document";
  const portType = portTypes.get(local(binding["@type"]));
  const operations = list(binding.operation).map((op) => {
    const name = op["@name"];
    const abstract = list(portType?.operation).find((o) => o?.["@name"] === name);
    const parts = messages.get(local(abstract?.input?.["@message"])) ?? [];
    const elementPart = parts.find((p) => p?.["@element"]);
    const found = elementPart ? elements.get(local(elementPart["@element"])) : undefined;
    const paramsSchema =
      found?.schema ??
      { type: "object", properties: Object.fromEntries(parts.filter((p) => p?.["@name"]).map((p) => [p["@name"], { type: XSD_TYPES[/** @type {keyof typeof XSD_TYPES} */ (local(p["@type"]))] ?? "string" }])) };
    return {
      name,
      soapAction: op.operation?.["@soapAction"] ?? "",
      element: style === "rpc" || !elementPart ? name : local(elementPart["@element"]),
      namespace: found?.namespace ?? op.input?.body?.["@namespace"] ?? targetNamespace,
      paramsSchema,
      documentation: String(typeof abstract?.documentation === "string" ? abstract.documentation : (abstract?.documentation?.["#text"] ?? "")).replace(/\s+/g, " ").slice(0, 300),
    };
  });
  if (!endpoint) throw new Error("Invalid WSDL: no SOAP address.");
  return { title: definitions["@name"] ?? new URL(endpoint).host, endpoint, version: soapVersionOf(raw, binding["@name"]), operations };
}

/** @param {string} text */
const escapeXml = (text) => text.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c);

/** JSON value to XML child elements (arrays repeat the element). @param {Record<string, unknown>} value */
export function toXml(value, depth = 0) {
  if (depth > 20) return "";
  return Object.entries(value ?? {})
    .flatMap(([key, item]) => (Array.isArray(item) ? item.map((i) => [key, i]) : [[key, item]]))
    .map(([key, item]) => {
      const name = String(key).replace(/[^\w.-]/g, "_");
      if (item === null || item === undefined) return `<${name}/>`;
      if (typeof item === "object") return `<${name}>${toXml(/** @type {Record<string, unknown>} */ (item), depth + 1)}</${name}>`;
      return `<${name}>${escapeXml(String(item))}</${name}>`;
    })
    .join("");
}

/** @param {SoapOperation} op @param {"1.1" | "1.2"} version @param {Record<string, unknown>} params */
export function soapEnvelope(op, version, params) {
  const envelopeNs = version === "1.2" ? "http://www.w3.org/2003/05/soap-envelope" : "http://schemas.xmlsoap.org/soap/envelope/";
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${envelopeNs}"><soap:Body><${op.element} xmlns="${escapeXml(op.namespace)}">${toXml(params)}</${op.element}></soap:Body></soap:Envelope>`;
}

/** Operation names do not say whether they write: only obvious readers are read-only. @param {string} name */
const isReader = (name) => /^(get|list|find|search|read|query|check|validate|lookup|calculate|convert)/i.test(name);

/**
 * @param {any} recipe kind "soap"
 * @param {(suffix: string) => string} name
 * @param {(request: any, args: Record<string, any>, toolName: string, transform?: (result: any) => any) => Promise<{ text: string, isError: boolean }>} exec
 *   sends a request through the recipe's pipeline (credentials, safety policy, formatting) and returns the tool result
 * @param {Record<string, any>} outputProperties shared output options of generated tools (pick, max_chars...)
 */
export function buildSoapTools(recipe, name, exec, outputProperties) {
  /** @param {SoapOperation} op @param {Record<string, unknown>} params */
  const request = (op, params) => {
    const headers = recipe.version === "1.2"
      ? { "content-type": `application/soap+xml; charset=utf-8${op.soapAction ? `; action="${op.soapAction}"` : ""}`, accept: "application/soap+xml, text/xml" }
      : { "content-type": "text/xml; charset=utf-8", soapaction: `"${op.soapAction}"`, accept: "text/xml" };
    return { method: "POST", url: recipe.endpoint, headers, body: soapEnvelope(op, recipe.version, params), bodyKind: "text", intent: isReader(op.name) ? "read" : "write" };
  };
  return recipe.operations.map((/** @type {SoapOperation} */ op) => {
    const toolName = name(op.name);
    return {
      lazy: true,
      name: toolName,
      description: `[${recipe.name}] SOAP ${recipe.version} operation ${op.name} at ${recipe.endpoint}.${op.documentation ? ` ${op.documentation}` : ""} Parameters are sent as XML elements; the XML response is returned as JSON.`.slice(0, 1200),
      inputSchema: {
        type: "object",
        properties: {
          params: { ...op.paramsSchema, additionalProperties: true, description: "Request elements (nested objects and arrays allowed)." },
          ...outputProperties,
        },
      },
      // Anything that is not obviously a reader may change data.
      annotations: { title: `${recipe.name} ${op.name}`, readOnlyHint: isReader(op.name), destructiveHint: !isReader(op.name), openWorldHint: true },
      /** @param {Record<string, any>} args */
      run: async (args) => exec(request(op, args.params ?? {}), args, toolName, unwrapEnvelope),
    };
  });
}

/**
 * Returns the content of the SOAP Body as JSON (namespace prefixes and xmlns attributes removed); a Fault is an error.
 * @param {{ status: number, statusText: string, contentType: string, body: Buffer, finalUrl: string }} result
 */
export function unwrapEnvelope(result) {
  const json = xmlToJson(result.body.toString("utf8"));
  const body = json && unprefix(json)?.Envelope?.Body;
  if (!body || typeof body !== "object") return result;
  const clean = (/** @type {any} */ node) =>
    Array.isArray(node) ? node.map(clean) : node && typeof node === "object" ? Object.fromEntries(Object.entries(node).filter(([k]) => !/^@xmlns/.test(k)).map(([k, v]) => [k, clean(v)])) : node;
  const content = clean(body);
  const fault = "Fault" in content;
  return { ...result, status: fault && result.status < 400 ? 500 : result.status, contentType: "application/json", body: Buffer.from(JSON.stringify(content)) };
}
