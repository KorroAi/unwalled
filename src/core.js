// Engine shared by the MCP server and the CLI: discovery, recipe management, request execution.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { closeProfile, launchProfile, saveCookies } from "./browser.js";
import { captureTraffic, validateActions } from "./discovery/capture.js";
import { observationsFromHar } from "./discovery/har.js";
import { inferEndpoints, navigationVariables } from "./discovery/infer.js";
import { brunoToOpenApi, isBrunoCollection } from "./discovery/bruno.js";
import { describeFile } from "./discovery/files.js";
import { findOpenApi, normalizeOpenApi } from "./discovery/openapi.js";
import { inferStreams, SECRET_FRAME_HOST, streamsFromHar } from "./realtime/infer.js";
import { describeStreams } from "./realtime/tools.js";
import { log } from "./log.js";
import { assertRecipeName, RECIPE_SCHEMA_VERSION, Store } from "./store.js";
import { buildTools } from "./tools/generate.js";
import { sendRequest } from "./tools/http.js";

const IDLE_BROWSER_MS = 5 * 60 * 1000;
const MAX_HAR_BYTES = 200 * 1024 * 1024;

/** @param {string} value */
function assertHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Only http(s) URLs are supported: ${value}`);
  return url;
}

/** Merges endpoint lists, newer entries replacing older ones with the same identity. */
function mergeByKey(older, newer, key) {
  const map = new Map(older.map((item) => [key(item), item]));
  for (const item of newer) map.set(key(item), item);
  return [...map.values()];
}
const restKey = (e) => `${e.method} ${e.origin}${e.pathTemplate}`;
const streamKey = (s) => `${s.kind} ${s.url}`;
const graphqlKey = (e) => `${e.method} ${e.url} ${e.operationName ?? e.query ?? JSON.stringify(e.extensions)}`;

/** @param {Record<string, Record<string, string>>[]} sources */
function mergeSecrets(...sources) {
  /** @type {Record<string, Record<string, string>>} */ const merged = {};
  for (const source of sources) for (const [host, values] of Object.entries(source)) merged[host] = { ...(merged[host] ?? {}), ...values };
  return merged;
}

export class Engine {
  /** @param {import("./config.js").Config} config */
  constructor(config) {
    this.config = config;
    this.store = new Store(config);
    this.recipes = this.store.loadRecipes();
    /** @type {Map<string, { context: import("playwright-core").BrowserContext, timer?: NodeJS.Timeout }>} */
    this.browsers = new Map();
    /** @type {Map<string, Promise<unknown>>} */
    this.locks = new Map();
    this.rebuildTools();
  }

  /**
   * Serializes operations on the same recipe (a browser profile can only be opened once).
   * @template T
   * @param {string} name
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  async withLock(name, task) {
    const previous = this.locks.get(name) ?? Promise.resolve();
    const run = /** @type {Promise<T>} */ (previous.catch(() => {}).then(task));
    this.locks.set(name, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(name) === run) this.locks.delete(name);
    }
  }

  rebuildTools() {
    const runtime = {
      send: (recipe, request) => this.send(recipe, request),
      streamAuth: (recipe, url) => this.streamAuth(recipe, url),
      maxOutputChars: this.config.maxOutputChars,
      cacheSeconds: this.config.cacheSeconds,
    };
    /** @type {Map<string, import("./tools/generate.js").GeneratedTool>} */
    this.tools = new Map();
    for (const recipe of this.recipes.values()) {
      for (const tool of buildTools(recipe, runtime)) this.tools.set(tool.name, tool);
    }
  }

  /** @param {string} name */
  async closeBrowser(name) {
    const entry = this.browsers.get(name);
    if (!entry) return;
    this.browsers.delete(name);
    clearTimeout(entry.timer);
    await closeProfile(entry.context, this.store.profileDir(name));
  }

  /** @param {string} name */
  async browserFor(name) {
    let entry = this.browsers.get(name);
    if (!entry) {
      const context = await launchProfile(this.config, this.store.profileDir(name));
      entry = { context };
      context.on("close", () => this.browsers.get(name) === entry && this.browsers.delete(name));
      this.browsers.set(name, entry);
    }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.withLock(name, () => this.closeBrowser(name)).catch(() => {}), IDLE_BROWSER_MS);
    entry.timer.unref?.();
    return entry.context;
  }

  /**
   * Sends a request on behalf of a recipe, adding the stored secret headers of the target host only.
   * @param {any} recipe @param {import("./tools/http.js").OutgoingRequest} request
   */
  async send(recipe, request) {
    const url = new URL(request.url);
    const secrets = this.store.loadSecrets(recipe.name)[url.host] ?? {};
    /** @type {Record<string, string>} */ const headers = {};
    for (const [key, value] of Object.entries(secrets)) {
      if (!key.startsWith("?")) headers[key.toLowerCase()] = value;
      else if (!url.searchParams.has(key.slice(1))) url.searchParams.set(key.slice(1), value); // secret query parameter
    }
    // Explicit headers win over stored ones; lowercase keys avoid sending a header twice.
    for (const [key, value] of Object.entries(request.headers ?? {})) headers[key.toLowerCase()] = String(value);
    const outgoing = { ...request, url: url.toString(), headers };
    if (recipe.kind !== "browser") return sendRequest(outgoing, { timeoutMs: this.config.requestTimeoutMs });
    return this.withLock(recipe.name, async () => {
      const context = await this.browserFor(recipe.name);
      const result = await sendRequest(outgoing, { timeoutMs: this.config.requestTimeoutMs, context });
      await saveCookies(context, this.store.profileDir(recipe.name)); // responses may refresh the session
      return result;
    });
  }

  /**
   * Handshake headers and secrets for a WebSocket / event-stream connection: stored credentials of the host,
   * the browser profile's cookies (browser recipes), and the site's Origin as a browser would send it.
   * @param {any} recipe @param {string} address
   * @returns {Promise<import("./realtime/tools.js").StreamAuth>}
   */
  async streamAuth(recipe, address) {
    const url = new URL(address);
    const secrets = this.store.loadSecrets(recipe.name);
    /** @type {Record<string, string>} */ const headers = {};
    /** @type {Record<string, string>} */ const query = {};
    for (const [key, value] of Object.entries(secrets[url.host] ?? {})) {
      if (key.startsWith("?")) query[key.slice(1)] = value;
      else if (!/^[{~]/.test(key)) headers[key.toLowerCase()] = value;
    }
    if (/^wss?:$/.test(url.protocol) && !headers.origin) headers.origin = new URL(recipe.baseUrl).origin;
    if (recipe.kind === "browser" && !headers.cookie) {
      const cookieUrl = new URL(address);
      cookieUrl.protocol = /^(wss|https):$/.test(url.protocol) ? "https:" : "http:";
      const cookies = await this.withLock(recipe.name, async () => (await this.browserFor(recipe.name)).cookies(cookieUrl.toString()));
      if (cookies.length) headers.cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    }
    return { headers, query, frames: secrets[SECRET_FRAME_HOST(url.host)] ?? {} };
  }

  /** @param {any} recipe @param {Record<string, Record<string, string>>} secrets */
  saveRecipe(recipe, secrets = {}) {
    const existingSecrets = this.store.loadSecrets(recipe.name);
    const merged = { ...existingSecrets };
    for (const [host, headers] of Object.entries(secrets)) merged[host] = { ...(merged[host] ?? {}), ...headers };
    this.store.saveRecipe(recipe);
    this.store.saveSecrets(recipe.name, merged);
    this.recipes.set(recipe.name, recipe);
    this.rebuildTools();
    return recipe;
  }

  /**
   * @param {{ name: string, url: string, mode?: "auto" | "openapi" | "browser", actions?: unknown, interactive?: boolean,
   *   durationSeconds?: number, hosts?: string[], include?: string, maxEndpoints?: number, merge?: boolean }} options
   * @param {(message: string) => void} [onProgress]
   */
  async discover(options, onProgress = () => {}) {
    const { name, url, mode = "auto", interactive = false, durationSeconds, hosts = [], include, merge = false } = options;
    assertRecipeName(name);
    assertHttpUrl(url);
    if (!["auto", "openapi", "browser"].includes(mode)) throw new Error(`Unknown mode "${mode}"`);
    if (include) new RegExp(include); // validate early
    const actions = validateActions(options.actions);
    const maxEndpoints = options.maxEndpoints ?? this.config.maxEndpoints;

    if (mode !== "browser") {
      onProgress("Looking for a published OpenAPI / Swagger description");
      const found = await findOpenApi(url, { timeoutMs: Math.min(this.config.requestTimeoutMs, 10_000) });
      if (found) {
        const normalized = normalizeOpenApi(found.spec, found.specUrl, { include, maxTools: this.config.maxOpenApiTools });
        const now = new Date().toISOString();
        const recipe = {
          schemaVersion: RECIPE_SCHEMA_VERSION, name, kind: "openapi", source: { url, specUrl: found.specUrl },
          title: normalized.title, baseUrl: normalized.baseUrl, createdAt: this.recipes.get(name)?.createdAt ?? now, updatedAt: now,
          operations: normalized.operations, routes: normalized.routes, warnings: normalized.warnings,
        };
        return this.withLock(name, async () => {
          await this.closeBrowser(name);
          return this.saveRecipe(recipe);
        });
      }
      if (mode === "openapi") throw new Error(`No OpenAPI / Swagger description found for ${url}`);
    }

    return this.withLock(name, async () => {
      await this.closeBrowser(name); // the capture needs the profile
      onProgress(interactive ? "Opening a visible browser" : "Capturing traffic with a headless browser");
      const capture = await captureTraffic(this.config, {
        url, profileDir: this.store.profileDir(name), actions, interactive, durationSeconds, hosts, onProgress,
      });
      onProgress(`Analysing ${capture.observations.length} captured requests`);
      const inferred = inferEndpoints(capture.observations, {
        variables: navigationVariables(capture.pageUrls, capture.typedTexts), maxEndpoints, secretCookies: false,
      });
      const realtime = inferStreams(capture.streams, { secretCookies: false });
      const previous = this.recipes.get(name);
      const now = new Date().toISOString();
      const canMerge = merge && previous?.kind === "browser";
      const recipe = {
        schemaVersion: RECIPE_SCHEMA_VERSION, name, kind: "browser", source: { url },
        baseUrl: new URL(url).origin, createdAt: previous?.createdAt ?? now, updatedAt: now,
        endpoints: canMerge ? mergeByKey(previous.endpoints, inferred.endpoints, restKey) : inferred.endpoints,
        graphql: canMerge ? mergeByKey(previous.graphql, inferred.graphql, graphqlKey) : inferred.graphql,
        streams: canMerge ? mergeByKey(previous.streams ?? [], realtime.streams, streamKey) : realtime.streams,
        warnings: [...capture.actionErrors, ...inferred.warnings],
        stats: inferred.stats,
      };
      return this.saveRecipe(recipe, mergeSecrets(inferred.secrets, realtime.secrets));
    });
  }

  /** @param {{ name: string, harPath: string, hosts?: string[], maxEndpoints?: number, merge?: boolean }} options */
  async discoverHar({ name, harPath, hosts = [], maxEndpoints, merge = false }) {
    assertRecipeName(name);
    if (!isAbsolute(harPath)) throw new Error("har_path must be an absolute path");
    const size = statSync(harPath).size;
    if (size > MAX_HAR_BYTES) throw new Error(`HAR file too large (${size} bytes, limit ${MAX_HAR_BYTES})`);
    const harText = readFileSync(harPath, "utf8");
    const har = observationsFromHar(harText, { hosts });
    const realtime = inferStreams(streamsFromHar(harText, { hosts }), { secretCookies: true });
    if (!har.baseUrl && realtime.streams.length) har.baseUrl = new URL(realtime.streams[0].url.replace(/^ws/, "http")).origin;
    if (!har.baseUrl) throw new Error("The HAR file contains no usable API request (JSON responses, successful writes or WebSocket / event streams).");
    const inferred = inferEndpoints(har.observations, {
      variables: navigationVariables(har.pageUrls), maxEndpoints: maxEndpoints ?? this.config.maxEndpoints, secretCookies: true,
    });
    const previous = this.recipes.get(name);
    const now = new Date().toISOString();
    const canMerge = merge && previous?.kind === "har";
    const recipe = {
      schemaVersion: RECIPE_SCHEMA_VERSION, name, kind: "har", source: { harFile: harPath, domains: har.domains },
      baseUrl: har.baseUrl, createdAt: previous?.createdAt ?? now, updatedAt: now,
      endpoints: canMerge ? mergeByKey(previous.endpoints, inferred.endpoints, restKey) : inferred.endpoints,
      graphql: canMerge ? mergeByKey(previous.graphql, inferred.graphql, graphqlKey) : inferred.graphql,
      streams: canMerge ? mergeByKey(previous.streams ?? [], realtime.streams, streamKey) : realtime.streams,
      warnings: inferred.warnings,
      stats: inferred.stats,
    };
    return this.withLock(name, async () => this.saveRecipe(recipe, mergeSecrets(inferred.secrets, realtime.secrets)));
  }

  /**
   * Creates a recipe from a local file: OpenAPI 3 / Swagger 2 (JSON or YAML), Google Discovery document,
   * Postman collection, Insomnia export, HAR capture, exported recipe, or a Bruno collection folder.
   * @param {{ name: string, path: string, include?: string, baseUrl?: string, variables?: Record<string, string>, environment?: string,
   *   hosts?: string[], maxEndpoints?: number, merge?: boolean }} options
   */
  async importFile({ name, path, include, baseUrl, variables = {}, environment, hosts, maxEndpoints, merge }) {
    assertRecipeName(name);
    if (!isAbsolute(path)) throw new Error("path must be an absolute path");
    if (include) new RegExp(include); // validate early
    if (baseUrl) assertHttpUrl(baseUrl);
    let described;
    if (isBrunoCollection(path)) described = { format: /** @type {const} */ ("bruno"), ...brunoToOpenApi(path, { variables, environment }) };
    else {
      const size = statSync(path).size;
      if (size > MAX_HAR_BYTES) throw new Error(`File too large (${size} bytes, limit ${MAX_HAR_BYTES})`);
      described = describeFile(readFileSync(path, "utf8"), { variables });
    }
    if (described.format === "har") return this.discoverHar({ name, harPath: path, hosts, maxEndpoints, merge });
    if (described.format === "recipe") {
      const shared = described.recipe;
      if (shared.schemaVersion !== RECIPE_SCHEMA_VERSION) throw new Error(`This recipe uses schema version ${shared.schemaVersion}; this universal-mcp reads version ${RECIPE_SCHEMA_VERSION}.`);
      const now = new Date().toISOString();
      const recipe = { ...shared, name, source: { ...shared.source, importedFrom: path, originalName: shared.name }, createdAt: this.recipes.get(name)?.createdAt ?? now, updatedAt: now };
      return this.withLock(name, async () => {
        await this.closeBrowser(name);
        return this.saveRecipe(recipe);
      });
    }
    const spec = baseUrl ? { ...described.spec, servers: [{ url: baseUrl }], host: undefined, basePath: undefined } : described.spec;
    if (baseUrl && spec.swagger) Object.assign(spec, { host: new URL(baseUrl).host, basePath: new URL(baseUrl).pathname, schemes: [new URL(baseUrl).protocol.slice(0, -1)] });
    const specUrl = baseUrl ?? spec.servers?.[0]?.url ?? "https://example.invalid/";
    const normalized = normalizeOpenApi(spec, /^https?:/.test(specUrl) ? specUrl : "https://example.invalid/", { include, maxTools: this.config.maxOpenApiTools });
    if (/\{\{|example\.invalid/.test(`${specUrl} ${normalized.baseUrl}`)) normalized.warnings.unshift(`Base URL "${normalized.baseUrl}" is incomplete: import again with base_url (or variables).`);
    const now = new Date().toISOString();
    const recipe = {
      schemaVersion: RECIPE_SCHEMA_VERSION, name, kind: "openapi", source: { file: path, format: described.format },
      title: normalized.title, baseUrl: normalized.baseUrl, createdAt: this.recipes.get(name)?.createdAt ?? now, updatedAt: now,
      operations: normalized.operations, routes: normalized.routes, warnings: [...described.warnings, ...normalized.warnings],
    };
    return this.withLock(name, async () => {
      await this.closeBrowser(name);
      return this.saveRecipe(recipe);
    });
  }

  /**
   * Writes a recipe to a file to share it. Recipes never contain secrets (they stay in the secrets directory);
   * the receiver signs in or sets credentials on their side.
   * @param {{ name: string, path: string, overwrite?: boolean }} options
   */
  exportRecipe({ name, path, overwrite = false }) {
    const recipe = this.recipe(name);
    if (!isAbsolute(path)) throw new Error("path must be an absolute path");
    if (existsSync(path) && !overwrite) throw new Error(`${path} already exists (pass overwrite=true to replace it).`);
    writeFileSync(path, `${JSON.stringify(recipe, null, 2)}\n`);
    return { path, bytes: statSync(path).size };
  }

  /** Opens a visible browser on the recipe profile so the user can sign in. */
  async login({ name, url, durationSeconds = 180 }) {
    assertRecipeName(name);
    assertHttpUrl(url);
    return this.withLock(name, async () => {
      await this.closeBrowser(name);
      const profileDir = this.store.profileDir(name);
      const context = await launchProfile(this.config, profileDir, { headless: false });
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(url, { waitUntil: "domcontentloaded" }).catch((error) => log(`login: ${error.message}`));
      // The user closes the window when done: keep the cookies saved meanwhile.
      const saver = setInterval(() => saveCookies(context, profileDir), 2000);
      const closed = new Promise((resolve) => context.once("close", resolve));
      const timedOut = await Promise.race([closed.then(() => false), new Promise((resolve) => setTimeout(() => resolve(true), Math.min(durationSeconds, 1800) * 1000))]);
      clearInterval(saver);
      if (timedOut) await closeProfile(context, profileDir);
      return { timedOut };
    });
  }

  /** @param {{ name: string, host: string, headers?: Record<string, string>, clear?: boolean }} options */
  setCredentials({ name, host, headers = {}, clear = false }) {
    assertRecipeName(name);
    if (!host || /[/\s]/.test(host)) throw new Error('host must be a bare host such as "api.example.com" or "localhost:8080"');
    const secrets = this.store.loadSecrets(name);
    const current = clear ? {} : (secrets[host] ?? {});
    for (const [key, value] of Object.entries(headers)) {
      if (value === null || value === "") delete current[key.toLowerCase()];
      else current[key.toLowerCase()] = String(value);
    }
    secrets[host] = current;
    this.store.saveSecrets(name, secrets);
    return Object.keys(current);
  }

  /** @param {string} name */
  recipe(name) {
    assertRecipeName(name);
    const recipe = this.recipes.get(name);
    if (!recipe) throw new Error(`Unknown recipe "${name}". Known: ${[...this.recipes.keys()].join(", ") || "none"}`);
    return recipe;
  }

  /** @param {string} name */
  toolsOf(name) {
    return [...this.tools.values()].filter((tool) => tool.name.startsWith(`${name}__`));
  }

  /** @param {string} name @param {{ deleteProfile?: boolean }} [options] */
  async forget(name, { deleteProfile = false } = {}) {
    this.recipe(name);
    return this.withLock(name, async () => {
      await this.closeBrowser(name);
      this.store.deleteRecipe(name, { profile: deleteProfile });
      this.recipes.delete(name);
      this.rebuildTools();
    });
  }

  async close() {
    await Promise.all([...this.browsers.keys()].map((name) => this.closeBrowser(name)));
  }
}

/** One-paragraph summary of a recipe, for tool results and the CLI. @param {any} recipe @param {string[]} toolNames */
export function describeRecipe(recipe, toolNames) {
  const lines = [`Recipe "${recipe.name}" (${recipe.kind}) — base ${recipe.baseUrl} — updated ${recipe.updatedAt}`];
  if (recipe.kind === "openapi") lines.push(`${recipe.source.format ? `${recipe.source.format} file` : "OpenAPI"}: ${recipe.source.specUrl ?? recipe.source.file} — ${recipe.title ?? "untitled"} — ${recipe.routes.length} routes, ${recipe.operations.length} with dedicated tools.`);
  else {
    if (recipe.stats) lines.push(`Captured ${recipe.stats.observed} requests, ${recipe.stats.usable} usable.`);
    for (const op of recipe.graphql) lines.push(`  GraphQL ${op.operationType} ${op.operationName ?? "(anonymous)"} @ ${op.url} (${op.observed}×)`);
    lines.push(...describeStreams(recipe));
    for (const e of recipe.endpoints) lines.push(`  ${e.method} ${e.origin}${e.pathTemplate}${Object.keys(e.query).length ? `?${Object.keys(e.query).join("&")}` : ""} (${e.observed}×)`);
  }
  for (const warning of recipe.warnings ?? []) lines.push(`Warning: ${warning}`);
  lines.push(`Tools: ${toolNames.join(", ")}`);
  return lines.join("\n");
}
