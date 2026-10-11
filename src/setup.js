// First steps for people, in a terminal: checks of this computer (doctor), the setup wizard, "add" (any source with one
// command, its kind detected) and the demo back office.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { checkBrowser } from "./browser.js";
import { addToClient, clientStatus, genericSnippet, installGlobally, knownClients, launchCommand, removeFromClient, runsFromNpx, SERVER_NAME, systemEnv } from "./clients.js";
import { Engine } from "./core.js";
import { secretKey } from "./crypto.js";
import { PRESETS } from "./presets.js";
import { VERSION } from "./version.js";

// ---------------------------------------------------------------- sources

/** Addresses of data files (queried with SQL) rather than websites. */
const DATA_URL = /\.(csv|tsv|xlsx|ics|ical|rss|atom|jsonl|ndjson|sqlite|sqlite3|db)$/i;

/**
 * What to do with a source given in plain words: a website or API address, a preset, a database address, a file or a folder.
 * @param {string} source @param {{ cwd?: string }} [options]
 * @returns {{ action: "discover" | "import" | "curl", target: string }}
 */
export function classifySource(source, { cwd = process.cwd() } = {}) {
  const text = source.trim().replace(/^["']|["']$/g, "");
  if (/^preset:/i.test(text)) return { action: "discover", target: text };
  if (/^(postgres(ql)?|mysql|mariadb):\/\//i.test(text)) return { action: "import", target: text };
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    const csvExport = /^(csv|tsv)$/i.test(url.searchParams.get("format") ?? url.searchParams.get("output") ?? "");
    return DATA_URL.test(url.pathname) || csvExport ? { action: "import", target: text } : { action: "discover", target: text };
  }
  const local = resolve(cwd, text);
  if (existsSync(local)) {
    if (statSync(local).isFile() && /\.(txt|sh|curl)$/i.test(local) && /^\s*curl\s/m.test(readFileSync(local, "utf8").slice(0, 200_000))) return { action: "curl", target: local };
    return { action: "import", target: local };
  }
  // A website written without its scheme: "erp.example.com", "localhost:8080/app".
  if (/^([\w-]+\.)*[\w-]+(:\d+)?(\/\S*)?$/.test(text) && (text.includes(".") || /^localhost\b/i.test(text))) {
    const local = /^(localhost|127\.|10\.|192\.168\.|\d+\.\d+\.\d+\.\d+)/i.test(text);
    return { action: "discover", target: `${local ? "http" : "https"}://${text}` };
  }
  throw new Error(`"${source}" is not a web address, an existing file or folder, a database address (postgres://, mysql://) or a preset (preset:github).`);
}

const GENERIC_LABELS = new Set(["www", "app", "apps", "api", "portal", "my", "web", "admin", "intranet", "dashboard", "console"]);

/**
 * A recipe name for a source: "https://grafana.example.com" → "grafana", "./sales 2026.csv" → "sales-2026".
 * @param {string} source @param {Iterable<string>} [taken] names already used
 */
export function suggestName(source, taken = []) {
  const used = new Set(taken);
  const text = source.trim().replace(/^["']|["']$/g, "");
  let base = "";
  if (/^preset:/i.test(text)) base = text.slice(7).replace(/^google:/i, "").split("/")[0];
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[\w-]+(\.[\w-]+)+/.test(text)) {
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
      if (/^(postgres|postgresql|mysql|mariadb):$/i.test(url.protocol)) base = decodeURIComponent(url.pathname.replace(/^\//, "")) || url.hostname;
      else if (/^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(url.hostname)) base = `local${url.port ? `-${url.port}` : ""}`;
      else {
        const labels = url.hostname.toLowerCase().split(".").slice(0, -1);
        base = labels.find((l) => !GENERIC_LABELS.has(l)) ?? labels[0] ?? url.hostname;
      }
    } catch {
      base = text;
    }
  } else base = text.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.[^.]+$/, "") ?? text;
  let name = base.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(name)) name = `s-${name}`.replace(/-+$/, "");
  name = name.slice(0, 28).replace(/-+$/, "") || "source";
  let unique = name;
  for (let n = 2; used.has(unique); n++) unique = `${name}-${n}`;
  return unique;
}

/**
 * Creates (or updates) a recipe from any source.
 * @param {Engine} engine
 * @param {{ source: string, name: string, interactive?: boolean, durationSeconds?: number, explorePages?: number, merge?: boolean, baseUrl?: string }} options
 * @param {(message: string) => void} [onProgress]
 */
export async function addSource(engine, { source, name, interactive, durationSeconds, explorePages, merge, baseUrl }, onProgress = () => {}) {
  const { action, target } = classifySource(source);
  if (action === "discover") return engine.discover({ name, url: target, interactive, durationSeconds, explorePages: explorePages ?? 0, merge }, onProgress);
  if (action === "curl") return engine.importCurl({ name, commands: readFileSync(target, "utf8"), merge });
  onProgress(/^(postgres|mysql|mariadb)/i.test(target) ? "Connecting to the database (read-only)" : /^https?:/i.test(target) ? "Downloading the data" : "Reading the file");
  return engine.importFile({ name, path: target, merge, baseUrl });
}

/**
 * What a person needs to see after adding a source: the tools, in a few lines, and what to ask the agent.
 * @param {Engine} engine @param {any} recipe
 */
export function summarize(engine, recipe) {
  const tools = engine.toolsOf(recipe.name);
  const lines = [`✔ "${recipe.name}" is ready: ${tools.length} tool${tools.length === 1 ? "" : "s"} for your agent.`];
  for (const tool of tools.slice(0, 8)) {
    const summary = String(tool.description ?? "").replace(/^\[[^\]]+\]\s*/, "").split(/\. \[|\. (?=[A-Z])/)[0].slice(0, 90);
    lines.push(`    ${tool.name}${summary ? `  ${summary}` : ""}`);
  }
  if (tools.length > 8) lines.push(`    … and ${tools.length - 8} more (unwalled inspect ${recipe.name})`);
  const needed = keyNeeded(engine, recipe);
  if (needed) lines.push(`  ! This service needs a key or token for ${needed.host}: run "unwalled key ${recipe.name}".`);
  for (const warning of (recipe.warnings ?? []).filter((/** @type {string} */ w) => !String(w).startsWith("Credentials: ")).slice(0, 3)) lines.push(`  ! ${String(warning).slice(0, 220)}`);
  return lines.join("\n");
}

/** An example question for the agent, by kind of source. @param {any} recipe */
export function exampleQuestion(recipe) {
  if (recipe.name === "acme") return "Using acme, what is the status and total of order 1042? And which customers are in Lyon?";
  if (recipe.kind === "data") return `Using ${recipe.name}, what is in the largest table? Give me a short summary.`;
  return `Using the ${recipe.name} tools, <your question>.`;
}

// ---------------------------------------------------------------- terminal input and output

/**
 * @typedef {object} Io
 * @property {(question: string) => Promise<string>} ask
 * @property {(question: string) => Promise<string>} secret input not shown on screen
 * @property {(text?: string) => void} print
 * @property {() => void} close
 */

/**
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, terminal?: boolean }} [streams] for tests
 * @returns {Io}
 */
export function terminalIo({ input = process.stdin, output = process.stdout, terminal = !!(/** @type {any} */ (output).isTTY) } = {}) {
  // readline echoes what is typed through its output: while a secret is asked, that output shows stars instead.
  let muted = false;
  let prompt = "";
  const screen = new Writable({
    write(chunk, _encoding, done) {
      output.write(muted ? maskTyped(String(chunk), prompt) : chunk);
      done();
    },
  });
  Object.defineProperty(screen, "columns", { get: () => /** @type {any} */ (output).columns ?? 80 });
  const rl = createInterface({ input, output: screen, terminal });
  return {
    ask: async (question) => (await rl.question(question)).trim(),
    secret: async (question) => {
      muted = true;
      prompt = question;
      try {
        return (await rl.question(question)).trim();
      } finally {
        muted = false;
      }
    },
    print: (text = "") => void output.write(`${text}\n`),
    close: () => rl.close(),
  };
}

/**
 * Typed characters as stars; the prompt, line breaks and terminal control sequences stay as they are.
 * @param {string} text @param {string} prompt
 */
export function maskTyped(text, prompt) {
  return text
    .split(/(\x1b\[[0-9;?]*[A-Za-z]|\r?\n|\r)/)
    .map((part, index) => {
      if (index % 2 === 1 || !part) return part;
      if (prompt && part.startsWith(prompt)) return prompt + "*".repeat([...part.slice(prompt.length)].length);
      return "*".repeat([...part].length);
    })
    .join("");
}

/** Output only, for scripts (setup --yes without a terminal): every question takes its default answer. @returns {Io} */
export function plainIo() {
  return { ask: async () => "", secret: async () => "", print: (text = "") => process.stdout.write(`${text}\n`), close: () => {} };
}

/** @param {Io} io @param {string} question @param {boolean} [fallback] */
async function confirm(io, question, fallback = true) {
  const answer = (await io.ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  if (!answer) return fallback;
  return /^(y|yes|o|oui)$/.test(answer);
}

/** @param {Io} io @param {string} question @param {string} [fallback] */
async function askWithDefault(io, question, fallback = "") {
  const answer = await io.ask(`${question}${fallback ? ` [${fallback}]` : ""}: `);
  return answer || fallback;
}

// ---------------------------------------------------------------- doctor

/**
 * @typedef {{ status: "ok" | "warn" | "fail", label: string, fix?: string }} Check
 */

/**
 * Checks this computer: Node.js, browser, data folder, encryption of secrets, MCP clients.
 * @param {import("./config.js").Config} config
 * @param {{ env?: import("./clients.js").ClientEnv, browser?: boolean, clients?: boolean }} [options]
 * @returns {Promise<Check[]>}
 */
export async function runDoctor(config, { env = systemEnv(), browser = true, clients = true } = {}) {
  /** @type {Check[]} */ const checks = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(major >= 22 ? { status: "ok", label: `Node.js ${process.versions.node}` } : { status: "fail", label: `Node.js ${process.versions.node} is too old`, fix: "Install Node.js 22 or newer: https://nodejs.org" });
  try {
    await import("node:sqlite");
  } catch {
    checks.push({ status: "warn", label: "Local data and SQL are not available (no node:sqlite)", fix: "Use Node.js 22.5 or newer for CSV, Excel, JSON and SQLite sources." });
  }
  if (browser) {
    try {
      const found = await checkBrowser(config);
      checks.push({ status: "ok", label: `Browser: ${found.name} ${found.version}` });
    } catch (error) {
      checks.push({ status: "warn", label: "No browser found (needed for websites only)", fix: String(error?.message ?? error).split("\n")[0] });
    }
  }
  try {
    mkdirSync(config.home, { recursive: true });
    const probe = join(config.home, `.write-test-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    const recipes = existsSync(config.recipesDir) ? readdirSync(config.recipesDir).filter((f) => f.endsWith(".json")).length : 0;
    checks.push({ status: "ok", label: `Data folder: ${config.home} (${recipes} recipe${recipes === 1 ? "" : "s"})` });
  } catch (error) {
    checks.push({ status: "fail", label: `Data folder ${config.home} is not writable`, fix: `${error?.message ?? error}. Set UNWALLED_HOME to a folder you can write to.` });
  }
  if (!config.encryptSecrets) checks.push({ status: "warn", label: "Secrets are stored in plain text (UNWALLED_PLAINTEXT_SECRETS=1)" });
  else {
    try {
      checks.push({ status: "ok", label: `Secrets encrypted at rest (${secretKey(config.home).source})` });
    } catch (error) {
      checks.push({ status: "fail", label: "Secrets cannot be encrypted", fix: `${error?.message ?? error}. Set UNWALLED_SECRET_KEY to a passphrase.` });
    }
  }
  if (config.orgPolicy) checks.push({ status: "ok", label: "Organization policy applied (unwalled policy shows it)" });
  if (clients) {
    const installed = knownClients(env).filter((c) => c.installed);
    if (!installed.length) checks.push({ status: "warn", label: "No MCP client found (Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Gemini CLI, Codex)", fix: "Install one, then run: unwalled setup" });
    for (const client of installed) {
      const status = clientStatus(client, env);
      if (status === "configured") checks.push({ status: "ok", label: `${client.label}: unwalled is connected` });
      else if (status === "absent") checks.push({ status: "warn", label: `${client.label}: unwalled is not added yet`, fix: "Run: unwalled setup" });
      else checks.push({ status: "warn", label: `${client.label}: could not read its configuration`, fix: client.file ? `Check ${client.file}` : 'Install the "claude" command to let unwalled configure Claude Code.' });
    }
  }
  return checks;
}

/** @param {Check[]} checks */
export function formatChecks(checks) {
  const mark = { ok: "✔", warn: "!", fail: "✖" };
  return checks.map((c) => `  ${mark[c.status]} ${c.label}${c.fix ? `\n      → ${c.fix}` : ""}`).join("\n");
}

// ---------------------------------------------------------------- demo

export const DEMO_PORT = 8099;

/**
 * Starts the demo back office (Acme: orders and customers behind a sign-in) and makes sure the "acme" recipe points at it.
 * @param {Engine} engine @param {{ port?: number, onProgress?: (message: string) => void }} [options]
 */
export async function startDemo(engine, { port = DEMO_PORT, onProgress = () => {} } = {}) {
  const { startIntranet } = await import("../examples/intranet/server.js");
  let intranet;
  try {
    intranet = await startIntranet(port);
  } catch (error) {
    if (/EADDRINUSE/.test(String(error?.message ?? error))) throw new Error(`Port ${port} is already used. Run: unwalled demo --port ${port + 1}`);
    throw error;
  }
  let recipe = engine.recipes.get("acme");
  if (!recipe || recipe.baseUrl !== intranet.url) {
    onProgress("Discovering the demo back office: signing in as alice, opening an order and two customer pages");
    recipe = await engine.discover(
      {
        name: "acme", url: `${intranet.url}/login`, mode: "browser",
        actions: [{ fill: "#user", text: "alice" }, { fill: "#password", text: "demo" }, { click: "button[type=submit]" }, { goto: "/orders/1001" }, { goto: "/customers?city=Lyon" }, { goto: "/customers/512" }],
      },
      onProgress,
    );
  }
  return { intranet, recipe };
}

// ---------------------------------------------------------------- keys of ready-made services

/**
 * The header a service expects, read from its hint: set_credentials(host="api.github.com", headers={"authorization": "Bearer <token>"}).
 * @param {string} hint @returns {{ host: string, header: string, prefix: string } | null}
 */
export function credentialHint(hint) {
  const match = /set_credentials\(host="([^"]+)", headers=\{"([^"]+)": "([^"]*)"\}\)/.exec(hint);
  if (!match) return null;
  return { host: match[1], header: match[2], prefix: match[3].replace(/<[^>]+>|sk_\.\.\.$/, "") };
}

/** @param {any} recipe */
const credentialNote = (recipe) => (recipe.warnings ?? []).find((/** @type {string} */ w) => String(w).startsWith("Credentials: "));

/** The key a recipe still needs (from its "Credentials:" note), or null when it has none or it is stored. @param {Engine} engine @param {any} recipe */
export function keyNeeded(engine, recipe) {
  const note = credentialNote(recipe);
  const hint = note ? credentialHint(note) : null;
  if (!hint) return null;
  return engine.store.loadSecrets(recipe.name)[hint.host]?.[hint.header.toLowerCase()] ? null : hint;
}

/**
 * Stores a recipe's key, encrypted, sent to its own host only.
 * @param {Engine} engine @param {string} name @param {string} token
 */
export function storeKey(engine, name, token) {
  const note = credentialNote(engine.recipe(name));
  const hint = note ? credentialHint(note) : null;
  if (!hint) throw new Error(`"${name}" does not say which key it needs: ask your agent to set it (set_credentials) or to sign in (oauth_login).`);
  const value = hint.prefix && !token.toLowerCase().startsWith(hint.prefix.trim().toLowerCase()) ? `${hint.prefix}${token}` : token;
  engine.setCredentials({ name, host: hint.host, headers: { [hint.header]: value } });
  return hint;
}

// ---------------------------------------------------------------- wizard

/**
 * @param {import("./config.js").Config} config
 * @param {{ io?: Io, env?: import("./clients.js").ClientEnv, launch?: { command: string, args: string[] }, browserCheck?: boolean, yes?: boolean,
 *   keepDemo?: (stop: () => Promise<void>) => Promise<void>, fromNpx?: boolean, install?: () => string | null }} [options]
 */
export async function runSetup(config, { io = terminalIo(), env = systemEnv(), launch = launchCommand(), browserCheck = true, yes = false, keepDemo = waitForCtrlC, fromNpx = runsFromNpx(), install = installGlobally } = {}) {
  /** @type {Engine | null} */ let engine = null;
  const getEngine = () => (engine ??= new Engine(config));
  const progress = (/** @type {string} */ message) => io.print(`  … ${message}`);
  try {
    io.print(`\nunwalled ${VERSION} — give your AI agent the websites, internal tools, files and databases you use.\n`);

    io.print("Step 1 of 3 · Checking this computer");
    const checks = await runDoctor(config, { env, browser: browserCheck, clients: false });
    io.print(formatChecks(checks));
    if (checks.some((c) => c.status === "fail")) {
      io.print("\nFix the problem above, then run unwalled setup again.");
      process.exitCode = 1;
      return;
    }

    io.print("\nStep 2 of 3 · Connecting your AI apps");
    if (fromNpx && !yes && (await confirm(io, '  Install the "unwalled" command on this computer (npm install --global)? It starts faster and lets you type "unwalled add ...".'))) {
      const bin = install();
      if (bin) {
        launch = { command: process.execPath, args: [bin] };
        io.print('  ✔ Installed: "unwalled" now works in any terminal.');
      } else io.print("  ! The installation failed: your AI apps will start unwalled through npx instead.");
    }
    const installed = knownClients(env).filter((c) => c.installed);
    if (!installed.length) {
      io.print("  No MCP client found on this computer. In Claude Code, run:");
      io.print(`    claude mcp add --scope user ${SERVER_NAME} -- ${[launch.command, ...launch.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
      io.print("  Other apps (Claude Desktop, Cursor, Windsurf...) take this in their MCP configuration:");
      io.print(genericSnippet(launch).replace(/^/gm, "    "));
    }
    const restarts = [];
    for (const client of installed) {
      const status = clientStatus(client, env);
      if (status === "configured") {
        io.print(`  ✔ ${client.label}: already connected`);
        continue;
      }
      if (!yes && !(await confirm(io, `  Add unwalled to ${client.label}?`))) {
        io.print(`    skipped`);
        continue;
      }
      const result = addToClient(client, env, launch);
      io.print(result.ok ? `  ✔ ${client.label}: ${result.message}` : `  ! ${client.label}: ${result.message}`);
      if (result.ok && client.restart) restarts.push(`${client.label}: ${client.restart}`);
    }
    if (restarts.length) io.print(`\n  To load it:\n${restarts.map((r) => `    ${r}`).join("\n")}`);

    if (yes) {
      io.print('\nDone. Add a source with "unwalled add <address, file or database>", or ask your agent to discover one.');
      return;
    }

    io.print("\nStep 3 of 3 · Your first source");
    io.print("  What should your agent be able to use?");
    io.print("    1  A website or an internal app (you can sign in)");
    io.print("    2  A file or a folder: CSV, Excel, JSON, SQLite, OpenAPI, Postman, HAR...");
    io.print("    3  A database: postgres://... or mysql://...");
    io.print(`    4  A ready-made service: ${Object.keys(PRESETS).slice(0, 8).join(", ")}...`);
    io.print("    5  The demo back office (try it in one minute)");
    io.print("    6  Nothing now");
    const choice = await askWithDefault(io, "  Choice", "5");
    const taken = () => getEngine().recipes.keys();
    /** @type {any} */ let recipe = null;

    if (choice === "1") {
      const address = await io.ask("  Address of the site or app: ");
      if (!address) return;
      const target = classifySource(address).target;
      const name = await askWithDefault(io, "  Name for it", suggestName(address, taken()));
      io.print("  How should unwalled learn it?");
      io.print("    1  In a browser window: sign in if needed, open the pages your agent will use (a list, a record, a search), then close the window");
      io.print("    2  Automatically, without a window (public sites)");
      const how = await askWithDefault(io, "  Choice", "1");
      if (how === "1") io.print("  A browser window opens. Close it when you are done (it closes by itself after 10 minutes).");
      recipe = await addSource(getEngine(), { source: target, name, interactive: how === "1", durationSeconds: 600, explorePages: how === "1" ? 0 : 10 }, progress);
    } else if (choice === "2" || choice === "3") {
      const source = await (choice === "3" ? io.secret("  Database address (postgres://user:password@host/db or mysql://...; not shown): ") : io.ask("  Path of the file or folder: "));
      if (!source) return;
      const name = await askWithDefault(io, "  Name for it", suggestName(source, taken()));
      recipe = await addSource(getEngine(), { source, name }, progress);
    } else if (choice === "4") {
      io.print(`  Available: ${Object.keys(PRESETS).join(", ")}, or google:<api>/<version>`);
      const preset = (await io.ask("  Which one? ")).replace(/^preset:/i, "");
      if (!preset) return;
      const name = await askWithDefault(io, "  Name for it", suggestName(`preset:${preset}`, taken()));
      recipe = await addSource(getEngine(), { source: `preset:${preset}`, name }, progress);
      const needed = keyNeeded(getEngine(), recipe);
      if (needed) {
        const token = await io.secret(`  This service needs an API key or token (sent to ${needed.host} only). Paste it (not shown; Enter to skip): `);
        if (token) {
          storeKey(getEngine(), name, token);
          io.print("  ✔ Key stored, encrypted.");
        }
      }
    } else if (choice === "5") {
      const { intranet, recipe: demo } = await startDemo(getEngine(), { onProgress: progress });
      io.print(`\n${summarize(getEngine(), demo)}`);
      io.print(`\nThe demo back office runs at ${intranet.url} (user alice, password demo).`);
      io.print(`Now ask your agent:\n  "${exampleQuestion(demo)}"`);
      io.print("\nKeep this window open while you try it. Press Ctrl+C to stop the demo.");
      await keepDemo(() => intranet.close());
      return;
    } else {
      io.print('\nDone. Later: "unwalled add <address, file or database>", or ask your agent to discover a site.');
      return;
    }

    if (recipe) {
      io.print(`\n${summarize(getEngine(), recipe)}`);
      io.print(`\nNow ask your agent, for example:\n  "${exampleQuestion(recipe)}"`);
      io.print('\nAdd more sources any time with "unwalled add <address, file or database>". Check everything with "unwalled doctor".');
    }
  } finally {
    io.close();
    await /** @type {Engine | null} */ (engine)?.close();
  }
}

/** Keeps the process alive until Ctrl+C, then runs stop. @param {() => Promise<void>} stop */
export function waitForCtrlC(stop) {
  return new Promise((resolve) => {
    process.once("SIGINT", async () => {
      await stop().catch(() => {});
      resolve(undefined);
    });
  });
}

/**
 * Removes unwalled from every MCP client that starts it.
 * @param {Io} io @param {import("./clients.js").ClientEnv} [env]
 */
export function removeEverywhere(io, env = systemEnv()) {
  let removed = 0;
  for (const client of knownClients(env).filter((c) => c.installed)) {
    if (clientStatus(client, env) !== "configured") continue;
    const result = removeFromClient(client, env);
    io.print(result.ok ? `  ✔ ${client.label}: ${result.message}` : `  ! ${client.label}: ${result.message}`);
    if (result.ok) removed++;
  }
  if (!removed) io.print("  unwalled was not configured in any MCP client.");
  io.print("  Your recipes and secrets are kept in the data folder; delete it to remove them too.");
}
