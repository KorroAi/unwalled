// Encryption at rest for stored secrets (AES-256-GCM).
// Key, in order of preference:
//   1. UNIVERSAL_MCP_SECRET_KEY (a passphrase, stretched with scrypt and a per-installation salt);
//   2. on Windows, a random key protected with DPAPI (only the same Windows user can unprotect it);
//   3. elsewhere, a random key in <home>/secret.key (mode 600): it keeps secrets out of backups and
//      shared recipe folders, but anyone who can read the home directory can read the key too.
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** @type {Map<string, { key: Buffer, source: string }>} */
const keys = new Map();

/** @param {string} script PowerShell script reading base64 from stdin and writing base64 to stdout @param {string} input */
function powershell(script, input) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input, encoding: "utf8", windowsHide: true, timeout: 20_000 }).trim();
}

const DPAPI = (/** @type {"Protect" | "Unprotect"} */ action) =>
  "Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); " +
  `$out = [System.Security.Cryptography.ProtectedData]::${action}([Convert]::FromBase64String($in), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
  "[Convert]::ToBase64String($out)";

/** @param {string} file @param {Buffer | string} data */
function writePrivate(file, data) {
  writeFileSync(file, data, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

/**
 * @param {string} home data directory
 * @returns {{ key: Buffer, source: string }}
 */
export function secretKey(home) {
  const cached = keys.get(home);
  if (cached) return cached;
  let result;
  const passphrase = process.env.UNIVERSAL_MCP_SECRET_KEY;
  if (passphrase) {
    const saltFile = join(home, "secret.salt");
    if (!existsSync(saltFile)) writePrivate(saltFile, randomBytes(16).toString("base64"));
    result = { key: scryptSync(passphrase, Buffer.from(readFileSync(saltFile, "utf8"), "base64"), 32), source: "passphrase (UNIVERSAL_MCP_SECRET_KEY)" };
  } else if (process.platform === "win32") {
    const file = join(home, "secret.key.dpapi");
    if (!existsSync(file)) writePrivate(file, powershell(DPAPI("Protect"), randomBytes(32).toString("base64")));
    result = { key: Buffer.from(powershell(DPAPI("Unprotect"), readFileSync(file, "utf8")), "base64"), source: "Windows DPAPI (current user)" };
  } else {
    const file = join(home, "secret.key");
    if (!existsSync(file)) writePrivate(file, randomBytes(32).toString("base64"));
    result = { key: Buffer.from(readFileSync(file, "utf8").trim(), "base64"), source: `key file ${file}` };
  }
  if (result.key.length !== 32) throw new Error(`Invalid secret key (${result.source}).`);
  keys.set(home, result);
  return result;
}

/** @param {unknown} value @param {Buffer} key */
export function encryptJson(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { v: 1, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

/** @param {any} envelope @param {Buffer} key */
export function decryptJson(envelope, key) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
}

/** @param {any} value */
export const isEncrypted = (value) => !!value && typeof value === "object" && value.alg === "aes-256-gcm" && typeof value.data === "string";
