// Saved session cookies are credentials: encrypted at rest like the other secrets.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { encryptCookiesWith, saveCookies, savedCookieFingerprint } from "../../src/browser.js";
import { isEncrypted } from "../../src/crypto.js";

const dir = mkdtempSync(join(tmpdir(), "unwalled-cookies-"));
after(() => {
  encryptCookiesWith(null);
  rmSync(dir, { recursive: true, force: true });
});
const cookies = [{ name: "session", value: "s3cr3t-value", domain: ".crm.test", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }];
const context = /** @type {any} */ ({ cookies: async () => cookies });

describe("saved cookies", () => {
  it("are written encrypted and still read back", async () => {
    const key = Buffer.alloc(32, 7);
    encryptCookiesWith(() => key);
    await saveCookies(context, dir);
    const raw = readFileSync(join(dir, "unwalled-cookies.json"), "utf8");
    assert.equal(isEncrypted(JSON.parse(raw)), true);
    assert.doesNotMatch(raw, /s3cr3t-value/);
    assert.equal(savedCookieFingerprint(dir, "app.crm.test"), "session=s3cr3t-value");
  });

  it("from an older version, in clear text, are still read", () => {
    writeFileSync(join(dir, "unwalled-cookies.json"), JSON.stringify(cookies));
    assert.equal(savedCookieFingerprint(dir, "crm.test"), "session=s3cr3t-value");
  });

  it("are not written at all when the key is unavailable", async () => {
    const other = mkdtempSync(join(tmpdir(), "unwalled-cookies-nokey-"));
    encryptCookiesWith(() => {
      throw new Error("DPAPI unavailable");
    });
    await saveCookies(context, other);
    assert.equal(savedCookieFingerprint(other, "crm.test"), "");
    rmSync(other, { recursive: true, force: true });
  });
});
