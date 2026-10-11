# unwalled

**Give your AI agent the internal tools your team uses every day, as typed MCP tools. No API, no integration code.**

The back office, the ERP screen, the intranet, the supplier portal, the reporting dashboard: most of the software people
use at work has no public API and will never get an MCP server. unwalled watches a real browser use the app once, then
gives your agent (Claude, Cursor, any MCP client) what the app itself uses:

- **the internal API calls** of modern web apps (REST and GraphQL), as documented tools;
- **the pages themselves** for server-rendered tools (Django or Rails admin, PHP back offices): tables, fields and links as JSON, and their forms as tools;
- plus **API files, data files and databases**: OpenAPI, Postman, HAR, CSV, Excel, SQLite, PostgreSQL, MySQL...

The tools keep working: unwalled stays signed in, renews sessions and CSRF tokens, retries, and detects and repairs tools when the app changes.
Everything runs on your machine.

![An agent signs in to an internal back office once, then answers questions through generated tools](docs/demo.gif)

<sub>Recorded with [`docs/demo/make-gif.js`](docs/demo/make-gif.js): real calls against the [example back office](examples/intranet/server.js).</sub>

## Get started

In a terminal (Node.js 22 or newer):

```bash
npx -y github:KorroAi/unwalled
```

A short guided setup:

1. **checks your computer** (Node.js, the browser, where data and encrypted secrets are kept);
2. **adds unwalled to the AI apps it finds**, asking for each: Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Gemini CLI, Codex
   (a backup of each configuration file is kept);
3. **connects your first source**, or a **demo back office** to try it in one minute.

Then open your AI app and ask. `unwalled doctor` checks everything again; `unwalled setup --remove` takes it out of every app.

<details><summary>Manual configuration</summary>

```bash
claude mcp add --scope user unwalled -- npx -y github:KorroAi/unwalled
```

Other MCP clients (Claude Desktop, Cursor, Windsurf...):

```json
{ "mcpServers": { "unwalled": { "command": "npx", "args": ["-y", "github:KorroAi/unwalled"] } } }
```

On Windows, some clients need `"command": "cmd"` with `"args": ["/c", "npx", "-y", "github:KorroAi/unwalled"]`.
Websites need Chrome or Edge (or `npx playwright-core install chromium` with `UNWALLED_BROWSER=chromium`); files, APIs and databases do not.
</details>

## Use it

**Try the demo**: `unwalled demo` starts a sample back office on your machine (orders and customers behind a sign-in), discovers it,
and tells you what to ask: *"Using acme, what is the status and total of order 1042? And which customers are in Lyon?"*

**Connect your sources from the terminal**, one command each; the kind of source is detected:

| You have | Command |
| --- | --- |
| An internal app or a site you sign in to | `unwalled add https://erp.example.com --browse` (a window opens: sign in, open the pages your agent will use, close it) |
| A public website | `unwalled add https://crates.io --explore 10` |
| A JSON API address | `unwalled add "https://api.open-meteo.com/v1/forecast?latitude=45.76&longitude=4.84&current=temperature_2m"` |
| A file or folder | `unwalled add ./sales-2026.xlsx` (CSV, Excel, JSON, SQLite, iCalendar, RSS...) |
| An API description or collection | `unwalled add ./openapi.yaml`, `./team.postman_collection.json`, `./capture.har`, `./curl-commands.txt` |
| A database (read-only) | `unwalled add postgres://reader:secret@db.example.com/shop` or `mysql://...` |
| A ready-made service | `unwalled add preset:github`, then `unwalled key github` (the token is typed without being shown) |

**Or just ask your agent in plain language:**

> Our back office is at https://erp.example.internal (user alice, password in my vault: I'll type it). Show me the open orders of customer 530.

> Discover https://grafana.example.internal, then tell me which dashboards mention revenue.

> Import this Postman collection / OpenAPI file / CSV / postgres://… and answer from it.

The agent calls `discover` or `import_file` once (with the sign-in steps, or `login` to let you sign in in a visible window). The answer lists
every generated tool with an example call, and the agent uses them right away. Recipes are saved: the tools are there in every later session.

`unwalled` without a global installation: prefix the commands with `npx -y github:KorroAi/unwalled` (the setup offers to install the command).

## What it connects

| Source | How |
| --- | --- |
| Web apps, including behind a sign-in | Browser capture of their REST and GraphQL calls; guessed sign-in selectors are matched to the page's own fields |
| Server-rendered tools (Django, Rails, PHP, wikis) | `__page_*` tools return tables, fields and links as JSON; HTML forms become tools, CSRF fields filled; `ui` for anything else |
| Mobile and desktop apps | HAR captures (mitmproxy, Charles, Proxyman, devtools) |
| Documented APIs | OpenAPI / Swagger (found automatically), Postman, Insomnia, Bruno, `.http`, cURL, Google APIs, OData, SOAP, JSON-RPC, AsyncAPI |
| Ready-made sources | `preset:github`, `stripe`, `vercel`, `elevenlabs`, `discord`, `binance`, `coingecko`, `open-meteo`, any Google API |
| Data | CSV, Excel, iCalendar, RSS / Atom, JSON, SQLite, PostgreSQL, MySQL / MariaDB, queried with read-only SQL |
| Live streams | WebSocket, Server-Sent Events, MQTT |

How each source was checked (most against real services, including a real Grafana behind a sign-in) and its known limits:
[compatibility table](docs/REFERENCE.md#compatibility).

## Is it worth it? Measured, not claimed

Same questions to the same agent (Claude Code, Sonnet), once with unwalled and once with a browser agent (Playwright MCP),
nothing scripted, every answer checked: 15 runs, 15 right answers ([method and every answer](bench/AGENT.md)).

| Cost per question | Apps behind a sign-in (back office, Grafana) | Public sites (crates.io, Flathub, OpenStreetMap) |
| --- | --- | --- |
| **unwalled, app already discovered** | **3 to 4 model turns, $0.022 to $0.030** | 3 to 6 turns, $0.019 to $0.051 |
| Browser agent | 8 to 9 turns, $0.055 to $0.059 | 3 to 4 turns, $0.021 to $0.025 |
| unwalled, first question (discovery included) | 5 turns, $0.046 to $0.051 | 5 to 8 turns, $0.049 to $0.060 |

- **Where it pays**: apps you sign in to and use repeatedly. 1.8 to 2.7 times cheaper per question once the app is
  known, and the first question already costs no more than with a browser.
- **Where it does not**: a public page a browser can open directly. There, use a browser.
- On [20 real public websites](bench/FIELD.md), one discovery with default options answered a question about a term it had never seen
  on 13 of them; 6 refused automated browsers (unwalled says so and does not bypass them) and 1 needed more than one page to generalise.
- The calls themselves are fast and small: [21 ms and 95 characters](bench/RESULTS.md) to read an order in the example back office,
  against 54 ms and 1,144 characters for a scripted browser reading the page in the most favourable setup.

## Built for agents

- **Answers sized for a model**: a large JSON answer comes back shortened (first items, every key, clipped texts) with the field paths
  to `pick` from; crates.io's 445,000-character answer becomes about 6,400. `pick` keeps exactly what is needed.
- **Forgiving**: arguments written at the top level instead of under `path` / `query` are accepted; a wrong sign-in selector falls back
  to the page's real field, and failures list the fields that exist.
- **Honest errors**: a bot protection page, an ended session (redirected to the sign-in page) or a changed API is reported as such,
  never returned as data.
- **Self-improving**: the agent can rename and document tools (`annotate_recipe`) and chain them (`define_macro`).

## Safe by default

- Credentials are detected (by name and by value), sent only to the host they came from, and never written to recipes.
  Secrets, saved session cookies and local state are encrypted at rest; text typed into password fields never appears in a recipe or a message.
- Deletions and risky clicks wait for confirmation; any call can be previewed with `dry_run`; at most 5 requests per second per host by default.
- Per-recipe policies (read-only, allowed hosts) cover HTTP, interface actions and streams. Every request is logged, without bodies or secrets.
- Tool results are treated as untrusted data: the agent is told never to follow instructions found in them.

## For companies and teams

Internal tools are where agents are most useful and least able to help. unwalled runs on your machines, needs no change
to the tools, and adds what IT asks for ([guide](docs/FOR-TEAMS.md)):

- an **organization policy** the agent cannot loosen: read-only everywhere, allowed hosts, confirmation level, disabled tools, mandatory audit log;
- a **shared recipe catalogue**: one person discovers a tool, the whole team uses it, everyone with their own sign-in.

## Good to know

- **Prefer official integrations when they exist.** If a service has an API, an OpenAPI file or an MCP server, use it (unwalled can import the file).
  Internal APIs change without notice; `check_recipe` detects it and repairs the recipe.
- **Not everything can be captured**: requests signed by the page's own code, data loaded by scripts in ways no call reveals, and native windows.
  Bot protections and CAPTCHAs are not bypassed: they are reported, and you can browse in a visible window instead.
- **Use it only where you are allowed to.** Calling a service's internal API can break its terms even with your own account. You are responsible for how you use it.

## Documentation

- [Full reference](docs/REFERENCE.md): how it works, every tool, guides, configuration, data and secrets, limits
- [For teams](docs/FOR-TEAMS.md): organization policy, shared catalogue, what is logged
- Benchmarks: [real agent](bench/AGENT.md), [20 real websites](bench/FIELD.md), [scripted browser](bench/RESULTS.md); method, raw data, how to rerun them
- [Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

unwalled was called universal-mcp until version 0.2: the former variable names, data folder and command still work.

## License

[MIT](LICENSE) © 2026 Korrocorp
