// Command-line entry point. Without a command, runs the MCP server on stdio.
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { describeRecipe, Engine } from "./core.js";
import { describeOrgPolicy } from "./safety.js";
import { startServer } from "./server.js";
import { VERSION } from "./version.js";

const HELP = `unwalled ${VERSION} — open any website, app, API, file or database to AI agents, as MCP tools.

Usage:
  unwalled [serve]                              Run the MCP server on stdio (what MCP clients launch)
  unwalled discover <name> <url> [options]      Discover an API from the terminal
      --mode auto|openapi|browser   --interactive   --duration <seconds>
      --actions '<json array>'      --host <host> (repeatable)   --include <regex>   --merge
      --explore <pages>             also follow same-site links (never logout, delete, pay...)
  unwalled har <name> <file.har> [--host <host>] [--merge]
  unwalled import <name> <file> [--base-url <url>] [--include <regex>]
                                                OpenAPI, Swagger, Google Discovery, Postman, Insomnia, HAR,
                                                exported recipe, or Bruno collection folder
  unwalled login <name> <url> [--duration <seconds>]
  unwalled check <name> [--repair]              Call read-only tools and report broken or changed ones
  unwalled curl <name> <file.txt> [--merge]     Create tools from cURL commands saved in a text file
  unwalled export <name> <file.json>            Write a recipe (no secrets) to share it; import it with "import"
  unwalled policy                               Check and show the organization policy (UNWALLED_ORG_POLICY)
  unwalled list                                 List recipes
  unwalled inspect <name>                       Show a recipe as JSON
  unwalled forget <name> [--delete-profile]
  unwalled --help | --version

Environment:
  UNWALLED_HOME          Data directory (default ~/.unwalled)
  UNWALLED_BROWSER       chrome (default) | msedge | chromium | /path/to/browser
  UNWALLED_MAX_OUTPUT    Max characters returned per tool call (default 40000)
  UNWALLED_TIMEOUT_MS    Request timeout (default 30000)
  UNWALLED_MAX_ENDPOINTS, UNWALLED_MAX_OPENAPI_TOOLS  Tool count limits (default 40 / 60)
  UNWALLED_CONFIRM       Calls needing confirm=true: destructive (default) | writes | none
  UNWALLED_RATE_LIMIT    Requests per second per host (default 5, 0 = unlimited)
  UNWALLED_RETRIES       Automatic retries of temporary failures (default 2)
  UNWALLED_TOOL_MODE     auto (default: search mode above UNWALLED_TOOL_THRESHOLD=60 tools) | all | search
  UNWALLED_AUDIT         0 disables the audit log (<home>/audit.log)
  UNWALLED_ORG_POLICY    Path of an organization policy (JSON) that agents cannot loosen; check it with "unwalled policy"
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
});

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
  const [command = "serve", ...rest] = positionals;
  const config = loadConfig();
  if (command === "serve") {
    await startServer(config);
    return;
  }

  const engine = new Engine(config);
  const toolNames = (name) => engine.toolsOf(name).map((t) => t.name);
  const duration = values.duration ? Number(values.duration) : undefined;
  try {
    switch (command) {
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
        const recipe = await engine.importFile({ name: rest[0], path: resolve(rest[1]), baseUrl: values["base-url"], include: values.include, hosts: values.host, merge: values.merge });
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
        console.log(org ? `${describeOrgPolicy(org) || "The organization policy sets no rule."}

${JSON.stringify(org, null, 2)}` : "No organization policy (set UNWALLED_ORG_POLICY to the path of a JSON file).");
        break;
      }
      case "list":
        console.log(engine.recipes.size ? [...engine.recipes.values()].map((r) => describeRecipe(r, toolNames(r.name))).join("\n\n") : "No recipe yet.");
        break;
      case "inspect": {
        expect(rest, 1, "inspect <name>");
        const { spec, ...recipe } = engine.recipe(rest[0]);
        console.log(JSON.stringify(recipe, null, 2));
        break;
      }
      case "forget":
        expect(rest, 1, "forget <name> [--delete-profile]");
        await engine.forget(rest[0], { deleteProfile: values["delete-profile"] });
        console.log(`Recipe "${rest[0]}" deleted.`);
        break;
      default:
        throw new Error(`Unknown command "${command}". Run unwalled --help.`);
    }
  } finally {
    await engine.close();
  }
}
