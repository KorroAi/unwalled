import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { addToClient, clientStatus, knownClients, launchCommand, PACKAGE_SPEC, removeFromClient } from "../../src/clients.js";
import { PRESETS } from "../../src/presets.js";
import { classifySource, credentialHint, suggestName } from "../../src/setup.js";

const fixture = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe("sources in plain words", () => {
  it("tells websites, data addresses, databases, presets, files and cURL lists apart", () => {
    const dir = mkdtempSync(join(tmpdir(), "umcp-sources-"));
    try {
      writeFileSync(join(dir, "calls.txt"), "# saved from devtools\ncurl 'https://api.example.com/v1/items' -H 'accept: application/json'\n");
      assert.deepEqual(classifySource("https://erp.example.com/orders"), { action: "discover", target: "https://erp.example.com/orders" });
      assert.deepEqual(classifySource("erp.example.com"), { action: "discover", target: "https://erp.example.com" });
      assert.deepEqual(classifySource("localhost:8080/app"), { action: "discover", target: "http://localhost:8080/app" });
      assert.equal(classifySource("https://example.com/export/sales.csv").action, "import");
      assert.equal(classifySource("https://docs.google.com/spreadsheets/d/x/export?format=csv").action, "import");
      assert.equal(classifySource("https://example.com/openapi.yaml").action, "discover", "API descriptions are found by discover");
      assert.deepEqual(classifySource("postgres://u:p@db/shop"), { action: "import", target: "postgres://u:p@db/shop" });
      assert.equal(classifySource("mariadb://u:p@db/shop").action, "import");
      assert.deepEqual(classifySource("preset:github"), { action: "discover", target: "preset:github" });
      assert.deepEqual(classifySource("calls.txt", { cwd: dir }), { action: "curl", target: join(dir, "calls.txt") });
      assert.deepEqual(classifySource(`"${fixture("sample.xlsx")}"`), { action: "import", target: fixture("sample.xlsx") });
      assert.throws(() => classifySource("not a source"), /not a web address/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("suggests short, valid and unused recipe names", () => {
    assert.equal(suggestName("https://grafana.example.com/d/abc"), "grafana");
    assert.equal(suggestName("https://www.crates.io"), "crates");
    assert.equal(suggestName("https://app.acme-corp.com"), "acme-corp");
    assert.equal(suggestName("http://127.0.0.1:8099/login"), "local-8099");
    assert.equal(suggestName("postgres://u:p@db.internal:5432/shop"), "shop");
    assert.equal(suggestName("preset:google:youtube/v3"), "youtube");
    assert.equal(suggestName("C:\\data\\Café Sales 2026.xlsx"), "cafe-sales-2026");
    assert.equal(suggestName("./2026 report.csv"), "s-2026-report");
    assert.equal(suggestName("preset:github", ["github", "github-2"]), "github-3");
  });

  it("reads the key a ready-made service needs from its hint", () => {
    assert.deepEqual(credentialHint(String(PRESETS.github.auth)), { host: "api.github.com", header: "authorization", prefix: "Bearer " });
    assert.deepEqual(credentialHint(String(PRESETS.stripe.auth)), { host: "api.stripe.com", header: "authorization", prefix: "Bearer " });
    assert.deepEqual(credentialHint(String(PRESETS.discord.auth)), { host: "discord.com", header: "authorization", prefix: "Bot " });
    assert.deepEqual(credentialHint(String(PRESETS.elevenlabs.auth)), { host: "api.elevenlabs.io", header: "xi-api-key", prefix: "" });
    assert.equal(credentialHint("Credentials: sign in with oauth_login"), null);
  });
});

describe("MCP client configuration", () => {
  let home;
  /** @type {string[][]} */ let claudeCalls;
  let claudeServers;
  const env = () => ({
    home, platform: /** @type {NodeJS.Platform} */ ("linux"), appData: join(home, "AppData"), localAppData: join(home, "Local"),
    claude: (/** @type {string[]} */ args) => {
      claudeCalls.push(args);
      if (args[1] === "get") return { status: claudeServers.has(args[2]) ? 0 : 1, stdout: "", stderr: "" };
      if (args[1] === "add") claudeServers.add(args[4]);
      if (args[1] === "remove") return { status: claudeServers.delete(args[4]) ? 0 : 1, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  const launch = { command: "/usr/bin/node", args: ["/opt/unwalled/bin/unwalled.js"] };
  const client = (id) => /** @type {import("../../src/clients.js").Client} */ (knownClients(env()).find((c) => c.id === id));

  before(() => {
    home = mkdtempSync(join(tmpdir(), "umcp-clients-"));
    claudeCalls = [];
    claudeServers = new Set();
    for (const dir of [".cursor", ".codeium/windsurf", ".config/Code/User", ".codex", ".config/Claude", ".claude"]) mkdirSync(join(home, dir), { recursive: true });
  });
  after(() => rmSync(home, { recursive: true, force: true }));

  it("finds the installed clients only", () => {
    assert.deepEqual(knownClients(env()).filter((c) => c.installed).map((c) => c.id), ["claude-code", "claude-desktop", "cursor", "windsurf", "vscode", "codex"]);
  });

  it("adds itself to a JSON configuration, keeps the other servers and a backup, and removes itself", () => {
    const file = join(home, ".cursor", "mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
    assert.equal(clientStatus(client("cursor"), env()), "absent");
    assert.equal(addToClient(client("cursor"), env(), launch).ok, true);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { mcpServers: { other: { command: "x" }, unwalled: launch }, theme: "dark" });
    assert.ok(existsSync(`${file}.unwalled-backup`));
    assert.equal(clientStatus(client("cursor"), env()), "configured");
    assert.equal(removeFromClient(client("cursor"), env()).ok, true);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { mcpServers: { other: { command: "x" } }, theme: "dark" });
  });

  it("creates a missing file, uses VS Code's own format, and never rewrites a file with comments", () => {
    assert.equal(addToClient(client("vscode"), env(), launch).ok, true);
    assert.deepEqual(JSON.parse(readFileSync(join(home, ".config/Code/User/mcp.json"), "utf8")), { servers: { unwalled: { type: "stdio", ...launch } } });
    const file = join(home, ".codeium", "windsurf", "mcp_config.json");
    const commented = '{\n  // my servers\n  "mcpServers": {}\n}\n';
    writeFileSync(file, commented);
    const result = addToClient(client("windsurf"), env(), launch);
    assert.equal(result.ok, false);
    assert.match(result.message, /left untouched[\s\S]*"unwalled"/);
    assert.equal(readFileSync(file, "utf8"), commented);
  });

  it("writes a TOML table for Codex, replaces it on a second run and removes only it", () => {
    const file = join(home, ".codex", "config.toml");
    writeFileSync(file, 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n');
    addToClient(client("codex"), env(), launch);
    addToClient(client("codex"), env(), { command: "C:\\node\\node.exe", args: ["C:\\un walled\\bin\\unwalled.js"] });
    const text = readFileSync(file, "utf8");
    assert.equal(text.match(/\[mcp_servers\.unwalled\]/g)?.length, 1);
    assert.match(text, /command = "C:\\\\node\\\\node.exe"\nargs = \["C:\\\\un walled\\\\bin\\\\unwalled.js"\]/);
    assert.equal(clientStatus(client("codex"), env()), "configured");
    removeFromClient(client("codex"), env());
    assert.equal(readFileSync(file, "utf8"), 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n');
  });

  it("goes through the claude command for Claude Code (user scope)", () => {
    assert.equal(clientStatus(client("claude-code"), env()), "absent");
    assert.equal(addToClient(client("claude-code"), env(), launch).ok, true);
    assert.deepEqual(claudeCalls.at(-1), ["mcp", "add", "--scope", "user", "unwalled", "--", "/usr/bin/node", "/opt/unwalled/bin/unwalled.js"]);
    assert.equal(clientStatus(client("claude-code"), env()), "configured");
  });

  it("starts through npx when run from npx's cache, by full paths otherwise", () => {
    assert.deepEqual(launchCommand({ platform: "win32", binPath: "C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\1f2\\node_modules\\unwalled\\bin\\unwalled.js", execPath: "C:\\node\\node.exe" }), { command: "cmd", args: ["/c", "npx", "-y", PACKAGE_SPEC] });
    assert.deepEqual(launchCommand({ platform: "linux", binPath: "/home/a/.npm/_npx/1f2/node_modules/unwalled/bin/unwalled.js", execPath: "/nonexistent/bin/node" }), { command: "npx", args: ["-y", PACKAGE_SPEC] });
    assert.deepEqual(launchCommand({ platform: "linux", binPath: "/opt/unwalled/bin/unwalled.js", execPath: "/usr/bin/node" }), { command: "/usr/bin/node", args: ["/opt/unwalled/bin/unwalled.js"] });
  });
});

describe("terminal input", () => {
  it("shows typed keys as stars, even when the line is redrawn", async () => {
    const { PassThrough } = await import("node:stream");
    const { terminalIo } = await import("../../src/setup.js");
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (chunk) => (shown += chunk));
    const io = terminalIo({ input, output, terminal: true });
    const answer = io.secret("Token: ");
    for (const key of ["s", "3", "c", "r", "x", "\x7f", "e", "t", "\r"]) input.write(key);
    assert.equal(await answer, "s3cret");
    const plain = io.ask("Name: ");
    input.write("acme\r");
    assert.equal(await plain, "acme");
    io.close();
    assert.ok(!shown.includes("s3cr") && !shown.includes("cret"), JSON.stringify(shown));
    assert.match(shown, /Token: \*/);
    assert.match(shown, /acme/, "ordinary answers stay visible");
  });
});

describe("setup wizard", () => {
  let home, clientHome;
  before(() => {
    home = mkdtempSync(join(tmpdir(), "umcp-setup-"));
    clientHome = mkdtempSync(join(tmpdir(), "umcp-setup-clients-"));
    mkdirSync(join(clientHome, ".cursor"));
    process.env.UNWALLED_HOME = home;
  });
  after(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    rmSync(clientHome, { recursive: true, force: true });
  });

  /** @param {string[]} answers */
  const scripted = (answers) => {
    const output = [];
    const next = async (/** @type {string} */ question) => {
      output.push(question);
      return answers.shift() ?? "";
    };
    return { io: { ask: next, secret: next, print: (/** @type {string} */ text = "") => void output.push(text), close: () => {} }, output };
  };
  const env = () => ({ home: clientHome, platform: /** @type {NodeJS.Platform} */ ("linux"), appData: "", localAppData: "", claude: () => ({ status: null, stdout: "", stderr: "", missing: true }) });

  it("checks, connects the apps it finds and adds a first source", async () => {
    const { loadConfig } = await import("../../src/config.js");
    const { runSetup } = await import("../../src/setup.js");
    const { io, output } = scripted(["", "2", fixture("sample.xlsx"), ""]);
    await runSetup(loadConfig(), { io, env: env(), launch: { command: "node", args: ["unwalled.js"] }, browserCheck: false });
    const text = output.join("\n");
    assert.match(text, /Step 1 of 3[\s\S]*✔ Node\.js/);
    assert.match(text, /Add unwalled to Cursor\?[\s\S]*✔ Cursor: added to/);
    assert.match(text, /"sample" is ready: 2 tools[\s\S]*Now ask your agent/);
    assert.ok(existsSync(join(home, "recipes", "sample.json")));
    assert.deepEqual(JSON.parse(readFileSync(join(clientHome, ".cursor", "mcp.json"), "utf8")).mcpServers.unwalled, { command: "node", args: ["unwalled.js"] });
  });

  it("run with npx, offers to install the command and then configures apps with it", async () => {
    const { loadConfig } = await import("../../src/config.js");
    const { runSetup } = await import("../../src/setup.js");
    rmSync(join(clientHome, ".cursor", "mcp.json"), { force: true });
    const { io, output } = scripted(["", "", "6"]);
    await runSetup(loadConfig(), { io, env: env(), launch: { command: "npx", args: ["-y", "x"] }, browserCheck: false, fromNpx: true, install: () => "/global/unwalled/bin/unwalled.js" });
    assert.match(output.join("\n"), /Install the "unwalled" command[\s\S]*✔ Installed/);
    assert.deepEqual(JSON.parse(readFileSync(join(clientHome, ".cursor", "mcp.json"), "utf8")).mcpServers.unwalled, { command: process.execPath, args: ["/global/unwalled/bin/unwalled.js"] });
  });

  it("with --yes, configures every app without a question and stops", async () => {
    const { loadConfig } = await import("../../src/config.js");
    const { runSetup } = await import("../../src/setup.js");
    rmSync(join(clientHome, ".cursor", "mcp.json"));
    const { io, output } = scripted([]);
    await runSetup(loadConfig(), { io, env: env(), launch: { command: "node", args: ["unwalled.js"] }, browserCheck: false, yes: true });
    assert.ok(!output.some((line) => /\?/.test(line) && /Add unwalled/.test(line)), output.join("\n"));
    assert.ok(existsSync(join(clientHome, ".cursor", "mcp.json")));
    assert.doesNotMatch(output.join("\n"), /Step 3/);
  });
});
