// Records the API traffic of a real browser while it loads a page and replays scripted actions
// (or while the user browses in interactive mode).
import { closeProfile, launchProfile, saveCookies } from "../browser.js";
import { attachRealtimeCapture } from "../realtime/capture.js";
import { parseJsonLoose } from "../tools/formats.js";
import { htmlToText } from "../tools/http.js";
import { isTracker, registrableDomain } from "./infer.js";
import { isSignInPath } from "./pages.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const ACTION_KEYS = ["goto", "click", "fill", "press", "wait", "scroll", "waitFor"];

/**
 * @typedef {{ goto?: string, click?: string, fill?: string, text?: string, press?: string, wait?: number, scroll?: number, waitFor?: string }} Action
 */

/** @param {unknown} actions @returns {Action[]} */
export function validateActions(actions) {
  if (actions === undefined || actions === null) return [];
  if (!Array.isArray(actions)) throw new Error("actions must be an array");
  return actions.map((action, index) => {
    if (!action || typeof action !== "object") throw new Error(`actions[${index}] must be an object`);
    const keys = Object.keys(action).filter((k) => ACTION_KEYS.includes(k));
    if (keys.length !== 1) throw new Error(`actions[${index}] must have exactly one of: ${ACTION_KEYS.join(", ")}`);
    if (keys[0] === "fill" && typeof action.text !== "string") throw new Error(`actions[${index}] (fill) needs a "text" string`);
    if ((keys[0] === "wait" || keys[0] === "scroll") && typeof action[keys[0]] !== "number") throw new Error(`actions[${index}].${keys[0]} must be a number`);
    if (!["wait", "scroll"].includes(keys[0]) && typeof action[keys[0]] !== "string") throw new Error(`actions[${index}].${keys[0]} must be a string`);
    return action;
  });
}

/**
 * Action as shown in progress messages and warnings (warnings are saved in the shareable recipe): typed text is never
 * shown, since a selector does not tell whether the field holds a password.
 * @param {Action} action
 */
export function describeAction(action) {
  if (action.fill === undefined) return JSON.stringify(action);
  return JSON.stringify({ ...action, text: `••• (${String(action.text ?? "").length} characters)` });
}

// Exploration never follows links or clicks buttons that could end the session, delete, buy or send something.
const UNSAFE_LINK = /log-?out|sign-?out|logoff|disconnect|delete|remove|destroy|unsubscribe|deactivate|cancel|checkout|payment|pay\b|purchase|order\/new|add-?to-?cart|cart\/add|\bbuy\b|vote|\blike\b|follow|approve|reject|archive|transfer|withdraw|\bsend\b|\.(pdf|zip|exe|dmg|msi|png|jpe?g|gif|svg|mp4|mp3|csv|xlsx?)(\?|$)/i;
const SAFE_BUTTON = /^\s*(load more|show more|see more|view more|more results|next|next page|voir plus|afficher plus|suivant|charger plus|mehr)\s*$/i;

/**
 * Follows same-site links (breadth first) and clicks harmless "load more" buttons and tabs, so that endpoints
 * the user did not think of are captured too. Returns how many API calls each visited page revealed.
 * @param {import("playwright-core").Page} page
 * @param {{ maxPages: number, allowed: (hostname: string) => boolean, count: () => number, timeoutMs: number, pageDelayMs: number, onProgress: (m: string) => void }} options
 */
async function explore(page, { maxPages, allowed, count, timeoutMs, pageDelayMs, onProgress }) {
  const visited = new Set([normalizePage(page.url())]);
  const queue = [];
  const report = [];
  const collectLinks = async () => {
    const links = await page.$$eval("a[href]", (anchors) => anchors.map((a) => /** @type {HTMLAnchorElement} */ (a).href)).catch(() => []);
    for (const link of links) {
      let url;
      try {
        url = new URL(link);
      } catch {
        continue;
      }
      const key = normalizePage(url.toString());
      if (!/^https?:$/.test(url.protocol) || !allowed(url.hostname) || UNSAFE_LINK.test(url.pathname + url.search) || visited.has(key) || queue.some((q) => q.key === key)) continue;
      queue.push({ key, url: url.toString() });
    }
  };
  const clickSafeControls = async () => {
    const before = count();
    const controls = page.locator('[role="tab"], button, [role="button"]');
    const total = Math.min(await controls.count().catch(() => 0), 60);
    let clicks = 0;
    for (let i = 0; i < total && clicks < 4; i++) {
      const control = controls.nth(i);
      const text = (await control.innerText({ timeout: 500 }).catch(() => "")).trim();
      const isTab = (await control.getAttribute("role", { timeout: 500 }).catch(() => null)) === "tab";
      if (!(isTab || SAFE_BUTTON.test(text)) || text.length > 40) continue;
      if (!(await control.isVisible().catch(() => false))) continue;
      await control.click({ timeout: 3000 }).catch(() => {});
      clicks++;
      await settle(page, 3000);
    }
    return count() - before;
  };

  await collectLinks();
  report.push({ url: page.url(), newCalls: await clickSafeControls() });
  while (queue.length && report.length < maxPages + 1) {
    const next = /** @type {{ key: string, url: string }} */ (queue.shift());
    visited.add(next.key);
    const before = count();
    onProgress(`Exploring ${next.url} (${report.length}/${maxPages})`);
    if (pageDelayMs) await page.waitForTimeout(pageDelayMs); // each page load sends many requests: stay well under the rate limit
    try {
      await page.goto(next.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    } catch {
      continue;
    }
    await settle(page, 6000);
    await page.mouse.wheel(0, 2500).catch(() => {});
    await settle(page, 2000);
    await clickSafeControls();
    await collectLinks();
    report.push({ url: page.url(), newCalls: count() - before });
  }
  return report;
}

/** Page identity for exploration: same path and query keys, ignoring values and fragments. @param {string} address */
function normalizePage(address) {
  try {
    const url = new URL(address);
    return `${url.origin}${url.pathname.replace(/\/\d+(?=\/|$)/g, "/:id")}?${[...url.searchParams.keys()].sort().join("&")}`;
  } catch {
    return address;
  }
}

/** @param {import("playwright-core").Page} page */
async function settle(page, timeout = 8000) {
  await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
  await page.waitForTimeout(500);
}

/**
 * @param {import("../config.js").Config} config
 * @param {{ url: string, profileDir: string, actions?: Action[], interactive?: boolean, durationSeconds?: number, hosts?: string[], explorePages?: number, onProgress?: (message: string) => void }} options
 */
export async function captureTraffic(config, { url, profileDir, actions = [], interactive = false, durationSeconds, hosts = [], explorePages = 0, onProgress = () => {} }) {
  const siteDomain = registrableDomain(new URL(url).hostname);
  const extraHosts = hosts.map((h) => h.toLowerCase());
  const allowed = (hostname) =>
    !isTracker(hostname) && (registrableDomain(hostname) === siteDomain || extraHosts.some((h) => hostname === h || hostname.endsWith(`.${h}`)));

  /** @type {import("./infer.js").Observation[]} */ const observations = [];
  /** @type {Promise<void>[]} */ const pending = [];
  const pageUrls = [url];
  const typedTexts = [];
  /** Text typed into password fields: removed from the recipe wherever it appears (a body field named "pw" is not recognised otherwise). */
  const typedSecrets = [];
  const actionErrors = [];
  /** @type {{ url: string, newCalls: number }[]} */ let explored = [];
  /** @type {string | null} */ let blocked = null;
  /** @type {string[]} */ const actionNotes = [];
  /** @type {import("./pages.js").PageDocument[]} */ const documents = [];
  let fieldsListed = false;

  // Responses keep arriving while earlier ones are read: wait until no new one was added.
  const drain = async () => {
    for (let count = -1; count !== pending.length; ) {
      count = pending.length;
      await Promise.allSettled(pending.slice());
    }
  };

  const context = await launchProfile(config, profileDir, { headless: !interactive });
  const realtime = attachRealtimeCapture(context, allowed);
  await realtime.ready();
  let closedByUser = false;
  context.on("close", () => (closedByUser = true));
  context.on("response", (response) => {
    const request = response.request();
    if (request.resourceType() === "document") {
      // A classic HTML form posted by the page (server-rendered tools): an endpoint like any API call, answered by a page.
      if (request.method() === "POST" && response.status() < 400) {
        let target;
        try {
          target = new URL(request.url());
        } catch {
          return;
        }
        // The sign-in form is not a tool: the browser profile keeps the session, and its password is never replayed.
        if (!allowed(target.hostname) || isSignInPath(target.pathname)) return;
        pending.push(
          (async () => {
            observations.push({
              method: "POST", url: request.url(), status: response.status(),
              requestHeaders: await request.allHeaders().catch(() => request.headers()), requestBody: request.postData(), responseJson: undefined,
            });
          })().catch(() => {}),
        );
        return;
      }
      // Pages whose HTML carries the data (server-rendered tools) become page tools.
      if (request.method() !== "GET" || response.status() !== 200 || request.frame().parentFrame() || documents.length >= 60) return;
      if (!/html/i.test(response.headers()["content-type"] ?? "")) return;
      let host;
      try {
        host = new URL(response.url()).hostname;
      } catch {
        return;
      }
      if (!allowed(host)) return;
      pending.push(
        (async () => {
          const html = (await response.body()).subarray(0, MAX_BODY_BYTES).toString("utf8");
          documents.push({ url: response.url(), textLength: htmlToText(html).length, tables: (html.match(/<table\b/gi) ?? []).length });
        })().catch(() => {}),
      );
      return;
    }
    if (!["xhr", "fetch"].includes(request.resourceType())) return;
    let hostname;
    try {
      hostname = new URL(request.url()).hostname;
    } catch {
      return;
    }
    if (!allowed(hostname)) return;
    pending.push(
      (async () => {
        const contentType = response.headers()["content-type"] ?? "";
        const isJson = /json/i.test(contentType);
        // Many APIs answer JSON as text/plain or text/javascript, or behind a ")]}'" prefix: look at the body of those too.
        const maybeJson = isJson || contentType === "" || /^text\/(plain|javascript)|^application\/(javascript|x-javascript)/i.test(contentType);
        if (!maybeJson && (request.method() === "GET" || response.status() >= 400)) return;
        let responseJson;
        if (maybeJson) {
          try {
            const body = await response.body();
            if (body.length <= MAX_BODY_BYTES) responseJson = parseJsonLoose(body.toString("utf8"));
          } catch {
            return; // body unavailable (navigation, redirect)
          }
          if (responseJson === undefined && (isJson ? true : request.method() === "GET")) return; // not JSON after all
        }
        observations.push({
          method: request.method(),
          url: request.url(),
          status: response.status(),
          requestHeaders: await request.allHeaders().catch(() => request.headers()),
          requestBody: request.postData(),
          responseJson,
        });
      })().catch(() => {}),
    );
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) pageUrls.push(frame.url());
    });
    onProgress(`Loading ${url}`);
    let documentStatus = 0;
    try {
      documentStatus = (await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.requestTimeoutMs * 2 }))?.status() ?? 0;
    } catch (error) {
      if (error?.name !== "TimeoutError") throw error;
      actionErrors.push(`initial load of ${url} timed out; continuing with what was captured`);
    }
    await settle(page, 10_000);
    blocked = await botWall(page, documentStatus);
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 2500);
      await page.waitForTimeout(400);
    }
    await settle(page, 3000);

    for (const [index, action] of actions.entries()) {
      onProgress(`Action ${index + 1}/${actions.length}: ${describeAction(action)}`);
      try {
        if (action.goto) await page.goto(new URL(action.goto, page.url()).toString(), { waitUntil: "domcontentloaded", timeout: config.requestTimeoutMs * 2 });
        else if (action.click) await page.click(await resolveTarget(page, action.click, "click", index, actionNotes), { timeout: 10_000 });
        else if (action.fill) {
          const target = await resolveTarget(page, action.fill, "fill", index, actionNotes);
          const secretField = await page
            .locator(target)
            .first()
            .evaluate((/** @type {any} */ el) => el.type === "password" || /pass|pwd|secret|token|otp|cvv|cvc/i.test(`${el.name ?? ""} ${el.id ?? ""} ${el.autocomplete ?? ""}`), null, { timeout: 2000 })
            .catch(() => false);
          if ((secretField || /pass|pwd|secret|token|otp|cvv|cvc/i.test(action.fill)) && action.text) typedSecrets.push(action.text);
          await page.fill(target, action.text ?? "", { timeout: 10_000 });
          if (!typedSecrets.includes(action.text ?? "")) typedTexts.push(action.text ?? "");
        } else if (action.press) await page.keyboard.press(action.press);
        else if (action.wait) await page.waitForTimeout(Math.min(action.wait, 60_000));
        else if (action.scroll) await page.mouse.wheel(0, action.scroll);
        else if (action.waitFor) await page.waitForSelector(action.waitFor, { timeout: 15_000 });
      } catch (error) {
        actionErrors.push(`actions[${index}] ${describeAction(action)}: ${String(error.message).split("\n")[0]}`);
        // Tell the agent what the page really has, so it can retry with the right selectors.
        if (!fieldsListed && (action.fill || action.click)) {
          fieldsListed = true;
          const fields = await pageFields(page);
          if (fields) actionErrors.push(`fields on ${page.url()}: ${fields}`);
        }
      }
      await settle(page);
    }
    actionErrors.push(...actionNotes);

    if (explorePages > 0) {
      onProgress(`Exploring up to ${explorePages} pages of the site`);
      const pageDelayMs = config.rateLimit > 0 ? Math.min(Math.round(5000 / config.rateLimit), 10_000) : 0;
      explored = await explore(page, { maxPages: Math.min(explorePages, 100), allowed, count: () => observations.length, timeoutMs: config.requestTimeoutMs, pageDelayMs, onProgress });
    }

    if (interactive) {
      const seconds = Math.min(durationSeconds ?? 120, 1800);
      onProgress(`Interactive capture: browse the site, then close the window (or wait ${seconds}s).`);
      // The user may close the window at any time: keep the cookies saved while they browse.
      const saver = setInterval(() => saveCookies(context, profileDir), 2000);
      await Promise.race([new Promise((resolve) => context.once("close", resolve)), new Promise((resolve) => setTimeout(resolve, seconds * 1000))]);
      clearInterval(saver);
    }
  } finally {
    await drain();
    if (!closedByUser) await closeProfile(context, profileDir);
  }
  await drain();
  return { observations, streams: realtime.streams, pageUrls, typedTexts, typedSecrets, actionErrors, explored, blocked, documents };
}

// Pages that bot protections show instead of the site (Cloudflare, DataDome, Akamai, PerimeterX, Reddit...).
const BOT_WALL = /just a moment|attention required|access denied|verify (that )?you are (a )?human|are you a robot|you have been blocked|blocked by network security|captcha-delivery|datadome|px-captcha|cf-chl|unusual traffic|request unsuccessful|pardon our interruption|client challenge|captcha|prove your humanity|let us know you.re a real person|checking (if the site connection is secure|your browser)|vérifi(cation|ez) que vous êtes (un )?humain/i;

/**
 * Finds a bot protection page shown instead of the site. Never tries to get past it.
 * @param {import("playwright-core").Page} page @param {number} status HTTP status of the page itself (0 if unknown)
 * @returns {Promise<string | null>} what gave it away (status, marker), or null when the page looks normal
 */
export async function botWallSign(page, status) {
  const probe = await page
    .evaluate(() => ({ title: document.title, text: (document.body?.innerText ?? "").slice(0, 2000), html: document.documentElement.outerHTML.slice(0, 20000) }))
    .catch(() => ({ title: "", text: "", html: "" }));
  // A protection script in the HTML of a page that loaded normally is not a block: only the visible text counts then.
  const visible = BOT_WALL.exec(`${probe.title}\n${probe.text}`)?.[0];
  const marker = visible ?? (status >= 400 ? BOT_WALL.exec(probe.html)?.[0] : undefined);
  if ([403, 429].includes(status) || (marker && (status >= 400 || probe.text.length < 1500))) {
    return [status ? `HTTP ${status}` : "", marker ? `"${marker}"` : ""].filter(Boolean).join(", ");
  }
  return null;
}

/**
 * Tells whether the site answered with a bot protection page instead of its content, with what to do instead.
 * @param {import("playwright-core").Page} page @param {number} status HTTP status of the page itself
 * @returns {Promise<string | null>} reason, or null when the page looks normal
 */
export async function botWall(page, status) {
  const sign = await botWallSign(page, status);
  return sign
    ? `the site refused the automated browser (${sign}): it uses a bot protection, which unwalled does not bypass. Use interactive=true and browse in the visible window yourself, or import a HAR saved from your own browser (discover_har).`
    : null;
}

/**
 * Selector for a fill or click. The given one when it matches a visible element; otherwise, for the sign-in fields an
 * agent has to guess without seeing the page (user name, password, submit button), the page's own field of that kind.
 * @param {import("playwright-core").Page} page @param {string} selector @param {"fill" | "click"} kind
 * @param {number} index @param {string[]} notes where a substitution is reported
 */
export async function resolveTarget(page, selector, kind, index, notes) {
  const visible = async (/** @type {string} */ css) => {
    try {
      return await page.locator(css).first().isVisible();
    } catch {
      return false; // invalid selector
    }
  };
  if (await visible(selector)) return selector;
  const hint = selector.toLowerCase();
  /** @type {string[]} */ let candidates = [];
  if (kind === "fill" && /pass|pwd|mot.?de.?passe/.test(hint)) candidates = ["input[type=password] >> visible=true"];
  else if (kind === "fill" && /user|login|e-?mail|name|account|ident|courriel/.test(hint))
    candidates = ["form:has(input[type=password]) input:is([type=email], [type=text], :not([type])) >> visible=true", "input:is([type=email], [type=text], :not([type])) >> visible=true"];
  else if (kind === "click" && /submit|sign|log|connect|button|btn/.test(hint))
    candidates = ["form:has(input[type=password]) :is(button[type=submit], input[type=submit], button:not([type])) >> visible=true", ":is(button[type=submit], input[type=submit]) >> visible=true"];
  for (const candidate of candidates) {
    if (await visible(candidate)) {
      const label = await page
        .locator(candidate)
        .first()
        .evaluate((el) => (el.id ? `#${el.id}` : el.getAttribute("name") ? `[name=${el.getAttribute("name")}]` : el.tagName.toLowerCase()))
        .catch(() => "a field");
      notes.push(`actions[${index}]: "${selector}" is not on the page; used the page's ${kind === "click" ? "submit button" : /pass|pwd|mot.?de.?passe/.test(hint) ? "password field" : "user field"} (${label}) instead`);
      return candidate;
    }
  }
  return selector;
}

/** Visible form fields and buttons of the page, with a selector for each. @param {import("playwright-core").Page} page */
async function pageFields(page) {
  return page
    .evaluate(() => {
      const out = [];
      for (const el of /** @type {any[]} */ ([...document.querySelectorAll("input, textarea, select, button, [role=button]")])) {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height || el.type === "hidden") continue;
        const tag = el.tagName.toLowerCase();
        const css = el.id ? `#${CSS.escape(el.id)}` : el.name ? `${tag}[name="${el.name}"]` : el.type === "submit" ? `${tag}[type=submit]` : null;
        const label = (el.labels?.[0]?.innerText || el.getAttribute("aria-label") || el.placeholder || el.innerText || el.value || "").trim().slice(0, 30);
        if (css) out.push(`${css} (${tag === "button" ? "button" : el.type || tag}${label ? ` "${label}"` : ""})`);
        if (out.length >= 15) break;
      }
      return out.join(", ");
    })
    .catch(() => "");
}
