// Launches a persistent Chromium-based browser profile (cookies survive between runs).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { chromium } from "playwright-core";
import { decryptJson, encryptJson, isEncrypted } from "./crypto.js";

const COOKIE_FILE = "unwalled-cookies.json";
/** Name used before the rename to unwalled: still read when the new file does not exist yet. */
const LEGACY_COOKIE_FILE = "universal-mcp-cookies.json";

/** Key that encrypts the saved cookies (they are credentials), resolved when first needed; null keeps them in plain text. */
/** @type {(() => Buffer) | null} */ let cookieKey = null;

/** Encrypts saved cookies from now on with this key (the secrets' key). @param {(() => Buffer) | null} key */
export function encryptCookiesWith(key) {
  cookieKey = key;
}

/** Saved cookies of a profile: [] when there are none or they cannot be decrypted (the user signs in again). @param {string} file */
function readCookieFile(file) {
  const stored = JSON.parse(readFileSync(file, "utf8"));
  if (!isEncrypted(stored)) return Array.isArray(stored) ? stored : [];
  return cookieKey ? decryptJson(stored, cookieKey()) : [];
}

/**
 * Chrome drops session cookies (no expiry) when it closes, which would log the user out
 * between runs. They are saved next to the profile and restored at launch.
 * @param {import("playwright-core").BrowserContext} context @param {string} profileDir
 */
export async function saveCookies(context, profileDir) {
  let cookies;
  try {
    cookies = await context.cookies();
  } catch {
    return; // context already closed
  }
  const file = join(profileDir, COOKIE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  let content;
  try {
    content = JSON.stringify(cookieKey ? encryptJson(cookies, cookieKey()) : cookies);
  } catch {
    return; // no key available: cookies are not written in clear text instead (persistent ones stay in the browser profile)
  }
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

/**
 * Fingerprint of the saved cookies a host receives: tells whether a page load renewed the session (rotated cookies).
 * @param {string} profileDir @param {string} hostname
 */
export function savedCookieFingerprint(profileDir, hostname) {
  for (const name of [COOKIE_FILE, LEGACY_COOKIE_FILE]) {
    const file = join(profileDir, name);
    if (!existsSync(file)) continue;
    try {
      const cookies = /** @type {{ name: string, value: string, domain: string }[]} */ (readCookieFile(file));
      const matches = (/** @type {string} */ domain) => {
        const bare = domain.replace(/^\./, "");
        return hostname === bare || hostname.endsWith(`.${bare}`);
      };
      return cookies.filter((c) => matches(c.domain)).map((c) => `${c.name}=${c.value}`).sort().join("; ");
    } catch {
      return "";
    }
  }
  return "";
}

/** @param {import("playwright-core").BrowserContext} context @param {string} profileDir */
async function restoreCookies(context, profileDir) {
  let file = join(profileDir, COOKIE_FILE);
  if (!existsSync(file)) file = join(profileDir, LEGACY_COOKIE_FILE);
  if (!existsSync(file)) return;
  try {
    const now = Date.now() / 1000;
    const cookies = readCookieFile(file).filter((c) => c.expires === -1 || c.expires > now);
    if (cookies.length) await context.addCookies(cookies);
  } catch {
    // A corrupt cookie file only means the user has to log in again.
  }
}

/** Saves cookies, then closes. @param {import("playwright-core").BrowserContext} context @param {string} profileDir */
export async function closeProfile(context, profileDir) {
  await saveCookies(context, profileDir);
  await context.close().catch(() => {});
}

/** @param {string} browser */
function launchCandidates(browser) {
  if (isAbsolute(browser)) return [{ executablePath: browser }];
  if (browser === "chromium") return [{}];
  if (browser === "msedge") return [{ channel: "msedge" }, { channel: "chrome" }, {}];
  return [{ channel: "chrome" }, { channel: "msedge" }, {}];
}

const MISSING_BROWSER = /executable doesn't exist|is not found|not installed|no such file|distribution .* is not found|ENOENT/i;

/**
 * @param {import("./config.js").Config} config
 * @param {string} profileDir
 * @param {{ headless?: boolean }} [options]
 * @returns {Promise<import("playwright-core").BrowserContext>}
 */
export async function launchProfile(config, profileDir, { headless = true } = {}) {
  mkdirSync(profileDir, { recursive: true });
  const errors = [];
  for (const candidate of launchCandidates(config.browser)) {
    try {
      const context = await chromium.launchPersistentContext(profileDir, {
        ...candidate,
        headless,
        viewport: { width: 1280, height: 900 },
        acceptDownloads: false,
      });
      await restoreCookies(context, profileDir);
      return context;
    } catch (error) {
      const message = String(error?.message ?? error);
      if (/ProcessSingleton|already in use|user data directory/i.test(message)) {
        throw new Error(`The browser profile ${profileDir} is already open in another process. Close it and retry.`);
      }
      if (!MISSING_BROWSER.test(message)) throw error;
      errors.push(`${candidate.channel ?? candidate.executablePath ?? "bundled chromium"}: ${message.split("\n")[0]}`);
    }
  }
  throw new Error(
    `No usable browser found. Install Google Chrome or Microsoft Edge, or run "npx playwright-core install chromium" and set UNWALLED_BROWSER=chromium.\n${errors.join("\n")}`,
  );
}
