// Engine shared by the MCP server and the CLI: discovery, recipe management, request execution.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { closeProfile, encryptCookiesWith, launchProfile, saveCookies, savedCookieFingerprint } from "./browser.js";
import { secretKey } from "./crypto.js";
import { captureTraffic, validateActions } from "./discovery/capture.js";
import { observationsFromHar } from "./discovery/har.js";
import { inferEndpoints, navigationVariables, responseKeys } from "./discovery/infer.js";
import { redactUrl, scrubRecipe, secretValues } from "./discovery/secrets.js";
import { findOpenApi, normalizeOpenApi } from "./discovery/openapi.js";
import { exportRecipe, importCurl, importFile, saveSoapRecipe } from "./imports.js";
import { closeDataConnections } from "./data/tools.js";
import { resolvePreset } from "./presets.js";
import { authorizationCodeLogin, OAUTH_PROVIDERS } from "./oauth-login.js";
import { cacheFile, fetchToCache } from "./data/remote.js";
import { REMOTE_DATA_KEY } from "./imports.js";
import { assertHttpUrl, graphqlKey, MAX_FILE_BYTES, mergeByKey, mergeSecrets, pageKey, restKey, rpcKey, streamKey, withJsonRpc } from "./recipe-merge.js";
import { inferPages, redirectedToSignIn } from "./discovery/pages.js";
import { inferStreams, SECRET_FRAME_HOST, streamsFromHar } from "./realtime/infer.js";
import { SECRET_PATH_PREFIX } from "./discovery/jsonrpc.js";
import { describeStreams } from "./realtime/tools.js";
import { log } from "./log.js";
import { assertRecipeName, RECIPE_SCHEMA_VERSION, Store } from "./store.js";
import { buildTools, storableArguments, validateMacro } from "./tools/generate.js";
import { act, readText, riskyTargets, snapshot, validateUiSteps } from "./ui.js";
import { isChallenge, sendInPage, sendRequest } from "./tools/http.js";
import { isExpired, refreshOAuth } from "./auth.js";
import { AuditLog, checkPolicy, intentOf, orgHostBlock, previewRequest, RateLimiter, ResponseCache, retryDelay, shouldRetry, stricterConfirm } from "./safety.js";

const IDLE_BROWSER_MS = 5 * 60 * 1000;

export class Engine {
  /** @param {import("./config.js").Config} config */
  constructor(config) {
    this.config = config;
    // Saved session cookies are credentials: encrypted with the secrets' key (resolved on first use).
    encryptCookiesWith(config.encryptSecrets ? () => secretKey(config.home).key : null);
    this.store = new Store(config);
    this.recipes = this.store.loadRecipes();
    /** @type {Map<string, { context: import("playwright-core").BrowserContext, headless: boolean, page?: import("playwright-core").Page, timer?: NodeJS.Timeout }>} */
    this.browsers = new Map();
    /** @type {Map<string, Promise<unknown>>} */
    this.locks = new Map();
    /** Recipes whose requests go through an open page (bot protection detected). @type {Set<string>} */
    this.pageMode = new Set();
    /** Last re-authentication attempt per recipe and host. @type {Map<string, number>} */
    this.authAttempts = new Map();
    this.limiter = new RateLimiter();
    this.cache = new ResponseCache();
    this.audit = new AuditLog(config.auditFile);
    /** Generated tools by name (rebuilt whenever a recipe changes). @type {Map<string, import("./tools/generate.js").GeneratedTool>} */
    this.tools = new Map();
    /** @type {import("./tools/generate.js").Runtime} */
    this.runtime = this.rebuildTools();
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

  /** @returns {import("./tools/generate.js").Runtime} */
  rebuildTools() {
    const runtime = (this.runtime = {
      send: (recipe, request, options) => this.send(recipe, request, options),
      findTool: (name) => this.tools.get(name),
      secret: (recipe, host, key) => this.store.loadSecrets(recipe.name)[host]?.[key],
      streamAuth: (recipe, url) => this.streamAuth(recipe, url),
      guard: (recipe, url, intent, confirmed) => this.guardStream(recipe, url, intent, confirmed),
      dataPath: (recipe) => this.dataPath(recipe),
      maxOutputChars: this.config.maxOutputChars,
      compactChars: this.config.compactChars,
      schemaBudget: this.config.schemaBudget,
      foldThreshold: this.config.foldThreshold,
    });
    this.tools = new Map();
    for (const recipe of this.recipes.values()) {
      // One malformed recipe (edited by hand, copied from elsewhere) must not take the whole server down.
      try {
        for (const tool of buildTools(recipe, runtime)) this.tools.set(tool.name, tool);
      } catch (error) {
        log(`Recipe "${recipe.name}" is malformed and was skipped (${error.message}); rediscover it or forget it.`);
      }
    }
    return runtime;
  }

  /**
   * Refuses an address the organization policy does not allow, before anything is contacted. Enforced here (not only
   * in the MCP server) so that the command line and presets follow the same rule.
   * @param {...(string | undefined | null)} addresses
   */
  assertOrgAllows(...addresses) {
    if (!this.config.orgPolicy?.allowedHosts?.length) return;
    for (const address of addresses) {
      if (typeof address !== "string" || !/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) continue; // local paths are not addresses
      const reason = orgHostBlock(this.config.orgPolicy, new URL(address));
      if (reason) throw new Error(reason);
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

  /** @param {string} name @param {{ headless?: boolean }} [options] headless defaults to the open browser's mode, else true */
  async browserFor(name, { headless } = {}) {
    let entry = this.browsers.get(name);
    if (entry && headless !== undefined && entry.headless !== headless) {
      await this.closeBrowser(name);
      entry = undefined;
    }
    if (!entry) {
      const mode = headless ?? true;
      const context = await launchProfile(this.config, this.store.profileDir(name), { headless: mode });
      entry = { context, headless: mode };
      context.on("close", () => this.browsers.get(name) === entry && this.browsers.delete(name));
      this.browsers.set(name, entry);
    }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.withLock(name, () => this.closeBrowser(name)).catch(() => {}), IDLE_BROWSER_MS);
    entry.timer.unref?.();
    return entry.context;
  }

  /**
   * Sends a request on behalf of a recipe: policy and confirmation, rate limit, stored credentials of the target host only,
   * automatic re-authentication on 401 (OAuth refresh or browser reload), in-page retry on bot challenges, audit log.
   * Returns a preview instead of a response for dry runs and calls awaiting confirmation.
   * @param {any} recipe @param {import("./tools/http.js").OutgoingRequest} request
   * @param {{ dryRun?: boolean, confirmed?: boolean, tool?: string, cacheSeconds?: number }} [options]
   * @returns {Promise<import("./tools/http.js").HttpResult | { preview: string, blocked?: boolean, request?: any }>}
   */
  async send(recipe, request, { dryRun = false, confirmed = false, tool, cacheSeconds } = {}) {
    const url = new URL(request.url);
    const policy = this.store.loadState(recipe.name).policy ?? {};
    const intent = request.intent ?? intentOf(request.method);
    const build = () => this.withCredentials(recipe, request);
    let outgoing = build();
    const secretNames = Object.keys(this.store.loadSecrets(recipe.name)[url.host] ?? {}).map((k) => k.toLowerCase());
    const decision = checkPolicy(policy, { intent, url, confirmed }, this.config.confirm, this.config.orgPolicy);
    if (decision?.blocked) {
      this.audit.write({ recipe: recipe.name, tool, method: request.method, url: request.url, outcome: "blocked" });
      return { preview: `Blocked: ${decision.reason}\n${previewRequest(outgoing, secretNames)}`, blocked: true };
    }
    // The full request (credentials included) is returned for internal use only (code export masks it); tool results show the preview.
    if (decision || dryRun) return { preview: `${decision ? decision.reason : "Dry run: nothing was sent."}\n${previewRequest(outgoing, secretNames)}`, request: outgoing };

    const ttl = intent === "read" ? (cacheSeconds ?? policy.cacheSeconds ?? 0) : 0;
    const cacheKey = `${recipe.name}\n${outgoing.method}\n${outgoing.url}\n${typeof outgoing.body === "string" ? outgoing.body : JSON.stringify(outgoing.body ?? null)}`;
    if (ttl > 0) {
      const cached = this.cache.get(cacheKey, ttl);
      if (cached) {
        this.audit.write({ recipe: recipe.name, tool, method: request.method, url: outgoing.url, status: cached.status, cached: true });
        return cached;
      }
    }
    if (intent !== "read") this.cache.clear(`${recipe.name}\n`); // a write may change what reads return

    await this.limiter.wait(url.host, policy.rateLimit ?? this.config.rateLimit);
    const started = Date.now();
    let recovered = null;
    try {
      if (isExpired(outgoing.headers.authorization) && (recovered = await this.recoverAuth(recipe, url))) outgoing = build();
      let { result, retries } = await this.sendWithRetry(recipe, outgoing, policy, intent);
      result = signInAsUnauthorized(result, outgoing.url);
      if (result.status === 401 || (result.status === 403 && !isChallenge(result))) {
        const how = await this.recoverAuth(recipe, url);
        if (how) {
          recovered = how;
          outgoing = build();
          ({ result, retries } = await this.sendWithRetry(recipe, outgoing, policy, intent));
          result = signInAsUnauthorized(result, outgoing.url);
        }
      }
      this.audit.write({
        recipe: recipe.name, tool, method: request.method, url: outgoing.url, status: result.status, ms: Date.now() - started, transport: result.transport,
        ...(recovered ? { reauth: recovered } : {}), ...(retries ? { retries } : {}),
      });
      if (ttl > 0 && result.status < 400) this.cache.set(cacheKey, result);
      return result;
    } catch (error) {
      this.audit.write({ recipe: recipe.name, tool, method: request.method, url: outgoing.url, error: String(error?.message ?? error).slice(0, 200), ms: Date.now() - started });
      throw error;
    }
  }

  /**
   * Sends with automatic retries of temporary failures (see shouldRetry), waiting Retry-After or an exponential backoff.
   * @param {any} recipe @param {any} outgoing @param {import("./safety.js").Policy} policy @param {import("./safety.js").Intent} intent
   */
  async sendWithRetry(recipe, outgoing, policy, intent) {
    const host = new URL(outgoing.url).host;
    for (let attempt = 0; ; attempt++) {
      let result = null;
      let error = null;
      try {
        result = await this.transport(recipe, outgoing, policy);
      } catch (caught) {
        error = caught;
      }
      if (attempt >= (this.config.retries ?? 2) || !shouldRetry(result && !isChallenge(result) ? result : null, error, intent)) {
        if (error) throw error;
        return { result: /** @type {import("./tools/http.js").HttpResult} */ (result), retries: attempt };
      }
      const delay = retryDelay(result?.headers?.["retry-after"], attempt);
      log(`${recipe.name}: ${error ? String(/** @type {any} */ (error).message ?? error).slice(0, 80) : `HTTP ${result?.status}`}, retrying in ${delay} ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      await this.limiter.wait(host, policy.rateLimit ?? this.config.rateLimit);
    }
  }

  /** Adds the stored credentials of the target host (headers and "?name" query parameters). @param {any} recipe @param {import("./tools/http.js").OutgoingRequest} request */
  withCredentials(recipe, request) {
    const url = new URL(request.url);
    const secrets = this.store.loadSecrets(recipe.name)[url.host] ?? {};
    // Order of precedence: recipe headers (configure_recipe), then stored credentials, then the call's own headers.
    /** @type {Record<string, string>} */ const headers = { ...(this.store.loadState(recipe.name).headers ?? {}) };
    for (const [key, value] of Object.entries(secrets)) {
      if (key.startsWith("{") || key.startsWith("@") || key.startsWith("~") || typeof value !== "string") continue; // path secrets, OAuth settings, stream frames
      if (!key.startsWith("?")) headers[key.toLowerCase()] = value;
      // Secret query parameter: added to calls of endpoints seen with it (a "key" of one endpoint is not a credential of the host).
      else if (!url.searchParams.has(key.slice(1)) && (!request.queryNames || request.queryNames.includes(key.slice(1)))) url.searchParams.set(key.slice(1), value);
    }
    // A path whose key was hidden in the recipe ("/v3/REDACTED") gets it back, for its own host only.
    const hiddenPath = secrets[`${SECRET_PATH_PREFIX}${url.pathname}`];
    if (url.pathname.includes("REDACTED") && typeof hiddenPath === "string") url.pathname = hiddenPath;
    // Explicit headers win over stored ones; lowercase keys avoid sending a header twice.
    for (const [key, value] of Object.entries(request.headers ?? {})) headers[key.toLowerCase()] = String(value);
    const { queryNames, ...rest } = request;
    return { ...rest, url: url.toString(), headers };
  }

  /**
   * @param {any} recipe @param {import("./tools/http.js").OutgoingRequest & { headers: Record<string, string> }} outgoing
   * @param {import("./safety.js").Policy} policy
   */
  async transport(recipe, outgoing, policy) {
    const timeoutMs = outgoing.timeoutMs ?? this.config.requestTimeoutMs;
    if (recipe.kind !== "browser") return sendRequest(outgoing, { timeoutMs });
    return this.withLock(recipe.name, async () => {
      const context = await this.browserFor(recipe.name);
      await refreshCsrfFromCookies(context, outgoing);
      if (outgoing.csrfField) await this.fillCsrfField(recipe, outgoing, context);
      // Requests leave from Node unless the user opted this recipe into in-page requests ("auto" or "page"):
      // getting past a site's bot protection is the user's decision, for sites they are allowed to automate.
      const mode = policy.transport ?? "node";
      let result;
      if (mode === "page" || (mode === "auto" && this.pageMode.has(recipe.name))) result = await this.sendFromPage(recipe, outgoing);
      else {
        result = await sendRequest(outgoing, { timeoutMs, context });
        if (mode === "auto" && isChallenge(result)) {
          // Bot protection: retry with the real browser network stack, and keep doing so for this recipe.
          const retried = await this.sendFromPage(recipe, outgoing).catch((error) => {
            log(`in-page retry failed: ${error.message}`);
            return null;
          });
          if (retried) {
            if (!isChallenge(retried)) this.pageMode.add(recipe.name);
            result = retried;
          }
        }
      }
      await saveCookies(context, this.store.profileDir(recipe.name)); // responses may refresh the session
      return result;
    });
  }

  /**
   * Form CSRF token (Rails authenticity_token, Django csrfmiddlewaretoken, Laravel _token): when the call does not give
   * one, the current token of the session is read from the site's page (meta tag), else from its CSRF cookie.
   * Call under the recipe lock.
   * @param {any} recipe @param {import("./tools/http.js").OutgoingRequest} outgoing @param {import("playwright-core").BrowserContext} context
   */
  async fillCsrfField(recipe, outgoing, context) {
    const field = /** @type {string} */ (outgoing.csrfField);
    delete outgoing.csrfField;
    if (/^(GET|HEAD)$/i.test(outgoing.method)) return;
    const body = outgoing.body === undefined || outgoing.body === null ? {} : outgoing.body;
    if (typeof body !== "object" || Array.isArray(body) || (body[field] && body[field] !== "REDACTED")) return;
    let token = null;
    const read = (/** @type {import("playwright-core").Page} */ page) =>
      page.evaluate(() => document.querySelector('meta[name="csrf-token"], meta[name="_csrf"], meta[name="csrf_token"], meta[name="xsrf-token"]')?.getAttribute("content") || null);
    try {
      const page = await this.pageFor(recipe.name);
      token = await read(page);
      // The page discovery started from (often the sign-in page) may not carry the token: try the site's home page.
      if (!token) {
        await page.goto(new URL("/", outgoing.url).toString(), { waitUntil: "domcontentloaded", timeout: this.config.requestTimeoutMs * 2 });
        token = await read(page);
      }
    } catch (error) {
      log(`CSRF token: ${error.message}`);
    }
    if (!token) token = (await context.cookies(outgoing.url).catch(() => [])).find((c) => /^(csrftoken|csrf_token|_csrf)$/i.test(c.name))?.value ?? null;
    if (token) outgoing.body = { ...body, [field]: token };
  }

  /** Page of the site kept open for in-page requests and UI control. Call under the recipe lock. @param {string} name @param {string} [url] */
  async pageFor(name, url) {
    const context = await this.browserFor(name);
    const entry = this.browsers.get(name);
    if (!entry) throw new Error(`The browser of "${name}" closed while opening a page.`);
    if (entry.page && !entry.page.isClosed()) {
      if (url) await entry.page.goto(url, { waitUntil: "domcontentloaded", timeout: this.config.requestTimeoutMs * 2 });
      return entry.page;
    }
    const page = context.pages().find((p) => !p.isClosed()) ?? (await context.newPage());
    const start = url ?? this.siteUrl(this.recipes.get(name));
    if (start && (url || !page.url().startsWith(new URL(start).origin))) {
      await page.goto(start, { waitUntil: "domcontentloaded", timeout: this.config.requestTimeoutMs * 2 }).catch((error) => log(`page load: ${error.message}`));
    }
    entry.page = page;
    return page;
  }

  /** The page the recipe was discovered from (original URL kept in local state, else the recipe's source or base URL). @param {any} recipe */
  siteUrl(recipe) {
    if (!recipe) return null;
    const saved = this.store.loadState(recipe.name).discovery?.url;
    if (saved) return saved;
    const source = String(recipe.source?.url ?? "");
    return source && !source.includes("REDACTED") ? source : recipe.baseUrl;
  }

  /** @param {any} recipe @param {import("./tools/http.js").OutgoingRequest & { headers: Record<string, string> }} outgoing */
  async sendFromPage(recipe, outgoing) {
    const page = await this.pageFor(recipe.name);
    const site = this.siteUrl(recipe);
    const origins = [new URL(outgoing.url).origin, site ? new URL(site).origin : null];
    let current = null;
    try {
      current = new URL(page.url()).origin;
    } catch {}
    // The page may have been moved elsewhere by the ui tool: go back to the site so the request is same-origin.
    if (site && !origins.includes(current)) await page.goto(site, { waitUntil: "domcontentloaded", timeout: this.config.requestTimeoutMs * 2 }).catch((error) => log(`page load: ${error.message}`));
    // CSRF tokens published in the page (meta tags) replace stale captured values.
    const csrfHeaders = Object.keys(outgoing.headers).filter((h) => /csrf|xsrf/i.test(h));
    if (csrfHeaders.length) {
      const token = await page
        .evaluate(
          () =>
            document
              .querySelector('meta[name="csrf-token"], meta[name="_csrf"], meta[name="csrf_token"], meta[name="xsrf-token"], meta[name="csrf"]')
              ?.getAttribute("content") ?? null,
        )
        .catch(() => null);
      if (token) for (const header of csrfHeaders) outgoing.headers[header] = token;
    }
    return sendInPage(page, outgoing, { timeoutMs: outgoing.timeoutMs ?? this.config.requestTimeoutMs });
  }

  /**
   * Gets fresh credentials after a 401 or an expired JWT: OAuth refresh when configured, otherwise (browser recipes)
   * reloads the site headlessly in the recipe's profile and keeps the auth headers the app sends.
   * @param {any} recipe @param {URL} url @returns {Promise<"oauth" | "browser" | null>}
   */
  async recoverAuth(recipe, url) {
    const attemptKey = `${recipe.name} ${url.host}`;
    const secrets = this.store.loadSecrets(recipe.name);
    const oauth = /** @type {any} */ (secrets[url.host]?.["@oauth"]);
    if (oauth?.token_url && oauth.refresh_token) {
      try {
        const token = await refreshOAuth(oauth, this.config.requestTimeoutMs);
        const scheme = /^bearer$/i.test(token.tokenType) ? "Bearer" : token.tokenType;
        secrets[url.host] = {
          ...secrets[url.host], authorization: `${scheme} ${token.accessToken}`,
          "@oauth": { ...oauth, ...(token.refreshToken ? { refresh_token: token.refreshToken } : {}) },
        };
        this.store.saveSecrets(recipe.name, secrets);
        log(`${recipe.name}: access token refreshed (OAuth)`);
        return "oauth";
      } catch (error) {
        log(`${recipe.name}: ${error.message}`);
      }
    }
    if (recipe.kind !== "browser") return null;
    // Reloading the site is expensive: a failed or useless attempt is not repeated for 30 s, so an expired token
    // that cannot be renewed does not reload the site before every call.
    if (Date.now() - (this.authAttempts.get(attemptKey) ?? 0) < 30_000) return null;
    this.authAttempts.set(attemptKey, Date.now());
    const pageUrl = this.siteUrl(recipe);
    return /** @type {Promise<"browser" | null>} */ (this.withLock(recipe.name, async () => {
      await this.closeBrowser(recipe.name); // saves the cookies
      const cookiesBefore = savedCookieFingerprint(this.store.profileDir(recipe.name), url.hostname);
      const capture = await captureTraffic(this.config, { url: pageUrl, profileDir: this.store.profileDir(recipe.name), hosts: [url.hostname], onProgress: log }).catch((error) => {
        log(`${recipe.name}: re-authentication failed: ${error.message}`);
        return null;
      });
      if (!capture) return null;
      const fresh = inferEndpoints(capture.observations, { secretCookies: false, maxEndpoints: 1000 }).secrets[url.host];
      const current = this.store.loadSecrets(recipe.name);
      const changed = fresh && Object.entries(fresh).some(([key, value]) => !key.startsWith("{") && current[url.host]?.[key] !== value);
      // Cookie sessions (Grafana rotates its session cookie): the page load renewed the cookies, not the headers.
      const cookiesRenewed = savedCookieFingerprint(this.store.profileDir(recipe.name), url.hostname) !== cookiesBefore;
      if (!changed && !cookiesRenewed) return null;
      if (changed) {
        current[url.host] = { ...(current[url.host] ?? {}), ...fresh };
        this.store.saveSecrets(recipe.name, current);
      }
      this.authAttempts.delete(attemptKey);
      log(`${recipe.name}: credentials renewed from a fresh page load`);
      return "browser";
    }));
  }

  /**
   * Policy check for stream tools (WebSocket, Server-Sent Events, MQTT) before they connect.
   * Returns the message to give instead of connecting (refused, or waiting for confirm=true), or null.
   * @param {any} recipe @param {string} address @param {import("./safety.js").Intent} intent @param {boolean} confirmed
   */
  guardStream(recipe, address, intent, confirmed) {
    const url = new URL(address);
    const policy = this.store.loadState(recipe.name).policy ?? {};
    const decision = checkPolicy(policy, { intent, url, confirmed }, this.config.confirm, this.config.orgPolicy);
    if (!decision) return null;
    if (decision.blocked) this.audit.write({ recipe: recipe.name, method: "STREAM", url: address, outcome: "blocked" });
    return decision.blocked ? { text: `Blocked: ${decision.reason}`, isError: true } : { text: decision.reason };
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
    /** @type {Record<string, string>} */ const paths = {};
    for (const [key, value] of Object.entries(secrets[url.host] ?? {})) {
      if (key.startsWith(SECRET_PATH_PREFIX) && typeof value === "string") paths[key.slice(SECRET_PATH_PREFIX.length)] = value;
      else if (key.startsWith("?")) query[key.slice(1)] = value;
      // "{name}" path secrets, "~frames~" stream secrets and "@oauth" settings are not headers.
      else if (!/^[{~@]/.test(key) && typeof value === "string") headers[key.toLowerCase()] = value;
    }
    if (/^wss?:$/.test(url.protocol) && !headers.origin) headers.origin = new URL(recipe.baseUrl).origin;
    if (recipe.kind === "browser" && !headers.cookie) {
      const cookieUrl = new URL(address);
      cookieUrl.protocol = /^(wss|https):$/.test(url.protocol) ? "https:" : "http:";
      const cookies = await this.withLock(recipe.name, async () => (await this.browserFor(recipe.name)).cookies(cookieUrl.toString()));
      if (cookies.length) headers.cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    }
    return { headers, query, paths, frames: secrets[SECRET_FRAME_HOST(url.host)] ?? {} };
  }

  /** @param {any} recipe @param {Record<string, Record<string, any>>} [secrets] @param {string[]} [typedSecrets] text typed into password fields */
  saveRecipe(recipe, secrets = {}, typedSecrets = []) {
    const existingSecrets = this.store.loadSecrets(recipe.name);
    const merged = { ...existingSecrets };
    for (const [host, headers] of Object.entries(secrets)) merged[host] = { ...(merged[host] ?? {}), ...headers };
    // Last line of defence: no stored secret value, no typed password, and nothing that looks like a credential may remain in the shareable recipe.
    recipe = scrubRecipe(recipe, secretValues(merged), typedSecrets);
    this.store.saveRecipe(recipe);
    this.store.saveSecrets(recipe.name, merged);
    this.recipes.set(recipe.name, recipe);
    this.rebuildTools();
    return recipe;
  }

  /**
   * @param {{ name: string, url: string, mode?: "auto" | "openapi" | "browser", actions?: unknown, interactive?: boolean,
   *   durationSeconds?: number, hosts?: string[], include?: string, maxEndpoints?: number, merge?: boolean, explorePages?: number }} options
   * @param {(message: string) => void} [onProgress]
   */
  async discover(options, onProgress = () => {}) {
    if (/^preset:/i.test(String(options.url ?? ""))) return this.discoverPreset(options, onProgress);
    const { name, url, mode = "auto", interactive = false, durationSeconds, hosts = [], include, merge = false, explorePages = 0 } = options;
    if (!Number.isInteger(explorePages) || explorePages < 0 || explorePages > 100) throw new Error("explore_pages must be an integer between 0 and 100");
    assertRecipeName(name);
    assertHttpUrl(url);
    if (!["auto", "openapi", "browser"].includes(mode)) throw new Error(`Unknown mode "${mode}"`);
    if (include) new RegExp(include); // validate early
    const actions = validateActions(options.actions);
    this.assertOrgAllows(url, ...actions.map((a) => (a.goto ? new URL(a.goto, url).toString() : undefined)));
    const maxEndpoints = options.maxEndpoints ?? this.config.maxEndpoints;

    if (mode !== "browser") {
      onProgress("Looking for a published OpenAPI / Swagger description");
      const found = await findOpenApi(url, { timeoutMs: Math.min(this.config.requestTimeoutMs, 10_000) });
      if (found?.soap) return this.saveSoapRecipe(name, found.soap, { url: redactUrl(url), specUrl: redactUrl(found.specUrl) }, include);
      if (found) {
        const normalized = normalizeOpenApi(found.spec, found.specUrl, { include, maxTools: this.operationLimit() });
        const now = new Date().toISOString();
        const recipe = {
          schemaVersion: RECIPE_SCHEMA_VERSION, name, kind: "openapi", source: { url: redactUrl(url), specUrl: redactUrl(found.specUrl) },
          title: normalized.title, baseUrl: normalized.baseUrl, createdAt: this.recipes.get(name)?.createdAt ?? now, updatedAt: now,
          operations: normalized.operations, routes: normalized.routes, warnings: normalized.warnings,
          ...carryOver(this.recipes.get(name)),
        };
        this.store.updateState(name, (s) => ({ ...s, discovery: { url, mode: "openapi", include } }));
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
        url, profileDir: this.store.profileDir(name), actions, interactive, durationSeconds, hosts, explorePages, onProgress,
      });
      // Original inputs (they may hold secrets) stay in local state, for re-authentication and repair; merged captures are kept as extras.
      const inputs = { url, mode: "browser", actions, hosts, explorePages };
      const merging = merge && this.recipes.get(name)?.kind === "browser";
      this.store.updateState(name, (s) =>
        merging && s.discovery ? { ...s, extraDiscoveries: [...(s.extraDiscoveries ?? []), inputs].slice(-10) } : { ...s, discovery: inputs, extraDiscoveries: [] },
      );
      onProgress(`Analysing ${capture.observations.length} captured requests`);
      const inferred = inferEndpoints(capture.observations, {
        variables: navigationVariables(capture.pageUrls, capture.typedTexts), maxEndpoints, secretCookies: false,
      });
      const realtime = inferStreams(capture.streams, { secretCookies: false });
      const rpc = withJsonRpc(capture.observations, inferred.endpoints);
      const pages = inferPages(capture.documents);
      const previous = this.recipes.get(name);
      const now = new Date().toISOString();
      const canMerge = merge && previous?.kind === "browser";
      // A page that shows its data in the HTML is not "nothing found": it became a page tool.
      const noApi = (/** @type {string} */ w) =>
        (/^No API call was observed/.test(w) && (!!capture.blocked || pages.length > 0)) || (/^Traffic was captured but no reusable API call/.test(w) && pages.length > 0);
      const recipe = {
        schemaVersion: RECIPE_SCHEMA_VERSION, name, kind: "browser", source: { url: redactUrl(url) },
        baseUrl: new URL(url).origin, createdAt: previous?.createdAt ?? now, updatedAt: now,
        endpoints: canMerge ? mergeByKey(previous.endpoints, rpc.endpoints, restKey) : rpc.endpoints,
        graphql: canMerge ? mergeByKey(previous.graphql, inferred.graphql, graphqlKey) : inferred.graphql,
        streams: canMerge ? mergeByKey(previous.streams ?? [], realtime.streams, streamKey) : realtime.streams,
        jsonrpc: canMerge ? mergeByKey(previous.jsonrpc ?? [], rpc.methods, rpcKey) : rpc.methods,
        pages: canMerge ? mergeByKey(previous.pages ?? [], pages, pageKey) : pages,
        warnings: [...(capture.blocked ? [`Blocked: ${capture.blocked}`] : []), ...capture.actionErrors, ...inferred.warnings.filter((w) => !noApi(w))],
        stats: inferred.stats,
        ...(capture.explored.length ? { explored: capture.explored.map((e) => ({ url: redactUrl(e.url), newCalls: e.newCalls })) } : {}),
        ...carryOver(previous),
      };
      return this.saveRecipe(recipe, mergeSecrets(inferred.secrets, realtime.secrets, rpc.secrets), capture.typedSecrets);
    });
  }

  /** @param {{ name: string, harPath: string, hosts?: string[], maxEndpoints?: number, merge?: boolean }} options */
  async discoverHar({ name, harPath, hosts = [], maxEndpoints, merge = false }) {
    assertRecipeName(name);
    if (!isAbsolute(harPath)) throw new Error("har_path must be an absolute path");
    const size = statSync(harPath).size;
    if (size > MAX_FILE_BYTES) throw new Error(`HAR file too large (${size} bytes, limit ${MAX_FILE_BYTES})`);
    const harText = readFileSync(harPath, "utf8");
    const har = observationsFromHar(harText, { hosts });
    const realtime = inferStreams(streamsFromHar(harText, { hosts }), { secretCookies: true });
    if (!har.baseUrl && realtime.streams.length) har.baseUrl = new URL(realtime.streams[0].url.replace(/^ws/, "http")).origin;
    if (!har.baseUrl) throw new Error("The HAR file contains no usable API request (JSON responses, successful writes or WebSocket / event streams).");
    const inferred = inferEndpoints(har.observations, {
      variables: navigationVariables(har.pageUrls), maxEndpoints: maxEndpoints ?? this.config.maxEndpoints, secretCookies: true,
    });
    const rpc = withJsonRpc(har.observations, inferred.endpoints);
    const previous = this.recipes.get(name);
    const now = new Date().toISOString();
    const canMerge = merge && previous?.kind === "har";
    const recipe = {
      schemaVersion: RECIPE_SCHEMA_VERSION, name, kind: "har", source: { harFile: basename(harPath), domains: har.domains },
      baseUrl: har.baseUrl, createdAt: previous?.createdAt ?? now, updatedAt: now,
      endpoints: canMerge ? mergeByKey(previous.endpoints, rpc.endpoints, restKey) : rpc.endpoints,
      graphql: canMerge ? mergeByKey(previous.graphql, inferred.graphql, graphqlKey) : inferred.graphql,
      streams: canMerge ? mergeByKey(previous.streams ?? [], realtime.streams, streamKey) : realtime.streams,
      jsonrpc: canMerge ? mergeByKey(previous.jsonrpc ?? [], rpc.methods, rpcKey) : rpc.methods,
      warnings: inferred.warnings,
      stats: inferred.stats,
      ...carryOver(previous),
    };
    return this.withLock(name, async () => this.saveRecipe(recipe, mergeSecrets(inferred.secrets, realtime.secrets, rpc.secrets)));
  }

  /** Creates a recipe from a local file or folder (see imports.js). @param {Parameters<typeof importFile>[1]} options */
  async importFile(options) {
    this.assertOrgAllows(options.path, options.baseUrl);
    return importFile(this, options);
  }

  /** Creates (or extends) a recipe from cURL commands. @param {Parameters<typeof importCurl>[1]} options */
  importCurl(options) {
    return importCurl(this, options);
  }

  /** Writes a recipe (never its secrets) to a file. @param {Parameters<typeof exportRecipe>[1]} options */
  exportRecipe(options) {
    return exportRecipe(this, options);
  }

  /** @param {string} name @param {any} soap @param {Record<string, unknown>} source @param {string} [include] */
  saveSoapRecipe(name, soap, source, include) {
    return saveSoapRecipe(this, name, soap, source, include);
  }

  /** Opens a visible browser on the recipe profile so the user can sign in. */
  async login({ name, url, durationSeconds = 180 }) {
    assertRecipeName(name);
    assertHttpUrl(url);
    this.assertOrgAllows(url);
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
    for (const [rawKey, value] of Object.entries(headers)) {
      const key = rawKey.startsWith("?") ? rawKey : rawKey.toLowerCase(); // query parameter names are case-sensitive
      if (value === null || value === "") delete current[key];
      else current[key] = String(value);
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

  /**
   * First OAuth sign-in for an API host: the provider's consent page opens in a visible window (the recipe's browser profile),
   * the access token is stored as the host's Authorization header and the refresh token as its "@oauth" settings.
   * @param {{ name: string, host: string, provider?: string, authorizeUrl?: string, tokenUrl?: string, clientId: string, clientSecret?: string,
   *   scopes?: string[], extra?: Record<string, string>, redirectPort?: number, durationSeconds?: number, visible?: boolean }} options
   */
  async oauthLogin({ name, host, provider, authorizeUrl, tokenUrl, clientId, clientSecret, scopes = [], extra = {}, redirectPort, durationSeconds = 300, visible = true }) {
    assertRecipeName(name);
    if (!host || /[/\s]/.test(host)) throw new Error('host must be the bare API host the token is sent to, e.g. "youtubeanalytics.googleapis.com"');
    if (!clientId) throw new Error("client_id is required (create an OAuth client in the provider's developer console; use a desktop / native app type)");
    const known = provider ? OAUTH_PROVIDERS[/** @type {keyof typeof OAUTH_PROVIDERS} */ (provider)] : undefined;
    if (provider && !known) throw new Error(`Unknown provider "${provider}". Known: ${Object.keys(OAUTH_PROVIDERS).join(", ")}; or pass authorize_url and token_url.`);
    const authorize = authorizeUrl ?? known?.authorize_url;
    const token = tokenUrl ?? known?.token_url;
    if (!authorize || !token) throw new Error("authorize_url and token_url are required when no provider is given.");
    this.assertOrgAllows(authorize, token, `https://${host}`);
    return this.withLock(name, async () => {
      await this.closeBrowser(name);
      const profileDir = this.store.profileDir(name);
      const context = await launchProfile(this.config, profileDir, { headless: !visible });
      try {
        const result = await authorizationCodeLogin({
          authorizeUrl: authorize, tokenUrl: token, clientId, clientSecret, scopes, extra: { ...(known?.extra ?? {}), ...extra }, redirectPort,
          timeoutMs: Math.min(Math.max(durationSeconds, 10), 1800) * 1000,
          openUrl: async (url) => {
            const page = context.pages()[0] ?? (await context.newPage());
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.config.requestTimeoutMs * 2 });
          },
        });
        const secrets = this.store.loadSecrets(name);
        const scheme = /^bearer$/i.test(result.tokenType) ? "Bearer" : result.tokenType;
        secrets[host] = {
          ...(secrets[host] ?? {}),
          authorization: `${scheme} ${result.accessToken}`,
          ...(result.refreshToken ? { "@oauth": /** @type {any} */ ({ token_url: token, refresh_token: result.refreshToken, client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) }) } : {}),
        };
        this.store.saveSecrets(name, secrets);
        return { host, refreshable: !!result.refreshToken, scope: result.scope, expiresIn: result.expiresIn };
      } finally {
        await closeProfile(context, profileDir);
      }
    });
  }

  /**
   * Operations kept per OpenAPI recipe: all of them in compact mode (they are reached through __operation / __call),
   * otherwise UNWALLED_MAX_OPENAPI_TOOLS.
   */
  operationLimit() {
    return this.config.foldThreshold > 0 ? Math.max(this.config.maxOpenApiTools, 5000) : this.config.maxOpenApiTools;
  }

  /**
   * discover(name, "preset:<id>"): a ready-made source from the catalogue (presets.js).
   * @param {Parameters<Engine["discover"]>[0]} options @param {(message: string) => void} onProgress
   */
  async discoverPreset(options, onProgress) {
    const preset = resolvePreset(options.url);
    onProgress(`Preset ${preset.id}: ${preset.title}`);
    let recipe;
    if ("url" in preset.source) recipe = await this.discover({ ...options, url: preset.source.url, mode: "openapi" }, onProgress);
    else {
      // Built-in descriptions are written to the cache and imported like a file.
      const file = join(this.config.home, "cache", `preset-${preset.id.replace(/[^a-z0-9-]+/g, "_")}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify("spec" in preset.source ? preset.source.spec : preset.source.asyncapi));
      recipe = await this.importFile({ name: options.name, path: file, include: options.include });
    }
    if (preset.auth) {
      recipe.warnings = [`Credentials: ${preset.auth}`, ...(recipe.warnings ?? []).filter((w) => !w.startsWith("Credentials: "))];
      this.store.saveRecipe(recipe);
    }
    return recipe;
  }

  /**
   * Local file or folder holding a data recipe's data: the source path, or (remote data) a cache refreshed after source.refreshSeconds.
   * @param {any} recipe @returns {Promise<string>}
   */
  async dataPath(recipe) {
    if (!recipe.source?.remote) return recipe.source.path;
    const url = this.store.loadSecrets(recipe.name)[REMOTE_DATA_KEY]?.url;
    if (!url) throw new Error(`The address of "${recipe.name}" is not stored on this machine: import it again with import_file.`);
    if (recipe.source.db) return url; // databases are queried directly
    const file = cacheFile(this.config.home, recipe.name, recipe.source.extension);
    await fetchToCache(url, file, { maxAgeMs: (recipe.source.refreshSeconds ?? 300) * 1000, timeoutMs: this.config.requestTimeoutMs });
    return file;
  }

  /** @param {string} name @param {{ deleteProfile?: boolean }} [options] @returns {Promise<{ restoredFromTeam: boolean }>} */
  async forget(name, { deleteProfile = false } = {}) {
    this.recipe(name);
    if (this.store.isTeamRecipe(name))
      throw new Error(`"${name}" comes from the team catalogue (${this.config.teamRecipesDir}): it is shared with others, so remove it there.`);
    return this.withLock(name, async () => {
      await this.closeBrowser(name);
      const extension = this.recipes.get(name)?.source?.extension;
      if (extension) rmSync(cacheFile(this.config.home, name, extension), { force: true });
      this.store.deleteRecipe(name, { profile: deleteProfile });
      // A personal copy of a team recipe: the team's version comes back.
      const team = this.store.loadTeamRecipes().get(name);
      if (team) {
        this.recipes.set(name, team);
        this.store.teamNames?.add(name);
      } else this.recipes.delete(name);
      this.rebuildTools();
      return { restoredFromTeam: !!team };
    });
  }

  /**
   * Reads the recipe folders again (the team catalogue may have been updated by someone else). Returns whether anything changed.
   * Recipes are compared by name and update time; browsers of removed recipes are closed.
   */
  async reloadRecipes() {
    const before = new Map([...this.recipes].map(([name, recipe]) => [name, recipe.updatedAt]));
    const fresh = this.store.loadRecipes();
    const changed = fresh.size !== before.size || [...fresh].some(([name, recipe]) => before.get(name) !== recipe.updatedAt);
    if (!changed) return false;
    for (const name of before.keys()) if (!fresh.has(name)) await this.closeBrowser(name);
    this.recipes = fresh;
    this.rebuildTools();
    return true;
  }

  // ---------------------------------------------------------------- semantics, macros, policy

  /**
   * Stores agent-written names and descriptions for a recipe's tools (shared with the recipe).
   * @param {string} name @param {Record<string, { reset?: boolean, name?: string, description?: string, title?: string, hidden?: boolean, params?: Record<string, string>, defaults?: Record<string, any> | null } | null>} notes
   */
  annotateRecipe(name, notes) {
    const recipe = this.recipe(name);
    if (!notes || typeof notes !== "object") throw new Error("annotations must be an object keyed by tool name");
    const original = buildTools({ ...recipe, annotations: {} }, this.runtime).map((t) => t.name);
    const current = { ...(recipe.annotations ?? {}) };
    for (const [key, note] of Object.entries(notes)) {
      // A renamed tool can be addressed by its new name too.
      const target = original.includes(key) ? key : Object.keys(current).find((k) => current[k]?.name && `${name}__${current[k].name}` === key);
      if (!target) throw new Error(`Unknown tool "${key}" in recipe "${name}". Known: ${original.slice(0, 30).join(", ")}`);
      // reset=true (or null, for clients that send it) removes the tool's annotations before applying the rest.
      if (note === null || note?.reset === true) delete current[target];
      if (note !== null && typeof note === "object") {
        const clean = {};
        if (typeof note.name === "string") {
          if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/.test(note.name)) throw new Error(`Invalid tool name "${note.name}": letters, digits, _ and -`);
          clean.name = note.name;
        }
        if (typeof note.description === "string") clean.description = note.description.slice(0, 600);
        if (typeof note.title === "string") clean.title = note.title.slice(0, 80);
        if (typeof note.hidden === "boolean") clean.hidden = note.hidden;
        if (note.params && typeof note.params === "object") clean.params = Object.fromEntries(Object.entries(note.params).map(([k, v]) => [k, String(v).slice(0, 300)]));
        if (note.defaults !== undefined) {
          if (note.defaults !== null && (typeof note.defaults !== "object" || Array.isArray(note.defaults))) throw new Error("defaults must be an object of arguments");
          if (note.defaults && JSON.stringify(note.defaults).length > 4000) throw new Error("defaults are limited to 4000 characters");
          const refused = Object.keys(note.defaults ?? {}).filter((key) => !(key in storableArguments({ [key]: 1 })));
          if (refused.length) throw new Error(`defaults cannot contain ${refused.join(", ")}: a shared recipe must not confirm calls, write or upload local files`);
          clean.defaults = note.defaults ?? undefined;
        }
        if (Object.keys(clean).length || current[target]) current[target] = { ...(current[target] ?? {}), ...clean };
      }
    }
    return this.saveRecipe({ ...recipe, annotations: current, updatedAt: new Date().toISOString() });
  }

  /** @param {string} name @param {{ macro?: any, remove?: string }} options */
  defineMacro(name, { macro, remove }) {
    const recipe = this.recipe(name);
    let macros = [...(recipe.macros ?? [])];
    if (remove) {
      if (!macros.some((m) => m.id === remove)) throw new Error(`No macro "${remove}" in recipe "${name}"`);
      macros = macros.filter((m) => m.id !== remove);
    } else {
      const clean = validateMacro(macro);
      for (const step of clean.steps) {
        const own = (/** @type {string} */ tool) => tool.startsWith(`${name}__`) && (this.tools.has(tool) || buildTools({ ...recipe, annotations: {} }, this.runtime).some((t) => t.name === tool));
        if (!own(step.tool) && !own(`${name}__${step.tool}`))
          throw new Error(`Macro step tool "${step.tool}" is not a tool of "${name}": a macro chains the tools of its own recipe (see list_recipes)`);
      }
      macros = [...macros.filter((m) => m.id !== clean.id), clean];
    }
    return this.saveRecipe({ ...recipe, macros, updatedAt: new Date().toISOString() });
  }

  /**
   * Local settings of a recipe: safety policy, OAuth refresh credentials (stored with the secrets).
   * @param {string} name @param {{ policy?: Record<string, any> | null, oauth?: { host: string } & Record<string, any>, headers?: Record<string, string | null> }} options
   */
  configure(name, { policy, oauth, headers }) {
    assertRecipeName(name);
    const result = {};
    if (headers !== undefined) {
      if (!headers || typeof headers !== "object") throw new Error("headers must be an object of header names to values (null removes one)");
      const next = { ...(this.store.loadState(name).headers ?? {}) };
      for (const [rawName, value] of Object.entries(headers)) {
        const header = rawName.toLowerCase();
        if (!/^[a-z0-9-]{1,64}$/.test(header)) throw new Error(`Invalid header name "${rawName}"`);
        if (/^(authorization|cookie|proxy-authorization)$/.test(header)) throw new Error(`Use set_credentials for "${rawName}": it is stored as a secret`);
        if (value === null || value === "") delete next[header];
        else next[header] = String(value).slice(0, 1000);
      }
      this.store.updateState(name, (s) => ({ ...s, headers: next }));
      this.cache.clear(`${name}\n`);
      result.headers = next;
    }
    if (policy !== undefined) {
      const clean = {};
      if (policy !== null) {
        if (policy.readOnly !== undefined) clean.readOnly = !!policy.readOnly;
        if (policy.confirm !== undefined) {
          if (!["none", "destructive", "writes"].includes(policy.confirm)) throw new Error('policy.confirm must be "none", "destructive" or "writes"');
          clean.confirm = policy.confirm;
        }
        if (policy.allowedHosts !== undefined) {
          if (!Array.isArray(policy.allowedHosts) || policy.allowedHosts.some((h) => typeof h !== "string" || /[/\s]/.test(h))) throw new Error("policy.allowedHosts must be a list of bare hosts");
          clean.allowedHosts = policy.allowedHosts.map((h) => h.toLowerCase());
        }
        if (policy.rateLimit !== undefined) {
          if (typeof policy.rateLimit !== "number" || policy.rateLimit < 0) throw new Error("policy.rateLimit must be a number of requests per second (0 = unlimited)");
          clean.rateLimit = policy.rateLimit;
        }
        if (policy.cacheSeconds !== undefined) {
          if (typeof policy.cacheSeconds !== "number" || policy.cacheSeconds < 0 || policy.cacheSeconds > 86_400) throw new Error("policy.cacheSeconds must be between 0 and 86400");
          clean.cacheSeconds = policy.cacheSeconds;
        }
        if (policy.transport !== undefined) {
          if (!["auto", "node", "page"].includes(policy.transport)) throw new Error('policy.transport must be "auto", "node" or "page"');
          clean.transport = policy.transport;
        }
      }
      const reset = policy === null || policy.reset === true;
      const state = this.store.updateState(name, (s) => {
        const next = { ...(reset ? {} : (s.policy ?? {})), ...clean };
        return { ...s, policy: Object.keys(next).length ? next : undefined };
      });
      result.policy = state.policy ?? {};
    }
    if (oauth) {
      const { host, ...settings } = oauth;
      if (!host || /[/\s]/.test(host)) throw new Error("oauth.host must be the bare API host the access token is sent to");
      if (!settings.token_url || !settings.refresh_token) throw new Error("oauth needs token_url and refresh_token (client_id, client_secret, scope, encoding optional)");
      const secrets = this.store.loadSecrets(name);
      secrets[host] = { ...(secrets[host] ?? {}), "@oauth": /** @type {any} */ (settings) };
      this.store.saveSecrets(name, secrets);
      result.oauth = `refresh configured for ${host}`;
    }
    return result;
  }

  // ---------------------------------------------------------------- health and repair

  /**
   * Calls every read-only tool that has a safe example, compares responses with what was recorded at discovery,
   * and with repair=true rediscovers the recipe from its original inputs when something is broken or changed.
   * @param {string} name @param {{ repair?: boolean }} [options]
   */
  async checkRecipe(name, { repair = false } = {}) {
    const recipe = this.recipe(name);
    const results = [];
    for (const tool of this.toolsOf(name)) {
      if (!tool.probe) continue;
      let outcome;
      try {
        const result = /** @type {any} */ (await tool.run({ ...tool.probe.args, max_chars: 300 }));
        const status = Number(/^HTTP (\d+)/.exec(result.text)?.[1] ?? 0);
        const data = /** @type {any} */ (tool.probe.graphql ? (result.data?.data ?? result.data) : result.data);
        const keys = tool.probe.graphql && result.data?.errors?.length ? null : responseKeys(data);
        const missing = keys ? tool.probe.keys.filter((k) => !keys.includes(k)) : tool.probe.keys;
        if (status === 401 || status === 403) outcome = { status: "auth", detail: `HTTP ${status}` };
        else if (tool.probe.graphql && result.data?.errors?.length) outcome = { status: "broken", detail: `GraphQL error: ${String(result.data.errors[0]?.message ?? "").slice(0, 120)}` };
        else if (result.isError || status >= 400 || !status) outcome = { status: "broken", detail: result.text.split("\n")[0].slice(0, 160) };
        else if (missing.length && missing.length >= Math.ceil(tool.probe.keys.length / 2)) outcome = { status: "changed", detail: `missing fields: ${missing.slice(0, 8).join(", ")}` };
        else outcome = { status: "ok", detail: `HTTP ${status}` };
      } catch (error) {
        outcome = { status: "broken", detail: String(error.message).slice(0, 160) };
      }
      results.push({ tool: tool.name, ...outcome });
    }
    const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), /** @type {Record<string, number>} */ ({}));
    this.store.updateState(name, (s) => ({ ...s, health: { checkedAt: new Date().toISOString(), counts, results } }));
    const lines = [`Health of "${name}": ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "no tool with a safe example to call"}`];
    for (const r of results) lines.push(`  ${r.status.padEnd(7)} ${r.tool} — ${r.detail}`);
    if (counts.auth) lines.push("Some calls are refused: sign in again with login (browser recipes) or set_credentials.");

    const needsRepair = (counts.broken ?? 0) + (counts.changed ?? 0) > 0;
    if (repair && needsRepair) {
      const before = new Set(this.toolsOf(name).map((t) => t.name));
      const state = this.store.loadState(name);
      const importedFrom = recipe.source?.path ?? (recipe.source?.format && recipe.source?.file);
      if (importedFrom) {
        // Recipes imported from a file or folder are rebuilt from it (it may have been updated).
        lines.push(`Repair: importing ${importedFrom} again`);
        await this.importFile({ name, path: importedFrom, ...(recipe.kind === "openapi" || recipe.kind === "soap" ? { baseUrl: recipe.baseUrl } : {}) });
        const after = new Set(this.toolsOf(name).map((t) => t.name));
        lines.push(`  added: ${[...after].filter((t) => !before.has(t)).join(", ") || "none"}`, `  removed: ${[...before].filter((t) => !after.has(t)).join(", ") || "none"}`);
      } else if (recipe.kind === "har") lines.push("Repair: HAR recipes cannot rediscover by themselves; import a fresh capture with discover_har (same name).");
      else {
        const discovery = state.discovery ?? { url: this.siteUrl(recipe), mode: recipe.kind === "openapi" ? "openapi" : "browser" };
        lines.push(`Repair: rediscovering from ${redactUrl(discovery.url)}${state.extraDiscoveries?.length ? ` and ${state.extraDiscoveries.length} merged capture(s)` : ""}`);
        await this.discover({ ...discovery, name, merge: false });
        for (const extra of state.extraDiscoveries ?? []) await this.discover({ ...extra, name, merge: true });
        if (state.extraDiscoveries?.length) this.store.updateState(name, (s) => ({ ...s, extraDiscoveries: state.extraDiscoveries }));
        const after = new Set(this.toolsOf(name).map((t) => t.name));
        const added = [...after].filter((t) => !before.has(t));
        const removed = [...before].filter((t) => !after.has(t));
        lines.push(`  added: ${added.join(", ") || "none"}`, `  removed: ${removed.join(", ") || "none"}`);
        lines.push("Annotations and macros were kept; check that macro steps still point to existing tools.");
      }
    } else if (needsRepair) lines.push("Run check_recipe again with repair=true to rediscover the recipe.");
    return { text: lines.join("\n"), results, counts };
  }

  // ---------------------------------------------------------------- user interface control

  /**
   * Drives the site's interface in the recipe's browser profile (works without any recipe too: the name is then just a profile).
   * @param {{ name: string, action: "open" | "snapshot" | "act" | "read" | "screenshot" | "close", url?: string, steps?: unknown, selector?: string,
   *   confirm?: boolean, visible?: boolean, maxChars?: number, saveTo?: string }} options
   * @returns {Promise<{ text: string, isError?: boolean, image?: string }>}
   */
  async ui({ name, action, url, steps, selector, confirm = false, visible, maxChars, saveTo }) {
    assertRecipeName(name);
    if (!["open", "snapshot", "act", "read", "screenshot", "close"].includes(action)) throw new Error(`Unknown ui action "${action}"`);
    if (url) assertHttpUrl(url);
    const org = this.config.orgPolicy;
    const blockedUrl = url ? orgHostBlock(org, new URL(url)) : null;
    if (blockedUrl) return { text: blockedUrl, isError: true };
    const policy = this.store.loadState(name).policy ?? {};
    const validSteps = action === "act" ? validateUiSteps(steps) : [];
    return this.withLock(name, async () => {
      if (action === "close") {
        await this.closeBrowser(name);
        return { text: `Browser for "${name}" closed (cookies saved).` };
      }
      if (visible !== undefined) await this.browserFor(name, { headless: !visible });
      if (action === "open" && !url) throw new Error("open needs a url");
      if (url) await this.limiter.wait(new URL(url).host, policy.rateLimit ?? this.config.rateLimit);
      const page = await this.pageFor(name, action === "open" ? url : undefined);
      if (page.url() === "about:blank" && action !== "open") throw new Error(`No page is open for "${name}": call ui with action=open and a url first.`);
      // A click may have led the page to another site: nothing is read from or done on a host the organization does not allow.
      const offLimits = page.url() === "about:blank" ? null : orgHostBlock(org, new URL(page.url()));
      if (offLimits) return { text: offLimits, isError: true };
      this.audit.write({ recipe: name, ui: action, url: page.url() });
      switch (action) {
        case "open":
        case "snapshot":
          return { text: await snapshot(page) };
        case "read":
          return { text: await readText(page, { selector, maxChars: maxChars ?? this.config.maxOutputChars }) };
        case "screenshot": {
          const png = await page.screenshot({ type: "png" });
          if (saveTo) {
            if (!isAbsolute(saveTo)) throw new Error("save_to must be an absolute path");
            writeFileSync(saveTo, png);
            return { text: `Screenshot of ${page.url()} saved to ${saveTo}` };
          }
          return { text: `Screenshot of ${page.url()}`, image: png.toString("base64") };
        }
        default: {
          if (org?.readOnly) return { text: "Blocked by the organization policy: every recipe is read-only; interface actions are refused.", isError: true };
          if (policy.readOnly) return { text: "Blocked: this recipe is read-only (policy readOnly=true); interface actions are refused.", isError: true };
          const risky = await riskyTargets(page, validSteps);
          if (risky.length && stricterConfirm(policy.confirm ?? this.config.confirm, org?.confirm) !== "none" && !confirm)
            return { text: `These steps click controls that may delete, pay or send something: ${risky.join("; ")}.\nCheck with the user, then call again with confirm=true.` };
          for (const step of validSteps) {
            if (typeof step.goto !== "string") continue;
            const target = new URL(step.goto, page.url());
            const refused = /^https?:$/.test(target.protocol) ? orgHostBlock(org, target) : `Blocked: goto only accepts http(s) addresses, got ${target.protocol}`;
            if (refused) return { text: refused, isError: true };
          }
          const result = await act(page, validSteps, { timeoutMs: this.config.requestTimeoutMs * 2 });
          await saveCookies(page.context(), this.store.profileDir(name));
          // A click may have led to a host the organization does not allow: its content is not returned.
          const landed = page.url() === "about:blank" ? null : orgHostBlock(org, new URL(page.url()));
          if (landed) return { text: `${result.log}\n\n${landed}`, isError: true };
          return { text: `${result.log}\n\n${await snapshot(page)}`, isError: !result.ok };
        }
      }
    });
  }

  async close() {
    await Promise.all([...this.browsers.keys()].map((name) => this.closeBrowser(name)));
    await closeDataConnections();
  }
}

/** Agent-written annotations and macros survive rediscovery. @param {any} previous */
function carryOver(previous) {
  return {
    ...(previous?.annotations && Object.keys(previous.annotations).length ? { annotations: previous.annotations } : {}),
    ...(previous?.macros?.length ? { macros: previous.macros } : {}),
  };
}

/**
 * A call redirected to the sign-in page got that page, not its answer: it is reported as 401 so that the session is
 * renewed (or the agent is told to sign in again) instead of the sign-in page being taken for data.
 * @param {import("./tools/http.js").HttpResult} result @param {string} requested
 */
function signInAsUnauthorized(result, requested) {
  if (result.status >= 400 || !redirectedToSignIn(requested, result.finalUrl)) return result;
  return { ...result, status: 401, statusText: "Redirected to the sign-in page" };
}

/**
 * Double-submit CSRF: when a captured header carries a CSRF token and the site also keeps it in a cookie
 * (XSRF-TOKEN, csrftoken...), the current cookie value replaces the stale captured one.
 * @param {import("playwright-core").BrowserContext} context @param {{ url: string, headers: Record<string, string> }} outgoing
 */
async function refreshCsrfFromCookies(context, outgoing) {
  const names = Object.keys(outgoing.headers).filter((h) => /csrf|xsrf/i.test(h));
  if (!names.length) return;
  const cookie = (await context.cookies(outgoing.url).catch(() => [])).find((c) => /xsrf|csrf/i.test(c.name));
  if (!cookie) return;
  let value = cookie.value;
  try {
    value = decodeURIComponent(value);
  } catch {}
  for (const name of names) outgoing.headers[name] = value;
}

/**
 * Summary of a recipe, for tool results and the CLI. With tool objects (not just names), each tool is listed with what it
 * does and an example call.
 * @param {any} recipe @param {(string | { name: string, description?: string, example?: Record<string, any>, probe?: { args: Record<string, any> } })[]} toolNames
 */
export function describeRecipe(recipe, toolNames) {
  const tools = toolNames.map((t) => (typeof t === "string" ? { name: t } : t));
  const lines = [`Recipe "${recipe.name}" (${recipe.kind}) — base ${recipe.baseUrl} — updated ${recipe.updatedAt}`];
  if (recipe.kind === "data") lines.push(`${recipe.source.db ? `${recipe.source.db === "mysql" ? "MySQL / MariaDB" : "PostgreSQL"}: ${recipe.source.origin}` : recipe.source.remote ? `Remote data: ${recipe.source.origin}/… (refreshed every ${recipe.source.refreshSeconds}s)` : `Local data: ${recipe.source.path}`} — ${(recipe.tables ?? []).map((t) => `${t.name} (${t.rows} rows: ${t.columns.map((c) => c.name).slice(0, 10).join(", ")})`).join("; ")}`);
  else if (recipe.kind === "soap") lines.push(`SOAP ${recipe.version}: ${recipe.endpoint} — ${recipe.title} — ${recipe.operations.length} operation(s): ${recipe.operations.map((o) => o.name).join(", ")}`);
  else if (recipe.kind === "openapi") lines.push(`${recipe.source.format ? `${recipe.source.format} file` : "OpenAPI"}: ${recipe.source.specUrl ?? recipe.source.file} — ${recipe.title ?? "untitled"} — ${recipe.routes.length} routes, ${recipe.operations.length} with dedicated tools.`);
  else {
    if (recipe.stats) lines.push(`Captured ${recipe.stats.observed} requests, ${recipe.stats.usable} usable.`);
    for (const op of recipe.graphql) lines.push(`  GraphQL ${op.operationType} ${op.operationName ?? "(anonymous)"} @ ${op.url} (${op.observed}×)`);
    lines.push(...describeStreams(recipe));
    for (const m of recipe.jsonrpc ?? []) lines.push(`  JSON-RPC ${m.method} @ ${m.url} (${m.observed}×)`);
    for (const e of recipe.endpoints) lines.push(`  ${e.method} ${e.origin}${e.pathTemplate}${Object.keys(e.query).length ? `?${Object.keys(e.query).join("&")}` : ""} (${e.observed}×)`);
    for (const p of recipe.pages ?? []) lines.push(`  Page ${p.origin}${p.pathTemplate}${Object.keys(p.query).length ? `?${Object.keys(p.query).join("&")}` : ""} (server-rendered${p.tables ? `, ${p.tables} table(s)` : ""})`);
  }
  for (const macro of recipe.macros ?? []) lines.push(`  Macro ${macro.id}: ${macro.description}`);
  if (recipe.explored?.length) lines.push(`Explored ${recipe.explored.length} pages: ${recipe.explored.map((e) => `${e.url} (+${e.newCalls})`).slice(0, 10).join(", ")}`);
  for (const warning of recipe.warnings ?? []) lines.push(`Warning: ${warning}`);
  if (!tools.some((t) => t.description)) lines.push(`Tools: ${tools.map((t) => t.name).join(", ")}`);
  else {
    // What each tool does and a call that works: the agent can answer at once instead of searching the tools first.
    lines.push("Tools (call them directly; if your client has not loaded them yet, use call_tool with the same name and arguments):");
    for (const tool of tools.slice(0, 25)) {
      const summary = String(tool.description ?? "").split(/\. \[|\. (?=[A-Z])/)[0].slice(0, 140);
      const args = tool.example ?? tool.probe?.args;
      const example = args && Object.keys(args).length ? ` — e.g. ${JSON.stringify(args).slice(0, 200)}` : "";
      lines.push(`  ${tool.name}: ${summary}${example}`);
    }
    if (tools.length > 25) lines.push(`  … ${tools.length - 25} more: search_tools finds them.`);
  }
  return lines.join("\n");
}
