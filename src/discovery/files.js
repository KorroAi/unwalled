// Recognises a local API description file and returns an OpenAPI description for it:
// OpenAPI 3 / Swagger 2 (JSON or YAML), Google Discovery documents, Postman collections, Insomnia exports.
// HAR files are recognised too (they are imported as captured traffic, not as a description).
import YAML from "yaml";
import { insomniaToOpenApi, isInsomniaExport, isPostmanCollection, postmanToOpenApi } from "./collections.js";
import { discoveryToOpenApi, isGoogleDiscovery } from "./google.js";

/**
 * @param {string} text file content
 * @param {{ variables?: Record<string, string> }} [options] values for {{variables}} of collections
 * @returns {{ format: "har" } | { format: "recipe", recipe: any } | { format: "openapi" | "swagger" | "google" | "postman" | "insomnia", spec: any, warnings: string[] }}
 */
export function describeFile(text, { variables = {} } = {}) {
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
