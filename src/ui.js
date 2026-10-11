// Drives a site's user interface when there is no usable API (server-rendered pages, flows guarded by signatures):
// a compact snapshot of the interactive elements with stable refs (e1, e2...), actions addressed by ref or CSS selector,
// readable page text and screenshots.

import { botWallSign } from "./discovery/capture.js";

const MAX_ELEMENTS = 250;
// Clicking these may spend money, delete or send something: held for confirmation like destructive API calls.
export const RISKY_LABEL = /\b(delete|remove|destroy|erase|pay|buy|purchase|checkout|place order|order now|confirm|submit|send|transfer|unsubscribe|deactivate|close account|supprimer|effacer|payer|acheter|commander|valider|envoyer|confirmer|virement|résilier)\b/i;
const ACTION_KEYS = ["click", "fill", "select", "check", "uncheck", "press", "hover", "goto", "wait", "waitFor", "scroll"];

/**
 * Lists visible interactive elements and marks each one with a data-umcp ref attribute.
 * @param {import("playwright-core").Page} page @returns {Promise<string>}
 */
export async function snapshot(page) {
  const result = await page.evaluate((max) => {
    const SELECTOR = 'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=option], [role=combobox], [contenteditable=""], [contenteditable=true], [onclick]';
    let next = Number(document.documentElement.getAttribute("data-umcp-next") ?? 1);
    const lines = [];
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const label = (el) => {
      const text =
        el.getAttribute("aria-label") ||
        (el.labels && el.labels[0]?.innerText) ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.getAttribute("alt") ||
        el.innerText ||
        el.getAttribute("value") ||
        el.getAttribute("name") ||
        "";
      return text.replace(/\s+/g, " ").trim().slice(0, 80);
    };
    for (const node of document.querySelectorAll(SELECTOR)) {
      const el = /** @type {any} */ (node);
      if (lines.length >= max) break;
      if (!visible(el) || el.closest("[aria-hidden=true]")) continue;
      let ref = el.getAttribute("data-umcp");
      if (!ref) {
        ref = `e${next++}`;
        el.setAttribute("data-umcp", ref);
      }
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? `${el.type || "text"} input` : tag);
      let extra = "";
      if (tag === "a") extra = ` -> ${el.getAttribute("href")}`;
      if (tag === "input" || tag === "textarea") {
        const type = el.type;
        if (type === "checkbox" || type === "radio") extra = el.checked ? " [checked]" : " [unchecked]";
        else if (type !== "password") extra = ` value=${JSON.stringify(String(el.value).slice(0, 60))}`;
      }
      if (tag === "select") extra = ` options=${JSON.stringify([...el.options].slice(0, 15).map((o) => o.label))} selected=${JSON.stringify(el.selectedOptions[0]?.label ?? "")}`;
      if (el.disabled) extra += " [disabled]";
      lines.push(`[${ref}] ${role} ${JSON.stringify(label(el))}${extra}`);
    }
    document.documentElement.setAttribute("data-umcp-next", String(next));
    const headings = [...document.querySelectorAll("h1, h2")].slice(0, 8).map((/** @type {any} */ h) => h.innerText.replace(/\s+/g, " ").trim()).filter(Boolean);
    return { title: document.title, url: location.href, headings, lines };
  }, MAX_ELEMENTS);
  return [
    `Page: ${result.title} — ${result.url}`,
    await wallNotice(page),
    result.headings.length ? `Headings: ${result.headings.join(" | ")}` : "",
    `Interactive elements (${result.lines.length}${result.lines.length >= MAX_ELEMENTS ? ", truncated" : ""}):`,
    ...result.lines,
  ]
    .filter(Boolean)
    .join("\n");
}

/** @param {string} target ref (e12) or CSS selector */
const locatorFor = (target) => (/^e\d+$/.test(target) ? `[data-umcp="${target}"]` : target);

/** @param {unknown} steps */
export function validateUiSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error("steps must be a non-empty array");
  return steps.map((step, index) => {
    const keys = Object.keys(step ?? {}).filter((k) => ACTION_KEYS.includes(k));
    if (keys.length !== 1) throw new Error(`steps[${index}] must have exactly one of: ${ACTION_KEYS.join(", ")}`);
    if (keys[0] === "fill" && typeof step.text !== "string") throw new Error(`steps[${index}] (fill) needs a "text" string`);
    if (keys[0] === "select" && typeof step.value !== "string") throw new Error(`steps[${index}] (select) needs a "value" string`);
    return step;
  });
}

/**
 * Labels of the elements that risky steps would click (for confirmation).
 * @param {import("playwright-core").Page} page @param {any[]} steps
 */
export async function riskyTargets(page, steps) {
  const risky = [];
  for (const step of steps) {
    const target = step.click ?? step.check;
    if (!target) continue;
    const text = await page
      .locator(locatorFor(target))
      .first()
      .evaluate((/** @type {any} */ el) => `${el.getAttribute("aria-label") ?? ""} ${el.innerText ?? ""} ${el.getAttribute("value") ?? ""} ${el.getAttribute("title") ?? ""}`, null, { timeout: 2000 })
      .catch(() => "");
    if (RISKY_LABEL.test(text) || RISKY_LABEL.test(target)) risky.push(`${target} (${text.replace(/\s+/g, " ").trim().slice(0, 60) || "no label"})`);
  }
  return risky;
}

/**
 * Runs UI steps; stops at the first failure.
 * @param {import("playwright-core").Page} page @param {any[]} steps @param {{ timeoutMs: number }} options
 */
export async function act(page, steps, { timeoutMs }) {
  const done = [];
  for (const [index, step] of steps.entries()) {
    try {
      if (step.goto) await page.goto(new URL(step.goto, page.url()).toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
      else if (step.click) await page.locator(locatorFor(step.click)).first().click({ timeout: 10_000 });
      else if (step.fill) await page.locator(locatorFor(step.fill)).first().fill(step.text, { timeout: 10_000 });
      else if (step.select) await page.locator(locatorFor(step.select)).first().selectOption({ label: step.value }, { timeout: 10_000 }).catch(() => page.locator(locatorFor(step.select)).first().selectOption(step.value, { timeout: 10_000 }));
      else if (step.check) await page.locator(locatorFor(step.check)).first().check({ timeout: 10_000 });
      else if (step.uncheck) await page.locator(locatorFor(step.uncheck)).first().uncheck({ timeout: 10_000 });
      else if (step.hover) await page.locator(locatorFor(step.hover)).first().hover({ timeout: 10_000 });
      else if (step.press) await page.keyboard.press(step.press);
      else if (step.wait) await page.waitForTimeout(Math.min(Number(step.wait), 30_000));
      else if (step.waitFor) await page.waitForSelector(locatorFor(step.waitFor), { timeout: 15_000 });
      else if (step.scroll) await page.mouse.wheel(0, Number(step.scroll));
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
      done.push(`${index + 1}. ok ${JSON.stringify(step.fill ? { ...step, text: /pass|pwd|secret|token|otp|pin|cvv/i.test(step.fill) ? "•••" : step.text } : step)}`);
    } catch (error) {
      done.push(`${index + 1}. FAILED ${JSON.stringify(step)}: ${String(error.message).split("\n")[0]}`);
      return { ok: false, log: done.join("\n") };
    }
  }
  return { ok: true, log: done.join("\n") };
}

/**
 * Readable text of the page or of one element.
 * @param {import("playwright-core").Page} page @param {{ selector?: string, maxChars: number }} options
 */
export async function readText(page, { selector, maxChars }) {
  const text = await page.locator(selector ? locatorFor(selector) : "body").first().innerText({ timeout: 10_000 });
  const cleaned = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const header = [`Page: ${await page.title()} — ${page.url()}`, await wallNotice(page)].filter(Boolean).join("\n");
  return `${header}\n${cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}\n… [truncated: ${cleaned.length} characters]` : cleaned}`;
}

/** Warns when the page is a bot check (CAPTCHA, challenge) rather than the site. @param {import("playwright-core").Page} page */
async function wallNotice(page) {
  const sign = await botWallSign(page, 0);
  return sign
    ? `Blocked: this page is a bot check (${sign}), not the site. unwalled does not solve it: call ui with action=open, visible=true and let the user solve it in the window, then continue.`
    : "";
}
