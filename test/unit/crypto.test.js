import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { decryptJson, encryptJson, isEncrypted, secretKey } from "../../src/crypto.js";
import { Store } from "../../src/store.js";

const homes = [];
const makeConfig = (overrides = {}) => {
  const home = mkdtempSync(join(tmpdir(), "umcp-crypto-"));
  homes.push(home);
  const config = { home, recipesDir: join(home, "recipes"), profilesDir: join(home, "profiles"), secretsDir: join(home, "secrets"), stateDir: join(home, "state"), encryptSecrets: true, ...overrides };
  for (const dir of [config.recipesDir, config.profilesDir, config.secretsDir, config.stateDir]) mkdirSync(dir, { recursive: true });
  return config;
};

describe("secrets encryption", () => {
  after(() => {
    delete process.env.UNIVERSAL_MCP_SECRET_KEY;
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  });

  it("round-trips with AES-256-GCM and detects tampering", () => {
    const key = Buffer.alloc(32, 7);
    const envelope = encryptJson({ "api.x.io": { authorization: "Bearer t" } }, key);
    assert.equal(isEncrypted(envelope), true);
    assert.ok(!JSON.stringify(envelope).includes("Bearer"));
    assert.deepEqual(decryptJson(envelope, key), { "api.x.io": { authorization: "Bearer t" } });
    const tampered = { ...envelope, data: Buffer.from("x".repeat(20)).toString("base64") };
    assert.throws(() => decryptJson(tampered, key));
    assert.throws(() => decryptJson(envelope, Buffer.alloc(32, 8)));
  });

  it("stores secrets encrypted with a passphrase, and migrates plaintext files", () => {
    process.env.UNIVERSAL_MCP_SECRET_KEY = "correct horse battery staple";
    const config = makeConfig();
    const store = new Store(/** @type {any} */ (config));
    store.saveSecrets("shop", { "shop.io": { cookie: "sid=s3cr3t" } });
    const raw = readFileSync(join(config.secretsDir, "shop.json"), "utf8");
    assert.ok(!raw.includes("s3cr3t") && isEncrypted(JSON.parse(raw)));
    assert.deepEqual(store.loadSecrets("shop"), { "shop.io": { cookie: "sid=s3cr3t" } });
    assert.match(secretKey(config.home).source, /passphrase/);

    writeFileSync(join(config.secretsDir, "old.json"), JSON.stringify({ "a.io": { "x-api-key": "legacy-key" } }));
    assert.deepEqual(store.loadSecrets("old"), { "a.io": { "x-api-key": "legacy-key" } });
    assert.ok(!readFileSync(join(config.secretsDir, "old.json"), "utf8").includes("legacy-key"), "plaintext file re-encrypted on read");
  });

  it("returns no secrets (instead of crashing) when the key is wrong", async () => {
    process.env.UNIVERSAL_MCP_SECRET_KEY = "one";
    const config = makeConfig();
    new Store(/** @type {any} */ (config)).saveSecrets("x", { "x.io": { cookie: "c" } });
    // A fresh process with another passphrase: emulate by encrypting with a different key.
    const other = encryptJson({ "x.io": { cookie: "c" } }, Buffer.alloc(32, 1));
    writeFileSync(join(config.secretsDir, "y.json"), JSON.stringify(other));
    assert.deepEqual(new Store(/** @type {any} */ (config)).loadSecrets("y"), {});
  });

  it("keeps plaintext when encryption is turned off", () => {
    const config = makeConfig({ encryptSecrets: false });
    new Store(/** @type {any} */ (config)).saveSecrets("p", { "p.io": { cookie: "visible" } });
    assert.match(readFileSync(join(config.secretsDir, "p.json"), "utf8"), /visible/);
  });

  it("uses DPAPI on Windows when no passphrase is set", { skip: process.platform !== "win32" && "Windows only" }, () => {
    delete process.env.UNIVERSAL_MCP_SECRET_KEY;
    const config = makeConfig();
    const first = secretKey(config.home);
    assert.match(first.source, /DPAPI/);
    assert.equal(first.key.length, 32);
    const raw = readFileSync(join(config.home, "secret.key.dpapi"), "utf8");
    assert.ok(raw.length > 100, "the stored key is the DPAPI blob, not the key itself");
    assert.notEqual(Buffer.from(raw, "base64").subarray(0, 32).toString("hex"), first.key.toString("hex"));
  });
});
