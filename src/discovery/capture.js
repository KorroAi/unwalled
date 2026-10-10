// Records the API traffic of a real browser while it loads a page and replays scripted actions
// (or while the user browses in interactive mode).
import { closeProfile, launchProfile, saveCookies } from "../browser.js";
import { attachRealtimeCapture } from "../realtime/capture.js";
import { isTracker, registrableDomain } from "./infer.js";
import { looksSensitive } from "./secrets.js";

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

/** Action as shown in progress messages and warnings: text typed into a sensitive field is hidden. @param {Action} action */
export function describeAction(action) {
  if (action.fill === undefined) return JSON.stringify(action);
  const hidden = /pass|pwd|secret|token|otp|pin|code|card|cvv|cvc|key/i.test(action.fill) || looksSensitive(action.text);
  return JSON.stringify({ ...action, text: hidden ? "•••" : action.text });
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
  const actionErrors = [];
  /** @type {{ url: string, newCalls: number }[]} */ let explored = [];

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
        if (!isJson && (request.method() === "GET" || response.status() >= 400)) return;
        let responseJson;
        if (isJson) {
          try {
            const body = await response.body();
            if (body.length <= MAX_BODY_BYTES) responseJson = JSON.parse(body.toString("utf8"));
          } catch {
            return; // body unavailable (navigation, redirect) or invalid JSON
          }
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
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.requestTimeoutMs * 2 });
    } catch (error) {
      if (error?.name !== "TimeoutError") throw error;
      actionErrors.push(`initial load of ${url} timed out; continuing with what was captured`);
    }
    await settle(page, 10_000);
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 2500);
      await page.waitForTimeout(400);
    }
    await settle(page, 3000);

    for (const [index, action] of actions.entries()) {
      onProgress(`Action ${index + 1}/${actions.length}: ${describeAction(action)}`);
      try {
        if (action.goto) await page.goto(new URL(action.goto, page.url()).toString(), { waitUntil: "domcontentloaded", timeout: config.requestTimeoutMs * 2 });
        else if (action.click) await page.click(action.click, { timeout: 10_000 });
        else if (action.fill) {
          await page.fill(action.fill, action.text ?? "", { timeout: 10_000 });
          typedTexts.push(action.text ?? "");
        } else if (action.press) await page.keyboard.press(action.press);
        else if (action.wait) await page.waitForTimeout(Math.min(action.wait, 60_000));
        else if (action.scroll) await page.mouse.wheel(0, action.scroll);
        else if (action.waitFor) await page.waitForSelector(action.waitFor, { timeout: 15_000 });
      } catch (error) {
        actionErrors.push(`actions[${index}] ${describeAction(action)}: ${String(error.message).split("\n")[0]}`);
      }
      await settle(page);
    }

    if (explorePages > 0) {
      onProgress(`Exploring up to ${explorePages} pages of the site`);
      const pageDelayMs = config.rateLimit > 0 ? Math.min(Math.round(5000 / config.rateLimit), 10_000) : 0;
      explored = await explore(page, { maxPages: Math.min(explorePages, 100), allowed, count: () => pending.length, timeoutMs: config.requestTimeoutMs, pageDelayMs, onProgress });
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
  return { observations, streams: realtime.streams, pageUrls, typedTexts, actionErrors, explored };
}
