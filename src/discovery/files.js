// Recognises a local API description file and returns an OpenAPI description for it:
// OpenAPI 3 / Swagger 2 (JSON or YAML), Google Discovery documents, Postman collections, Insomnia exports.
// HAR files are recognised too (they are imported as captured traffic, not as a description).
import YAML from "yaml";
import { insomniaToOpenApi, isInsomniaExport, isPostmanCollection, postmanToOpenApi } from "./collections.js";
import { discoveryToOpenApi, isGoogleDiscovery } from "./google.js";
import { isODataMetadata, odataToOpenApi } from "./odata.js";
import { isWsdl, parseWsdl } from "./soap.js";

/**
 * @param {string} text file content
 * @param {{ variables?: Record<string, string>, serviceRoot?: string }} [options] values for {{variables}} of collections; service root of an OData $metadata file
 * @returns {{ format: "har" } | { format: "recipe", recipe: any } | { format: "soap", soap: ReturnType<typeof parseWsdl> } | { format: "openapi" | "swagger" | "google" | "postman" | "insomnia" | "odata", spec: any, warnings: string[] }}
 */
export function describeFile(text, { variables = {}, serviceRoot } = {}) {
  if (isWsdl(text)) return { format: "soap", soap: parseWsdl(text, serviceRoot ?? "http://localhost/") };
  if (isODataMetadata(text)) {
    if (!serviceRoot) throw new Error("OData $metadata file: pass base_url (the service root URL).");
    return { format: "odata", spec: odataToOpenApi(text, serviceRoot), warnings: [] };
  }
  let doc;
  try {
    doc = /^\s*[{[]/.test(text) ? JSON.parse(text) : YAML.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse the file as JSON or YAML: ${error.message}`);
  }
  if (!doc || typeof doc !== "object") throw new Error("The file does not contain an object.");
  if (Array.isArray(doc?.log?.entries)) return { format: "har" };
  if (typeof doc.schemaVersion === "number" && ["browser", "har", "openapi"].includes(doc.kind) && (Array.isArray(doc.endpoints) || Array.isArray(doc.operations)))
    return { format: "recipe", recipe: doc };
  if (isGoogleDiscovery(doc)) return { format: "google", spec: discoveryToOpenApi(doc), warnings: [] };
  if (isPostmanCollection(doc)) return { format: "postman", ...postmanToOpenApi(doc, variables) };
  if (isInsomniaExport(doc)) return { format: "insomnia", ...insomniaToOpenApi(doc, variables) };
  if ((doc.openapi || doc.swagger) && doc.paths && typeof doc.paths === "object") return { format: doc.openapi ? "openapi" : "swagger", spec: doc, warnings: [] };
  throw new Error("Unrecognised file: expected OpenAPI 3, Swagger 2, a Google Discovery document, a Postman collection, an Insomnia export or a HAR file.");
}
