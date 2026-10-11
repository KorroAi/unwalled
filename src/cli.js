// Command-line entry point. Without a command, runs the MCP server on stdio.
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { describeRecipe, Engine } from "./core.js";
import { describeOrgPolicy } from "./safety.js";
import { disabledTools, startServer } from "./server.js";
import { addSource, DEMO_PORT, exampleQuestion, formatChecks, keyNeeded, plainIo, removeEverywhere, runDoctor, runSetup, startDemo, storeKey, suggestName, summarize, terminalIo, waitForCtrlC } from "./setup.js";
import { VERSION } from "./version.js";

const HELP = `unwalled ${VERSION} — open any website, app, API, file or database to AI agents, as MCP tools.

Getting started:
  unwalled setup                                Guided setup: checks this computer, adds unwalled to your AI apps
                                                (Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Gemini CLI, Codex)
                                                and connects a first source. Also runs when you start unwalled in a terminal.
      --yes                         add unwalled to every app found, without questions, and stop there
      --remove                      remove unwalled from every app (recipes and secrets are kept)
  unwalled add <source> [--name <name>] [--browse] [--explore <pages>] [--base-url <url>] [--merge]
                                                Connect anything; its kind is detected:
                                                  a website or app     https://erp.example.com   (--browse: sign in and click
                                                                       through it in a window; --explore: follow its links)
                                                  a file or folder     ./sales.xlsx, ./api.yaml, ./postman.json, ./capture.har
                                                  a database           postgres://user:pass@host/db, mysql://...
                                                  a ready-made service preset:github, preset:stripe, preset:open-meteo...
  unwalled key <name>                           Store the API key or token a service needs (asked without echo)
  unwalled demo [--port <port>]                 Run the demo back office (orders and customers behind a sign-in) to try it
  unwalled doctor                               Check Node.js, the browser, the data folder, encryption and your AI apps
  unwalled list                                 List recipes and their tools

Server:
  unwalled serve                                Run the MCP server on stdio (what MCP clients launch; the default
                                                when unwalled is not started from a terminal)

Advanced:
  unwalled discover <name> <url> [options]      Discover an API from the terminal
      --mode auto|openapi|browser   --interactive   --duration <seconds>
      --actions '<json array>'      --host <host> (repeatable)   --include <regex>   --merge
      --explore <pages>             also follow same-site links (never logout, delete, pay...)
  unwalled har <name> <file.har> [--host <host>] [--merge]
  unwalled import <name> <file|address> [--base-url <url>] [--include <regex>]
                                                OpenAPI, Swagger, Google Discovery, Postman, Insomnia, Bruno, .http,
                                                HAR, exported recipe, or data: CSV, Excel, JSON, SQLite, iCalendar,
                                                RSS (file or https address), postgres:// or mysql:// database
  unwalled login <name> <url> [--duration <seconds>]
  unwalled check <name> [--repair]              Call read-only tools and report broken or changed ones
  unwalled curl <name> <file.txt> [--merge]     Create tools from cURL commands saved in a text file
  unwalled export <name> <file.json>            Write a recipe (no secrets) to share it; import it with "import"
  unwalled policy                               Check and show the organization policy (UNWALLED_ORG_POLICY)
  unwalled inspect <name>                       Show a recipe as JSON
  unwalled forget <name> [--delete-profile]
  unwalled --help | --version

Environment:
  UNWALLED_HOME          Data directory (default ~/.unwalled)
  UNWALLED_BROWSER       chrome (default) | msedge | chromium | /path/to/browser
  UNWALLED_MAX_OUTPUT    Max characters returned per tool call (default 40000)
  UNWALLED_COMPACT_CHARS Unpicked JSON longer than this is shown shortened with its field paths (default 6000, 0 = never)
  UNWALLED_TIMEOUT_MS    Request timeout (default 30000)
  UNWALLED_MAX_ENDPOINTS, UNWALLED_MAX_OPENAPI_TOOLS  Tool count limits (default 40 / 60)
  UNWALLED_CONFIRM       Calls needing confirm=true: destructive (default) | writes | none
  UNWALLED_RATE_LIMIT    Requests per second per host (default 5, 0 = unlimited)
  UNWALLED_RETRIES       Automatic retries of temporary failures (default 2)
  UNWALLED_TOOL_MODE     auto (default: search mode above UNWALLED_TOOL_THRESHOLD=60 tools) | all | search
  UNWALLED_AUDIT         0 disables the audit log (<home>/audit.log)
  UNWALLED_ORG_POLICY    Path of an organization policy (JSON) that agents cannot loosen; check it with "unwalled policy"
  UNWALLED_TEAM_RECIPES  Shared, read-only recipe folder of a team (network share, synced Git repository)
  UNWALLED_SECRET_KEY    Passphrase encrypting secrets, cookies and local state (default: Windows DPAPI, or a key file)
  The former UNIVERSAL_MCP_* names are still read.
`;

const OPTIONS = /** @type {const} */ ({
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  mode: { type: "string" },
  interactive: { type: "boolean" },
  duration: { type: "string" },
  actions: { type: "string" },
  host: { type: "string", multiple: true },
  include: { type: "string" },
  merge: { type: "boolean" },
  explore: { type: "string" },
  repair: { type: "boolean" },
  "base-url": { type: "string" },
  "delete-profile": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  remove: { type: "boolean" },
  name: { type: "string" },
  browse: { type: "boolean" },
  port: { type: "string" },
});

/** Text piped into the command (a key given with "echo $TOKEN | unwalled key github"). */
async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}

/** @param {string[]} positionals @param {number} count @param {string} usage */
function expect(positionals, count, usage) {
  if (positionals.length !== count) throw new Error(`Usage: unwalled ${usage}`);
}

/** @param {string[]} argv */
export async function main(argv) {
  const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const values = /** @type {Record<string, any>} */ (parsed.values);
  const positionals = parsed.positionals;
  if (values.help) return void process.stdout.write(HELP);
  if (values.version) return void process.stdout.write(`${VERSION}\n`);
  // MCP clients start unwalled with pipes: it serves. A person typing "unwalled" in a terminal gets the guided setup.
  const terminal = !!(process.stdin.isTTY && process.stdout.isTTY);
  const [command = terminal ? "setup" : "serve", ...rest] = positionals;
  const config = loadConfig();
  if (command === "serve") {
    await startServer(config);
    return;
  }
  if (command === "setup") {
    if (values.remove) return removeEverywhere(terminalIo());
    if (!terminal && !values.yes) throw new Error("unwalled setup asks questions: run it in a terminal, or add --yes to configure every AI app found without questions.");
    await runSetup(config, { yes: values.yes, ...(values.yes && !terminal ? { io: plainIo() } : {}) });
    return;
  }
  if (command === "doctor") {
    process.stdout.write("Checking this computer…\n");
    const checks = await runDoctor(config);
    console.log(formatChecks(checks));
    if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
    return;
  }

  const engine = new Engine(config);
  const toolNames = (name) => engine.toolsOf(name).map((t) => t.name);
  const duration = values.duration ? Number(values.duration) : undefined;
  const progress = (/** @type {string} */ message) => process.stderr.write(`… ${message}\n`);
  try {
    switch (command) {
      case "add": {
        expect(rest, 1, "add <source> [--name <name>] [--browse] [--explore <pages>] [--merge]");
        const name = values.name ?? suggestName(rest[0], values.merge ? [] : engine.recipes.keys());
        if (values.browse) process.stderr.write("A browser window opens: sign in if needed, open the pages your agent will use (a list, a record, a search), then close it.\n");
        const recipe = await addSource(
          engine,
          { source: rest[0], name, interactive: values.browse, durationSeconds: duration ?? (values.browse ? 600 : undefined), explorePages: values.explore ? Number(values.explore) : 0, merge: values.merge, baseUrl: values["base-url"] },
          progress,
        );
        console.log(summarize(engine, recipe));
        console.log(`\nAsk your agent, for example:\n  "${exampleQuestion(recipe)}"`);
        break;
      }
      case "key": {
        expect(rest, 1, "key <name>");
        const recipe = engine.recipe(rest[0]);
        const hint = keyNeeded(engine, recipe) ?? null;
        let token;
        if (terminal) {
          const io = terminalIo();
          try {
            token = await io.secret(`API key or token for "${recipe.name}"${hint ? ` (sent to ${hint.host} only)` : ""}, not shown: `);
          } finally {
            io.close();
          }
        } else token = await readStdin();
        if (!token) throw new Error("No key given.");
        const stored = storeKey(engine, recipe.name, token);
        console.log(`✔ Key stored, encrypted, for ${stored.host}.`);
        break;
      }
      case "demo": {
        const port = values.port ? Number(values.port) : DEMO_PORT;
        const { intranet, recipe } = await startDemo(engine, { port, onProgress: progress });
        console.log(summarize(engine, recipe));
        console.log(`\nThe demo back office runs at ${intranet.url} (user alice, password demo).`);
        console.log(`Now ask your agent:\n  "${exampleQuestion(recipe)}"`);
        console.log("\nKeep this window open while you try it. Press Ctrl+C to stop the demo.");
        await engine.close();
        await waitForCtrlC(() => intranet.close());
        break;
      }
      case "discover": {
        expect(rest, 2, "discover <name> <url> [options]");
        let actions;
        if (values.actions) {
          try {
            actions = JSON.parse(values.actions);
          } catch {
            throw new Error("--actions must be a JSON array");
          }
        }
        const recipe = await engine.discover(
          {
            name: rest[0], url: rest[1], mode: /** @type {any} */ (values.mode), actions, interactive: values.interactive, durationSeconds: duration, hosts: values.host,
            include: values.include, merge: values.merge, explorePages: values.explore ? Number(values.explore) : 0,
          },
          (message) => process.stderr.write(`… ${message}\n`),
        );
        console.log(describeRecipe(recipe, toolNames(recipe.name)));
        break;
      }
      case "har": {
        expect(rest, 2, "har <name> <file.har>");
        const { resolve } = await import("node:path");
        const recipe = await engine.discoverHar({ name: rest[0], harPath: resolve(rest[1]), hosts: values.host, merge: values.merge });
        console.log(describeRecipe(recipe, toolNames(recipe.name)));
        break;
      }
      case "import": {
        expect(rest, 2, "import <name> <file>");
        const { resolve } = await import("node:path");
        // Addresses (https://, postgres://, mysql://) are passed as they are; only local paths are resolved.
        const path = /^[a-z][a-z0-9+.-]*:\/\//i.test(rest[1]) ? rest[1] : resolve(rest[1]);
        const recipe = await engine.importFile({ name: rest[0], path, baseUrl: values["base-url"], include: values.include, hosts: values.host, merge: values.merge });
        console.log(describeRecipe(recipe, toolNames(recipe.name)));
        break;
      }
      case "curl": {
        expect(rest, 2, "curl <name> <file.txt>");
        const { readFileSync } = await import("node:fs");
        const recipe = await engine.importCurl({ name: rest[0], commands: readFileSync(rest[1], "utf8"), merge: values.merge });
        console.log(describeRecipe(recipe, toolNames(recipe.name)));
        break;
      }
      case "export": {
        expect(rest, 2, "export <name> <file.json>");
        const { resolve } = await import("node:path");
        const { path, bytes } = engine.exportRecipe({ name: rest[0], path: resolve(rest[1]) });
        console.log(`Written ${path} (${bytes} bytes, no secrets).`);
        break;
      }
      case "login":
        expect(rest, 2, "login <name> <url>");
        await engine.login({ name: rest[0], url: rest[1], durationSeconds: duration });
        console.log(`Profile "${rest[0]}" saved.`);
        break;
      case "check": {
        expect(rest, 1, "check <name> [--repair]");
        const result = await engine.checkRecipe(rest[0], { repair: values.repair });
        console.log(result.text);
        if ((result.counts.broken ?? 0) && !values.repair) process.exitCode = 1;
        break;
      }
      case "policy": {
        const org = config.orgPolicy;
        disabledTools(org);
        console.log(org ? `${describeOrgPolicy(org) || "The organization policy sets no rule."}\n\n${JSON.stringify(org, null, 2)}` : "No organization policy (set UNWALLED_ORG_POLICY to the path of a JSON file).");
        break;
      }
      case "list": {
        const describeOne = (r) => `${engine.store.isTeamRecipe(r.name) ? "[team catalogue] " : ""}${describeRecipe(r, toolNames(r.name))}`;
        console.log(engine.recipes.size ? [...engine.recipes.values()].map(describeOne).join("\n\n") : "No recipe yet.");
        break;
      }
      case "inspect": {
        expect(rest, 1, "inspect <name>");
        const { spec, ...recipe } = engine.recipe(rest[0]);
        console.log(JSON.stringify(recipe, null, 2));
        break;
      }
      case "forget": {
        expect(rest, 1, "forget <name> [--delete-profile]");
        const { restoredFromTeam } = await engine.forget(rest[0], { deleteProfile: values["delete-profile"] });
        console.log(restoredFromTeam ? `Your copy of "${rest[0]}" was deleted: the team catalogue's version is used again.` : `Recipe "${rest[0]}" deleted.`);
        break;
      }
      default:
        throw new Error(`Unknown command "${command}". Run unwalled --help.`);
    }
  } finally {
    await engine.close();
  }
}
