// Recipes created from local files and pasted requests: OpenAPI / Swagger, Google Discovery, OData, SOAP (WSDL),
// AsyncAPI, Postman, Insomnia, Bruno, .http files, cURL commands, HAR files and shared recipes; and recipe export.
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { brunoToOpenApi, isBrunoCollection } from "./discovery/bruno.js";
import { parseCurl, splitCurlCommands } from "./discovery/curl.js";
import { describeFile } from "./discovery/files.js";
import { parseHttpFile } from "./discovery/httpfile.js";
import { inferEndpoints, navigationVariables } from "./discovery/infer.js";
import { normalizeOpenApi } from "./discovery/openapi.js";
import { readVariablesFile } from "./discovery/variables.js";
import { assertHttpUrl, graphqlKey, MAX_FILE_BYTES, mergeByKey, restKey, rpcKey, withJsonRpc } from "./recipe-merge.js";
import { assertRecipeName, RECIPE_SCHEMA_VERSION } from "./store.js";
import { dataFiles, DATA_EXTENSIONS, describeTable, openData } from "./data/source.js";
import { cacheFile, fetchToCache, remoteExtension } from "./data/remote.js";

/**
 * Local data: CSV, TSV, JSON Lines and SQLite files, and folders holding data files (Bruno collections excepted).
 * JSON files are data only when they are not an API description (checked by the caller).
 * @param {string} path
 */
function isDataSource(path) {
  if (statSync(path).isDirectory()) {
    if (isBrunoCollection(path)) return false;
    try {
      return dataFiles(path).length > 0;
    } catch {
      return false;
    }
  }
  return DATA_EXTENSIONS.test(path) && !/\.json$/i.test(path);
}

/** Secret entry holding the full address of remote data (it may contain a private token, e.g. a calendar's secret address). */
export const REMOTE_DATA_KEY = "~data";

/**
 * Remote data (CSV, JSON, Excel, iCalendar, SQLite at an http(s) address): downloaded into a cache, refreshed after refreshSeconds.
 * The recipe keeps only the origin; the full address is stored with the secrets.
 * @param {import("./core.js").Engine} engine @param {string} name @param {string} url @param {number} [refreshSeconds]
 */
async function saveRemoteDataRecipe(engine, name, url, refreshSeconds = 300) {
  const download = cacheFile(engine.config.home, name, ".download");
  const { contentType } = await fetchToCache(url, download, { maxAgeMs: 0, timeoutMs: engine.config.requestTimeoutMs });
  const extension = remoteExtension(url, contentType);
  if (!extension) {
    rmSync(download, { force: true });
    throw new Error(`Cannot tell the format of ${new URL(url).origin}… (content type "${contentType}"): use an address ending in .csv, .json, .xlsx, .ics...`);
  }
  const file = cacheFile(engine.config.home, name, extension);
  renameSync(download, file);
  const data = await openData(file);
  let tables;
  try {
    tables = data.tables.map((t) => {
      const { columns, rows } = describeTable(data.db, t);
      return { name: t, columns, rows };
    });
  } finally {
    data.close();
  }
  const origin = new URL(url).origin;
  const now = new Date().toISOString();
  const recipe = {
    schemaVersion: RECIPE_SCHEMA_VERSION, name, kind: "data",
    source: { remote: true, origin, extension, refreshSeconds: Math.max(Number(refreshSeconds) || 300, 10), format: "data" },
    title: `${origin}/…`, baseUrl: origin, tables, createdAt: engine.recipes.get(name)?.createdAt ?? now, updatedAt: now,
    warnings: tables.length ? [] : ["No table found."],
  };
  return engine.withLock(name, async () => engine.saveRecipe(recipe, { [REMOTE_DATA_KEY]: { url } }));
}

/**
 * Recipe for local data queried with read-only SQL. The data stays in the files; the recipe keeps the path and a schema summary.
 * @param {import("./core.js").Engine} engine @param {string} name @param {string} path
 */
async function saveDataRecipe(engine, name, path) {
  const data = await openData(path);
  let tables;
  try {
    tables = data.tables.map((t) => {
      const { columns, rows } = describeTable(data.db, t);
      return { name: t, columns, rows };
    });
  } finally {
    data.close();
  }
  const now = new Date().toISOString();
  const recipe = {
    schemaVersion: RECIPE_SCHEMA_VERSION, name, kind: "data", source: { path, format: "data" }, title: path,
    baseUrl: pathToFileURL(path).toString(), tables, createdAt: engine.recipes.get(name)?.createdAt ?? now, updatedAt: now,
    warnings: tables.length ? [] : ["No table found."],
  };
  return engine.withLock(name, async () => engine.saveRecipe(recipe));
}

/**
 * Creates a recipe from a local file: OpenAPI 3 / Swagger 2 (JSON or YAML), Google Discovery document,
 * Postman collection, Insomnia export, HAR capture, exported recipe, or a Bruno collection folder.
 * @param {import("./core.js").Engine} engine
 * @param {{ name: string, path: string, include?: string, baseUrl?: string, variables?: Record<string, string>, variablesFile?: string, environment?: string, refreshSeconds?: number,
 *   hosts?: string[], maxEndpoints?: number, merge?: boolean }} options
 */
export async function importFile(engine, { name, path, include, baseUrl, variables: given = {}, variablesFile, environment, hosts, maxEndpoints, merge, refreshSeconds }) {
  assertRecipeName(name);
  if (!isAbsolute(path) && !/^https?:\/\//i.test(path)) throw new Error("path must be an absolute path or an http(s) address of a data file");
  if (variablesFile && !isAbsolute(variablesFile)) throw new Error("variables_file must be an absolute path");
  // Explicit variables win over the file's.
  const variables = { ...(variablesFile ? readVariablesFile(variablesFile) : {}), ...given };
  if (include) new RegExp(include); // validate early
  if (baseUrl) assertHttpUrl(baseUrl);
  let described;
  if (/^https?:\/\//i.test(path)) return saveRemoteDataRecipe(engine, name, path, refreshSeconds);
  if (isDataSource(path)) return saveDataRecipe(engine, name, path);
  if (isBrunoCollection(path)) described = { format: /** @type {const} */ ("bruno"), ...brunoToOpenApi(path, { variables, environment }) };
  else if (/\.(http|rest)$/i.test(path)) {
    const { observations, warnings } = parseHttpFile(readFileSync(path, "utf8"), variables);
    return recipeFromRequests(engine, { name, observations, warnings, source: { file: path, format: "http" }, merge, maxEndpoints });
  } else {
    const size = statSync(path).size;
    if (size > MAX_FILE_BYTES) throw new Error(`File too large (${size} bytes, limit ${MAX_FILE_BYTES})`);
    try {
      described = describeFile(readFileSync(path, "utf8"), { variables, serviceRoot: baseUrl });
    } catch (error) {
      // A JSON file that is no API description is data (records to query with SQL).
      if (/\.json$/i.test(path) && /Unrecognised file/.test(error.message)) return saveDataRecipe(engine, name, path);
      throw error;
    }
  }
  if (described.format === "har") return engine.discoverHar({ name, harPath: path, hosts, maxEndpoints, merge });
  if (described.format === "asyncapi") {
    const now = new Date().toISOString();
    const { title, baseUrl: streamsBase, streams, warnings } = described.asyncapi;
    const recipe = {
      schemaVersion: RECIPE_SCHEMA_VERSION, name, kind: "har", source: { file: path, format: "asyncapi" }, title, baseUrl: baseUrl ?? streamsBase,
      createdAt: engine.recipes.get(name)?.createdAt ?? now, updatedAt: now, endpoints: [], graphql: [], streams, warnings,
    };
    return engine.withLock(name, async () => engine.saveRecipe(recipe));
  }
  if (described.format === "soap") return saveSoapRecipe(engine, name, described.soap, { file: path, format: "soap" }, include);
  if (described.format === "recipe") {
    const shared = described.recipe;
    if (shared.schemaVersion !== RECIPE_SCHEMA_VERSION) throw new Error(`This recipe uses schema version ${shared.schemaVersion}; this universal-mcp reads version ${RECIPE_SCHEMA_VERSION}.`);
    const now = new Date().toISOString();
    const recipe = { ...shared, name, source: { ...shared.source, importedFrom: path, originalName: shared.name }, createdAt: engine.recipes.get(name)?.createdAt ?? now, updatedAt: now };
    return engine.withLock(name, async () => {
      await engine.closeBrowser(name);
      return engine.saveRecipe(recipe);
    });
  }
  const spec = baseUrl ? { ...described.spec, servers: [{ url: baseUrl }], host: undefined, basePath: undefined } : described.spec;
  if (baseUrl && spec.swagger) Object.assign(spec, { host: new URL(baseUrl).host, basePath: new URL(baseUrl).pathname, schemes: [new URL(baseUrl).protocol.slice(0, -1)] });
  const specUrl = baseUrl ?? spec.servers?.[0]?.url ?? "https://example.invalid/";
  const normalized = normalizeOpenApi(spec, /^https?:/.test(specUrl) ? specUrl : "https://example.invalid/", { include, maxTools: engine.config.maxOpenApiTools });
  if (/\{\{|example\.invalid/.test(`${specUrl} ${normalized.baseUrl}`)) normalized.warnings.unshift(`Base URL "${normalized.baseUrl}" is incomplete: import again with base_url (or variables).`);
  const now = new Date().toISOString();
  const recipe = {
    schemaVersion: RECIPE_SCHEMA_VERSION, name, kind: "openapi", source: { file: path, format: described.format },
    title: normalized.title, baseUrl: normalized.baseUrl, createdAt: engine.recipes.get(name)?.createdAt ?? now, updatedAt: now,
    operations: normalized.operations, routes: normalized.routes, warnings: [...described.warnings, ...normalized.warnings],
  };
  return engine.withLock(name, async () => {
    await engine.closeBrowser(name);
    return engine.saveRecipe(recipe);
  });
}

/**
 * Creates (or extends, with merge) a recipe from cURL commands, e.g. "Copy as cURL" from browser devtools.
 * Nothing is sent while importing; credentials found in the commands are stored as host-scoped secrets.
 * @param {import("./core.js").Engine} engine
 * @param {{ name: string, commands: string | string[], merge?: boolean, maxEndpoints?: number }} options
 */
export async function importCurl(engine, { name, commands, merge = false, maxEndpoints }) {
  assertRecipeName(name);
  const list = splitCurlCommands(commands);
  if (!list.length) throw new Error("No cURL command given.");
  const warnings = [];
  const observations = list.map((command, index) => {
    const { observation, warnings: own } = parseCurl(command);
    warnings.push(...own.map((w) => `command ${index + 1}: ${w}`));
    return observation;
  });
  return recipeFromRequests(engine, { name, observations, warnings, source: { curl: list.length }, merge, maxEndpoints });
}

/**
 * Builds a replayable recipe from requests written by hand or by another tool (cURL commands, .http files): no responses are known.
 * @param {import("./core.js").Engine} engine
 * @param {{ name: string, observations: import("./discovery/infer.js").Observation[], warnings: string[], source: Record<string, unknown>, merge?: boolean, maxEndpoints?: number }} options
 */
export async function recipeFromRequests(engine, { name, observations, warnings, source, merge = false, maxEndpoints }) {
  if (!observations.length) throw new Error(`No usable request found.${warnings.length ? ` ${warnings.join(" ")}` : ""}`);
  const inferred = inferEndpoints(observations, { variables: navigationVariables([]), maxEndpoints: maxEndpoints ?? engine.config.maxEndpoints, secretCookies: true });
  const rpc = withJsonRpc(observations, inferred.endpoints);
  const previous = engine.recipes.get(name);
  const now = new Date().toISOString();
  const canMerge = merge && previous?.kind === "har";
  const recipe = {
    schemaVersion: RECIPE_SCHEMA_VERSION, name, kind: "har", source,
    baseUrl: new URL(observations[0].url).origin, createdAt: previous?.createdAt ?? now, updatedAt: now,
    endpoints: canMerge ? mergeByKey(previous.endpoints, rpc.endpoints, restKey) : rpc.endpoints,
    graphql: canMerge ? mergeByKey(previous.graphql, inferred.graphql, graphqlKey) : inferred.graphql,
    streams: canMerge ? (previous.streams ?? []) : [],
    jsonrpc: canMerge ? mergeByKey(previous.jsonrpc ?? [], rpc.methods, rpcKey) : rpc.methods,
    warnings: [...warnings, ...inferred.warnings],
    stats: inferred.stats,
  };
  return engine.withLock(name, async () => engine.saveRecipe(recipe, inferred.secrets));
}

/**
 * @param {import("./core.js").Engine} engine
 * @param {string} name @param {ReturnType<typeof import("./discovery/soap.js").parseWsdl>} soap @param {Record<string, unknown>} source @param {string} [include]
 */
export async function saveSoapRecipe(engine, name, soap, source, include) {
  const filter = include ? new RegExp(include, "i") : null;
  const operations = soap.operations.filter((op) => !filter || filter.test(op.name)).slice(0, engine.config.maxOpenApiTools);
  const now = new Date().toISOString();
  const recipe = {
    schemaVersion: RECIPE_SCHEMA_VERSION, name, kind: "soap", source, title: soap.title, baseUrl: new URL(soap.endpoint).origin,
    endpoint: soap.endpoint, version: soap.version, operations, createdAt: engine.recipes.get(name)?.createdAt ?? now, updatedAt: now,
    warnings: soap.operations.length > operations.length ? [`${soap.operations.length} operations, ${operations.length} became tools.`] : [],
  };
  return engine.withLock(name, async () => {
    await engine.closeBrowser(name);
    return engine.saveRecipe(recipe);
  });
}

/**
 * Writes a recipe to a file to share it. Recipes never contain secrets (they stay in the secrets directory);
 * the receiver signs in or sets credentials on their side.
 * @param {import("./core.js").Engine} engine
 * @param {{ name: string, path: string, overwrite?: boolean }} options
 */
export function exportRecipe(engine, { name, path, overwrite = false }) {
  const recipe = engine.recipe(name);
  if (!isAbsolute(path)) throw new Error("path must be an absolute path");
  if (existsSync(path) && !overwrite) throw new Error(`${path} already exists (pass overwrite=true to replace it).`);
  writeFileSync(path, `${JSON.stringify(recipe, null, 2)}\n`);
  return { path, bytes: statSync(path).size };
}
