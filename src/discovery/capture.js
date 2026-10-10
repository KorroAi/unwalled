// Records the API traffic of a real browser while it loads a page and replays scripted actions
// (or while the user browses in interactive mode).
import { closeProfile, launchProfile, saveCookies } from "../browser.js";
import { attachRealtimeCapture } from "../realtime/capture.js";
import { isTracker, registrableDomain } from "./infer.js";

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

/** @param {import("playwright-core").Page} page */
async function settle(page, timeout = 8000) {
  await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
  await page.waitForTimeout(500);
}

/**
 * @param {import("../config.js").Config} config
 * @param {{ url: string, profileDir: string, actions?: Action[], interactive?: boolean, durationSeconds?: number, hosts?: string[], onProgress?: (message: string) => void }} options
 */
export async function captureTraffic(config, { url, profileDir, actions = [], interactive = false, durationSeconds, hosts = [], onProgress = () => {} }) {
  const siteDomain = registrableDomain(new URL(url).hostname);
  const extraHosts = hosts.map((h) => h.toLowerCase());
  const allowed = (hostname) =>
    !isTracker(hostname) && (registrableDomain(hostname) === siteDomain || extraHosts.some((h) => hostname === h || hostname.endsWith(`.${h}`)));

  /** @type {import("./infer.js").Observation[]} */ const observations = [];
  /** @type {Promise<void>[]} */ const pending = [];
  const pageUrls = [url];
  const typedTexts = [];
  const actionErrors = [];

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
      onProgress(`Action ${index + 1}/${actions.length}: ${JSON.stringify(action)}`);
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
        actionErrors.push(`actions[${index}] ${JSON.stringify(action)}: ${String(error.message).split("\n")[0]}`);
      }
      await settle(page);
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
  return { observations, streams: realtime.streams, pageUrls, typedTexts, actionErrors };
}
