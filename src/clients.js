// MCP clients installed on this computer, and adding unwalled to (or removing it from) their configuration.
// JSON configuration files are edited only when they parse: a file with comments is left untouched and the entry to
// paste is shown instead. A backup of every file is written next to it before the first change.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** What npx installs. Switch to "unwalled" once the package is published on npm. */
export const PACKAGE_SPEC = "github:KorroAi/unwalled";
export const SERVER_NAME = "unwalled";
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "unwalled.js");

/**
 * @typedef {object} ClientEnv where to look: injected by tests
 * @property {string} home
 * @property {NodeJS.Platform} platform
 * @property {string} appData Windows %APPDATA%
 * @property {string} localAppData Windows %LOCALAPPDATA%
 * @property {(args: string[]) => { status: number | null, stdout: string, stderr: string, missing?: boolean }} claude runs the Claude Code command
 */

/** @returns {ClientEnv} */
export function systemEnv() {
  const home = homedir();
  return {
    home,
    platform: process.platform,
    appData: process.env.APPDATA ?? join(home, "AppData", "Roaming"),
    localAppData: process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
    claude: runClaude,
  };
}

/** @param {string[]} args */
function runClaude(args) {
  // On Windows, npm installs "claude" as a .cmd script, which only a shell starts: arguments are quoted for cmd.
  const windows = process.platform === "win32";
  const quote = (/** @type {string} */ a) => (/^[\w./:=@\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
  for (const [command, shell] of windows ? [["claude", false], ["claude", true]] : [["claude", false]]) {
    const result = spawnSync(/** @type {string} */ (command), shell ? args.map(quote) : args, { encoding: "utf8", shell: /** @type {boolean} */ (shell), windowsHide: true, timeout: 60_000 });
    if (result.error && /ENOENT/.test(String(result.error.message))) continue;
    if (shell && result.status !== 0 && /not recognized|introuvable/i.test(result.stderr ?? "")) continue;
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error?.message ?? "") };
  }
  return { status: null, stdout: "", stderr: "", missing: true };
}

/**
 * The command MCP clients run to start unwalled.
 * @param {{ platform?: NodeJS.Platform, binPath?: string, execPath?: string }} [options]
 * @returns {{ command: string, args: string[] }}
 */
export function launchCommand({ platform = process.platform, binPath = BIN, execPath = process.execPath } = {}) {
  // Started by npx: its cache folder can be pruned, so clients start unwalled through npx as well.
  if (/[\\/]_npx[\\/]/.test(binPath)) {
    if (platform === "win32") return { command: "cmd", args: ["/c", "npx", "-y", PACKAGE_SPEC] };
    // The full path: apps started from the desktop (Claude Desktop on macOS) do not see the shell's PATH.
    const npx = join(dirname(execPath), "npx");
    return { command: existsSync(npx) ? npx : "npx", args: ["-y", PACKAGE_SPEC] };
  }
  // Installed or cloned: Node and the script by their full paths, which work whatever the client's PATH.
  return { command: execPath, args: [binPath] };
}

/** Whether this copy runs from npx's cache (started with "npx github:..."), not from an installation. */
export const runsFromNpx = () => /[\\/]_npx[\\/]/.test(BIN);

/**
 * Installs the "unwalled" command for the current user (npm install --global) and returns its script, or null.
 * @returns {string | null}
 */
export function installGlobally() {
  const windows = process.platform === "win32";
  // npm is a .cmd script on Windows: only a shell starts it.
  const npm = (/** @type {string[]} */ args, /** @type {any} */ options = {}) => spawnSync(windows ? "npm.cmd" : "npm", args, { shell: windows, windowsHide: true, ...options });
  const installed = npm(["install", "--global", PACKAGE_SPEC], { stdio: "inherit" });
  if (installed.status !== 0) return null;
  const root = String(npm(["root", "--global"], { encoding: "utf8" }).stdout ?? "").trim();
  const bin = join(root, "unwalled", "bin", "unwalled.js");
  return root && existsSync(bin) ? bin : null;
}

/**
 * @typedef {object} Client
 * @property {string} id
 * @property {string} label
 * @property {"claude-cli" | "json" | "toml"} kind
 * @property {string} [file] configuration file (json and toml)
 * @property {string} [key] JSON object holding the servers
 * @property {boolean} installed
 * @property {string} [restart] what the user must do for the client to load the change
 */

/** Claude Desktop's configuration file (the Microsoft Store version keeps it in its package folder). @param {ClientEnv} env */
function claudeDesktopFile(env) {
  if (env.platform === "darwin") return join(env.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (env.platform !== "win32") return join(env.home, ".config", "Claude", "claude_desktop_config.json");
  const classic = join(env.appData, "Claude");
  if (existsSync(classic)) return join(classic, "claude_desktop_config.json");
  try {
    const packages = join(env.localAppData, "Packages");
    const store = readdirSync(packages).find((d) => /^(AnthropicPBC\.)?Claude_/i.test(d));
    if (store) return join(packages, store, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json");
  } catch {}
  return join(classic, "claude_desktop_config.json");
}

/** @param {ClientEnv} env @returns {Client[]} */
export function knownClients(env) {
  const userConfig = env.platform === "win32" ? env.appData : env.platform === "darwin" ? join(env.home, "Library", "Application Support") : join(env.home, ".config");
  const desktop = claudeDesktopFile(env);
  const vscode = join(userConfig, "Code", "User");
  return [
    { id: "claude-code", label: "Claude Code", kind: "claude-cli", installed: existsSync(join(env.home, ".claude.json")) || existsSync(join(env.home, ".claude")), restart: "Start a new Claude Code session." },
    { id: "claude-desktop", label: "Claude Desktop", kind: "json", key: "mcpServers", file: desktop, installed: existsSync(dirname(desktop)), restart: "Quit Claude Desktop completely and open it again." },
    { id: "cursor", label: "Cursor", kind: "json", key: "mcpServers", file: join(env.home, ".cursor", "mcp.json"), installed: existsSync(join(env.home, ".cursor")), restart: "Cursor loads it by itself (Settings → MCP shows it)." },
    { id: "windsurf", label: "Windsurf", kind: "json", key: "mcpServers", file: join(env.home, ".codeium", "windsurf", "mcp_config.json"), installed: existsSync(join(env.home, ".codeium", "windsurf")), restart: "Refresh the MCP servers in Windsurf's Cascade panel." },
    { id: "vscode", label: "VS Code", kind: "json", key: "servers", file: join(vscode, "mcp.json"), installed: existsSync(vscode), restart: "In VS Code, run \"MCP: List Servers\" and start unwalled (Copilot agent mode uses it)." },
    { id: "gemini", label: "Gemini CLI", kind: "json", key: "mcpServers", file: join(env.home, ".gemini", "settings.json"), installed: existsSync(join(env.home, ".gemini")), restart: "Start a new Gemini CLI session." },
    { id: "codex", label: "Codex CLI", kind: "toml", file: join(env.home, ".codex", "config.toml"), installed: existsSync(join(env.home, ".codex")), restart: "Start a new Codex session." },
  ];
}

/** @param {string} file @returns {{ data: Record<string, any> } | { error: string }} */
function readJsonConfig(file) {
  if (!existsSync(file)) return { data: {} };
  const text = readFileSync(file, "utf8").replace(/^﻿/, "");
  if (!text.trim()) return { data: {} };
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "it does not hold a JSON object" };
    return { data };
  } catch {
    return { error: "it is not plain JSON (comments or a syntax error)" };
  }
}

/** @param {string} file @param {string} content */
function writeWithBackup(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && !existsSync(`${file}.unwalled-backup`)) copyFileSync(file, `${file}.unwalled-backup`);
  writeFileSync(file, content);
}

/** The entry of one client, as JSON (VS Code also wants the transport). @param {Client} client @param {{ command: string, args: string[] }} launch */
export function clientEntry(client, launch) {
  return client.id === "vscode" ? { type: "stdio", ...launch } : { ...launch };
}

const TOML_HEADER = new RegExp(`^\\[mcp_servers\\.(?:${SERVER_NAME}|"${SERVER_NAME}")\\]\\s*$`, "m");

/** @param {string} text TOML without unwalled's table */
function withoutTomlTable(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => TOML_HEADER.test(l));
  if (start === -1) return text;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Whether a client already starts unwalled.
 * @param {Client} client @param {ClientEnv} env @returns {"configured" | "absent" | "unknown"}
 */
export function clientStatus(client, env) {
  if (client.kind === "claude-cli") {
    const result = env.claude(["mcp", "get", SERVER_NAME]);
    if (result.missing) return "unknown";
    return result.status === 0 ? "configured" : "absent";
  }
  const file = /** @type {string} */ (client.file);
  if (client.kind === "toml") return existsSync(file) && TOML_HEADER.test(readFileSync(file, "utf8")) ? "configured" : "absent";
  const read = readJsonConfig(file);
  if ("error" in read) return "unknown";
  return read.data[/** @type {string} */ (client.key)]?.[SERVER_NAME] ? "configured" : "absent";
}

/**
 * Adds unwalled to a client (replacing an earlier entry).
 * @param {Client} client @param {ClientEnv} env @param {{ command: string, args: string[] }} launch
 * @returns {{ ok: boolean, message: string }}
 */
export function addToClient(client, env, launch) {
  if (client.kind === "claude-cli") {
    env.claude(["mcp", "remove", "--scope", "user", SERVER_NAME]);
    const result = env.claude(["mcp", "add", "--scope", "user", SERVER_NAME, "--", launch.command, ...launch.args]);
    if (result.missing) return { ok: false, message: `the "claude" command was not found. Run: claude mcp add --scope user ${SERVER_NAME} -- ${[launch.command, ...launch.args].map(shellQuote).join(" ")}` };
    return result.status === 0 ? { ok: true, message: "added (user scope: every project)" } : { ok: false, message: (result.stderr || result.stdout).trim().split("\n")[0] || "claude mcp add failed" };
  }
  const file = /** @type {string} */ (client.file);
  if (client.kind === "toml") {
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    const table = `[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(launch.command)}\nargs = [${launch.args.map((a) => JSON.stringify(a)).join(", ")}]\n`;
    const kept = withoutTomlTable(before).replace(/\s*$/, "");
    writeWithBackup(file, `${kept ? `${kept}\n\n` : ""}${table}`);
    return { ok: true, message: `added to ${file}` };
  }
  const read = readJsonConfig(file);
  if ("error" in read) {
    const snippet = JSON.stringify({ [/** @type {string} */ (client.key)]: { [SERVER_NAME]: clientEntry(client, launch) } }, null, 2);
    return { ok: false, message: `${file} was left untouched because ${read.error}. Add this to it:\n${snippet}` };
  }
  const key = /** @type {string} */ (client.key);
  const servers = read.data[key] && typeof read.data[key] === "object" ? read.data[key] : {};
  read.data[key] = { ...servers, [SERVER_NAME]: clientEntry(client, launch) };
  writeWithBackup(file, `${JSON.stringify(read.data, null, 2)}\n`);
  return { ok: true, message: `added to ${file}` };
}

/** @param {Client} client @param {ClientEnv} env @returns {{ ok: boolean, message: string }} */
export function removeFromClient(client, env) {
  if (client.kind === "claude-cli") {
    const result = env.claude(["mcp", "remove", "--scope", "user", SERVER_NAME]);
    if (result.missing) return { ok: false, message: 'the "claude" command was not found' };
    return result.status === 0 ? { ok: true, message: "removed" } : { ok: false, message: "not configured" };
  }
  const file = /** @type {string} */ (client.file);
  if (!existsSync(file)) return { ok: false, message: "not configured" };
  if (client.kind === "toml") {
    const before = readFileSync(file, "utf8");
    if (!TOML_HEADER.test(before)) return { ok: false, message: "not configured" };
    writeWithBackup(file, `${withoutTomlTable(before).replace(/\s*$/, "")}\n`);
    return { ok: true, message: `removed from ${file}` };
  }
  const read = readJsonConfig(file);
  const key = /** @type {string} */ (client.key);
  if ("error" in read) return { ok: false, message: `${file} was left untouched because ${read.error}: remove "${SERVER_NAME}" from it by hand` };
  if (!read.data[key]?.[SERVER_NAME]) return { ok: false, message: "not configured" };
  delete read.data[key][SERVER_NAME];
  writeWithBackup(file, `${JSON.stringify(read.data, null, 2)}\n`);
  return { ok: true, message: `removed from ${file}` };
}

/** @param {string} arg */
const shellQuote = (arg) => (/^[\w./:=@\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);

/** The JSON most MCP clients accept, for clients unwalled does not know. @param {{ command: string, args: string[] }} launch */
export function genericSnippet(launch) {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: launch } }, null, 2);
}
