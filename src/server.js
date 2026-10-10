// MCP stdio server: fixed management tools + tools generated from recipes (hot-added via tools/list_changed).
// With many generated tools, only search_tools / call_tool (and pinned tools) are listed, to keep the agent's context small.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describeRecipe, Engine } from "./core.js";
import { log } from "./log.js";
import { VERSION } from "./version.js";

const NAME = { type: "string", pattern: "^[a-z][a-z0-9-]{0,30}$", description: 'Recipe name: lowercase letters, digits, dashes (e.g. "github", "my-shop").' };

export const MANAGEMENT_TOOLS = [
  {
    name: "discover",
    description:
      "Discover the API behind a website or service and turn it into MCP tools (added immediately). " +
      "First looks for a published OpenAPI/Swagger description; otherwise opens a real browser, loads the page, runs optional actions, optionally explores the site, and records the JSON API calls " +
      "(REST and GraphQL), then infers endpoints with typed parameters. Rediscovering a name replaces it unless merge=true (annotations and macros are kept).",
    inputSchema: {
      type: "object",
      properties: {
        name: NAME,
        url: { type: "string", description: "Page to load (or the URL of an OpenAPI description)." },
        mode: { type: "string", enum: ["auto", "openapi", "browser"], description: "auto (default): OpenAPI first, then browser capture." },
        actions: {
          type: "array",
          description:
            'Browser steps run after the page loads, each with exactly one key: {"goto": url}, {"click": selector}, {"fill": selector, "text": "..."}, ' +
            '{"press": "Enter"}, {"waitFor": selector}, {"wait": ms}, {"scroll": pixels}. Values typed or navigated to become parameters.',
          items: { type: "object" },
        },
        explore_pages: { type: "integer", minimum: 0, maximum: 100, description: "Also follow up to N same-site links and click harmless 'load more' buttons and tabs (never logout, delete, pay...). Default 0." },
        interactive: { type: "boolean", description: "Open a visible window where the user browses; capture ends when the window is closed or after duration_seconds." },
        duration_seconds: { type: "integer", minimum: 5, maximum: 1800, description: "Interactive capture length (default 120)." },
        hosts: { type: "array", items: { type: "string" }, description: "Extra API hosts to capture besides the site's own domain (e.g. a third-party API)." },
        include: { type: "string", description: "OpenAPI only: regular expression selecting which operations become tools." },
        max_endpoints: { type: "integer", minimum: 1, maximum: 200, description: "Maximum endpoints kept (default 40)." },
        merge: { type: "boolean", description: "Add newly captured endpoints to the existing recipe instead of replacing it." },
      },
      required: ["name", "url"],
    },
    annotations: { title: "Discover an API", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "discover_har",
    description: "Create tools from a HAR file (browser devtools export, mitmproxy, Charles, Proxyman...): ideal for mobile or desktop app traffic. Credentials found in the file are stored as local secrets, never in the recipe.",
    inputSchema: {
      type: "object",
      properties: {
        name: NAME,
        har_path: { type: "string", description: "Absolute path to the .har file." },
        hosts: { type: "array", items: { type: "string" }, description: "Only keep these hosts (and subdomains)." },
        max_endpoints: { type: "integer", minimum: 1, maximum: 200 },
        merge: { type: "boolean" },
      },
      required: ["name", "har_path"],
    },
    annotations: { title: "Import a HAR capture", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "login",
    description: "Open a visible browser on the recipe's profile so the user can sign in (or solve a captcha / bot challenge); cookies are kept for later calls and discoveries. Returns when the user closes the window (or after duration_seconds).",
    inputSchema: {
      type: "object",
      properties: { name: NAME, url: { type: "string" }, duration_seconds: { type: "integer", minimum: 10, maximum: 1800, description: "Default 180." } },
      required: ["name", "url"],
    },
    annotations: { title: "Sign in", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "set_credentials",
    description: 'Store headers (e.g. {"authorization": "Bearer ..."} or {"x-api-key": "..."}) sent to one host by the recipe\'s tools. Stored locally, outside the recipe. An empty value removes a header; clear=true removes all headers for the host.',
    inputSchema: {
      type: "object",
      properties: {
        name: NAME,
        host: { type: "string", description: 'Bare host, e.g. "api.example.com" or "localhost:8080".' },
        headers: { type: "object", additionalProperties: { type: "string" } },
        clear: { type: "boolean" },
      },
      required: ["name", "host"],
    },
    annotations: { title: "Set credentials", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "configure_recipe",
    description:
      "Local settings of a recipe. policy: readOnly (refuse writes), confirm ('none' | 'destructive' | 'writes': calls that need confirm=true), allowedHosts, rateLimit (requests/second/host), " +
      "transport ('auto' | 'node' | 'page': browser recipes send requests from inside a real page with 'page'). oauth: refresh settings so expired access tokens renew themselves " +
      "({host, token_url, refresh_token, client_id?, client_secret?, scope?, encoding?: 'form'|'json'}; stored with the secrets). headers: non-secret headers added to every call. policy=null resets the policy.",
    inputSchema: {
      type: "object",
      properties: {
        name: NAME,
        policy: {
          type: ["object", "null"],
          properties: {
            readOnly: { type: "boolean" },
            confirm: { type: "string", enum: ["none", "destructive", "writes"] },
            allowedHosts: { type: "array", items: { type: "string" } },
            rateLimit: { type: "number", minimum: 0 },
            transport: { type: "string", enum: ["auto", "node", "page"] },
            cacheSeconds: { type: "number", minimum: 0, maximum: 86400 },
          },
        },
        oauth: { type: "object", additionalProperties: { type: "string" } },
        headers: { type: "object", additionalProperties: { type: ["string", "null"] }, description: "Non-secret headers sent with every call of the recipe (e.g. accept-language, an API version); null removes one." },
      },
      required: ["name"],
    },
    annotations: { title: "Configure a recipe", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "annotate_recipe",
    description:
      "Give a recipe's tools meaningful names and descriptions (saved in the recipe, shared with it). After inspecting what the generated tools return, write for each tool: " +
      'name (new suffix, e.g. "search_products"), description, title, params (e.g. {"query.q": "Search text"}), defaults (arguments used when the call omits them, e.g. {"query": {"lang": "fr"}}), ' +
      "hidden=true to hide noise. A null value removes a tool's annotations.",
    inputSchema: {
      type: "object",
      properties: { name: NAME, annotations: { type: "object", additionalProperties: { type: ["object", "null"] }, description: "Keyed by current tool name." } },
      required: ["name", "annotations"],
    },
    annotations: { title: "Annotate tools", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "define_macro",
    description:
      "Create (or replace) a macro: one tool <recipe>__m_<id> that chains several tool calls. Step args may use {{params.x}} and {{steps.<as or index>.<path>}} " +
      '(e.g. "{{steps.search.items[0].id}}") to pass values from earlier responses. Example: {"id": "first_product_price", "description": "Price of the first search result", ' +
      '"params": {"q": {"type": "string", "required": true}}, "steps": [{"tool": "get_api_search", "args": {"query": {"q": "{{params.q}}"}}, "as": "search"}, ' +
      '{"tool": "get_api_products_product", "args": {"path": {"product": "{{steps.search.results[0].id}}"}}}], "result": "{{steps.1.price}}"}. remove=<id> deletes a macro.',
    inputSchema: { type: "object", properties: { name: NAME, macro: { type: "object" }, remove: { type: "string" } }, required: ["name"] },
    annotations: { title: "Define a macro", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "check_recipe",
    description: "Health check: calls every read-only tool with its recorded example and reports ok / changed / broken / auth. repair=true rediscovers the recipe from its original inputs when something is broken or changed, and lists added and removed tools.",
    inputSchema: { type: "object", properties: { name: NAME, repair: { type: "boolean" } }, required: ["name"] },
    annotations: { title: "Check a recipe", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "ui",
    description:
      "Use a site through its interface when it has no usable API (server-rendered pages, signed requests): the recipe's browser profile (logged-in cookies) on a real page. " +
      "action=open (url) or snapshot lists interactive elements with refs like e12; act runs steps [{click: ref|selector}, {fill: ref, text}, {select: ref, value}, {check: ref}, {press: key}, {goto: url}, {hover}, {wait: ms}, {waitFor}, {scroll}] " +
      "and returns a new snapshot; read returns the page text (or of selector); screenshot returns an image (or writes save_to); close. Clicks on delete / pay / send controls need confirm=true. visible=true shows the window.",
    inputSchema: {
      type: "object",
      properties: {
        name: NAME,
        action: { type: "string", enum: ["open", "snapshot", "act", "read", "screenshot", "close"] },
        url: { type: "string" },
        steps: { type: "array", items: { type: "object" } },
        selector: { type: "string" },
        confirm: { type: "boolean" },
        visible: { type: "boolean" },
        max_chars: { type: "integer", minimum: 100 },
        save_to: { type: "string" },
      },
      required: ["name", "action"],
    },
    annotations: { title: "Drive a site's interface", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "list_recipes",
    description: "List discovered recipes with their endpoints, macros and tools.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "List recipes", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "inspect_recipe",
    description: "Show a recipe in detail: endpoints, query parameters, response shapes, annotations, macros, warnings, local policy and health, and the names of stored credential headers (never their values).",
    inputSchema: { type: "object", properties: { name: NAME }, required: ["name"] },
    annotations: { title: "Inspect a recipe", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "forget",
    description: "Delete a recipe, its tools, its stored credentials and local state. delete_profile=true also deletes its browser profile (cookies).",
    inputSchema: { type: "object", properties: { name: NAME, delete_profile: { type: "boolean" } }, required: ["name"] },
    annotations: { title: "Forget a recipe", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "search_tools",
    description: "Find generated tools by keywords (name, description, recipe). Returns their names, descriptions and input schemas; run one with call_tool. Use this when the generated tools are not all listed.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, recipe: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 30, description: "Default 8." }, pin: { type: "boolean", description: "Also list the matching tools directly from now on." } },
      required: ["query"],
    },
    annotations: { title: "Search tools", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "call_tool",
    description: "Run any generated tool by name (see search_tools) with its arguments.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, required: ["name"] },
    annotations: { title: "Call a generated tool", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

const text = (value, isError = false) => ({ content: [{ type: "text", text: value }], isError });

/** Keyword search over generated tools. @param {Iterable<import("./tools/generate.js").GeneratedTool>} tools @param {string} query @param {string} [recipe] */
export function searchTools(tools, query, recipe) {
  const words = String(query).toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length > 1);
  const scored = [];
  for (const tool of tools) {
    if (recipe && !tool.name.startsWith(`${recipe}__`)) continue;
    const name = tool.name.toLowerCase();
    const haystack = `${name} ${tool.description.toLowerCase()}`;
    let score = 0;
    for (const word of words) {
      const stem = word.length > 4 ? word.replace(/(es|s)$/, "") : word;
      if (name.includes(stem)) score += 3;
      else if (haystack.includes(stem)) score += 1;
    }
    if (score || !words.length) scored.push({ tool, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).map((s) => s.tool);
}

/** @param {import("./config.js").Config} config */
export async function startServer(config) {
  const engine = new Engine(config);
  /** Tools listed even in search mode (pinned with search_tools). @type {Set<string>} */
  const pinned = new Set();
  const server = new Server(
    { name: "universal-mcp", version: VERSION },
    {
      capabilities: { tools: { listChanged: true } },
      instructions:
        "universal-mcp turns websites, HAR captures and OpenAPI descriptions into tools. Call list_recipes to see what is already available. " +
        "To use a new site, call discover with a name and URL (add actions to reach the data, explore_pages to cover more of the site, or interactive=true to let the user browse), then call the generated <name>__* tools. " +
        "For sites behind a login, call login first. If a site has no usable API, use the ui tool. When not every generated tool is listed, find them with search_tools and run them with call_tool. " +
        "Generated tools accept pick (to trim JSON), max_chars, save_to (downloads), dry_run (preview) and confirm (for calls held by the safety policy). " +
        "After learning what tools do, name them with annotate_recipe; chain frequent sequences with define_macro; if tools start failing, run check_recipe with repair=true.",
    },
  );

  const notifyToolsChanged = () => server.sendToolListChanged().catch((error) => log(`tools/list_changed failed: ${error.message}`));
  const searchMode = () => config.toolMode === "search" || (config.toolMode === "auto" && engine.tools.size > config.toolThreshold);
  const describe = ({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const generated = [...engine.tools.values()].filter((tool) => !searchMode() || pinned.has(tool.name));
    return { tools: [...MANAGEMENT_TOOLS, ...generated.map(describe)] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name } = request.params;
    const args = /** @type {Record<string, any>} */ (request.params.arguments ?? {});
    const progressToken = request.params._meta?.progressToken;
    let step = 0;
    const onProgress = (message) => {
      log(message);
      if (progressToken !== undefined)
        extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: ++step, message } }).catch(() => {});
    };
    const toolNames = (recipe) => engine.toolsOf(recipe).map((t) => t.name);
    const listingNote = () => (searchMode() ? `\n(${engine.tools.size} generated tools in total: they are not all listed; use search_tools and call_tool.)` : "");
    try {
      switch (name) {
        case "discover": {
          const started = Date.now();
          const recipe = await engine.discover(
            {
              name: args.name, url: args.url, mode: args.mode, actions: args.actions, interactive: args.interactive, explorePages: args.explore_pages,
              durationSeconds: args.duration_seconds, hosts: args.hosts, include: args.include, maxEndpoints: args.max_endpoints, merge: args.merge,
            },
            onProgress,
          );
          notifyToolsChanged();
          return text(`Discovered in ${((Date.now() - started) / 1000).toFixed(1)}s.\n${describeRecipe(recipe, toolNames(recipe.name))}${listingNote()}`);
        }
        case "discover_har": {
          const recipe = await engine.discoverHar({ name: args.name, harPath: args.har_path, hosts: args.hosts, maxEndpoints: args.max_endpoints, merge: args.merge });
          notifyToolsChanged();
          return text(`${describeRecipe(recipe, toolNames(recipe.name))}${listingNote()}`);
        }
        case "login": {
          const { timedOut } = await engine.login({ name: args.name, url: args.url, durationSeconds: args.duration_seconds });
          return text(`Browser profile "${args.name}" saved${timedOut ? " (window closed automatically after the time limit)" : ""}. Its cookies are used by discover, ui and the recipe's tools.`);
        }
        case "set_credentials": {
          const headers = engine.setCredentials({ name: args.name, host: args.host, headers: args.headers, clear: args.clear });
          return text(`Credentials for ${args.host} in "${args.name}": ${headers.length ? headers.join(", ") : "none"}.`);
        }
        case "configure_recipe": {
          const result = engine.configure(args.name, { policy: args.policy, oauth: args.oauth, headers: args.headers });
          return text(`Settings of "${args.name}": ${JSON.stringify(result)}`);
        }
        case "annotate_recipe": {
          const recipe = engine.annotateRecipe(args.name, args.annotations);
          notifyToolsChanged();
          return text(`Annotations saved.\n${describeRecipe(recipe, toolNames(recipe.name))}`);
        }
        case "define_macro": {
          const recipe = engine.defineMacro(args.name, { macro: args.macro, remove: args.remove });
          notifyToolsChanged();
          return text(`${args.remove ? `Macro "${args.remove}" removed` : `Macro "${args.macro.id}" saved as ${args.name}__m_${args.macro.id}`}.\n${describeRecipe(recipe, toolNames(recipe.name))}`);
        }
        case "check_recipe": {
          const result = await engine.checkRecipe(args.name, { repair: args.repair });
          if (args.repair) notifyToolsChanged();
          return text(result.text, (result.counts.broken ?? 0) > 0 && !args.repair);
        }
        case "ui": {
          const result = await engine.ui({
            name: args.name, action: args.action, url: args.url, steps: args.steps, selector: args.selector, confirm: args.confirm, visible: args.visible,
            maxChars: args.max_chars, saveTo: args.save_to,
          });
          if (result.image) return { content: [{ type: "text", text: result.text }, { type: "image", data: result.image, mimeType: "image/png" }], isError: false };
          return text(result.text, !!result.isError);
        }
        case "list_recipes": {
          if (!engine.recipes.size) return text("No recipe yet. Call discover (or discover_har) to create one.");
          return text([...engine.recipes.values()].map((r) => describeRecipe(r, toolNames(r.name))).join("\n\n") + listingNote());
        }
        case "inspect_recipe": {
          const recipe = engine.recipe(args.name);
          const secrets = engine.store.loadSecrets(recipe.name);
          const { policy, health } = engine.store.loadState(recipe.name);
          const { spec, ...shown } = recipe;
          const credentialSummary = Object.entries(secrets).map(([host, headers]) => `${host}: ${Object.keys(headers).join(", ")}`);
          return text(
            `${JSON.stringify(shown, null, 1)}\n\nLocal policy: ${JSON.stringify(policy ?? {})}\nLast health check: ${health ? `${health.checkedAt} ${JSON.stringify(health.counts)}` : "never"}` +
              `\nStored credential headers (values hidden): ${credentialSummary.join(" ; ") || "none"}`,
          );
        }
        case "forget": {
          await engine.forget(args.name, { deleteProfile: args.delete_profile });
          [...pinned].filter((t) => t.startsWith(`${args.name}__`)).forEach((t) => pinned.delete(t));
          notifyToolsChanged();
          return text(`Recipe "${args.name}" deleted${args.delete_profile ? " with its browser profile" : ""}.`);
        }
        case "search_tools": {
          const found = searchTools(engine.tools.values(), args.query, args.recipe).slice(0, Math.min(args.limit ?? 8, 30));
          if (!found.length) return text(`No generated tool matches "${args.query}". Call list_recipes to see recipes.`);
          if (args.pin) {
            found.forEach((tool) => pinned.add(tool.name));
            notifyToolsChanged();
          }
          return text(found.map((tool) => `## ${tool.name}\n${tool.description}\nInput schema: ${JSON.stringify(tool.inputSchema)}`).join("\n\n"));
        }
        case "call_tool": {
          const tool = engine.tools.get(args.name);
          if (!tool) return text(`Unknown tool "${args.name}". Use search_tools to find generated tools.`, true);
          const result = await tool.run(args.arguments ?? {});
          return text(result.text, result.isError);
        }
        default: {
          const tool = engine.tools.get(name);
          if (!tool) return text(`Unknown tool "${name}". Call list_recipes to see available recipes.`, true);
          const result = await tool.run(args);
          return text(result.text, result.isError);
        }
      }
    } catch (error) {
      return text(`Error: ${error?.message ?? error}`, true);
    }
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await engine.close();
    process.exit(0);
  };
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  log(`v${VERSION} ready — ${engine.recipes.size} recipe(s), ${engine.tools.size} generated tools${searchMode() ? " (search mode)" : ""}, data in ${config.home}`);
  return { server, engine };
}
