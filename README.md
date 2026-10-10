# unwalled

**Open any website, internal tool, API, file or database to your AI agent, as typed MCP tools. No API needed.**

Most of the software people use every day has no public API: the back office, the supplier portal, the intranet,
the SaaS dashboard. Yet every one of them talks to an internal API. unwalled watches a real browser use the app once,
finds those calls, and gives them to your agent (Claude, Cursor, any MCP client) as documented tools that keep working:
it stays signed in, retries, and detects and repairs tools when the app changes.

![An agent signs in to an internal back office once, then answers questions through generated tools](docs/demo.gif)

<sub>Recorded with [`docs/demo/make-gif.js`](docs/demo/make-gif.js): real calls against the [example back office](examples/intranet/server.js).</sub>

## Why not just let the agent use a browser?

Browser agents look at the page and click, every time. unwalled looks once, then calls what the page calls.
On the same questions, against a scripted browser set up as favourably as possible
(already open, already signed in, page read the instant the answer appears; [method and raw data](bench/RESULTS.md)):

| Task | unwalled | Browser, best case | Difference |
| --- | --- | --- | --- |
| Internal back office behind a login (local) | 17 ms · 95 characters to read | 52 ms · 1,064 characters | 3× faster, 11× less to read |
| crates.io, latest version of a crate (live) | 267 ms · 126 characters | 468 ms · 9,521 characters | 1.8× faster, 76× less to read |
| Hacker News search, top story (live) | 80 ms · 469 characters | 454 ms · 30,394 characters | 5.7× faster, 65× less to read |

Every answer on both sides was checked against an independent source: 60/60 correct for each.
A real browser agent also spends model turns deciding what to do on each page; these numbers leave that out.
The cost on the unwalled side is one discovery per site (about 5 to 8 seconds here).

## Install

```bash
claude mcp add unwalled -- npx -y github:KorroAi/unwalled
```

Other MCP clients (Claude Desktop, Cursor, Windsurf...):

```json
{ "mcpServers": { "unwalled": { "command": "npx", "args": ["-y", "github:KorroAi/unwalled"] } } }
```

Needs Node.js 22+, and Chrome or Edge for browser capture (or `npx playwright-core install chromium` with `UNWALLED_BROWSER=chromium`).
On Windows, some clients need `"command": "cmd"` with `"args": ["/c", "npx", "-y", "github:KorroAi/unwalled"]`.

## Use it

Ask your agent in plain language:

> Use unwalled to discover https://crates.io/search?q=serde, then tell me the latest version of tokio.

> Discover our back office at https://erp.example.internal: I'll sign in, then show me the open orders.

> Import this Postman collection / OpenAPI file / CSV / postgres://… and answer from it.

The agent calls `discover` (or `login` first for sites behind a sign-in), then the generated `<name>__*` tools.
Recipes are saved: the tools are there in every later session.

## What it connects

| Source | How |
| --- | --- |
| Websites and web apps, including behind a login | Browser capture of their REST and GraphQL calls; `ui` tool for screens with no usable API |
| Mobile and desktop apps | HAR captures (mitmproxy, Charles, Proxyman, devtools) |
| Documented APIs | OpenAPI / Swagger (found automatically), Postman, Insomnia, Bruno, `.http`, cURL, Google APIs, OData, SOAP, JSON-RPC, AsyncAPI |
| Ready-made sources | `preset:github`, `stripe`, `vercel`, `elevenlabs`, `discord`, `binance`, `coingecko`, `open-meteo`, any Google API |
| Data | CSV, Excel, iCalendar, RSS / Atom, JSON, SQLite, PostgreSQL, MySQL / MariaDB, queried with read-only SQL |
| Live streams | WebSocket, Server-Sent Events, MQTT |

How each source was checked (most against real services) and its known limits: [compatibility table](docs/REFERENCE.md#compatibility).

## Safe by default

- Credentials are detected (by name and by value), encrypted at rest, sent only to the host they came from, and never written to recipes.
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
- **Not everything can be captured**: server-rendered pages without API calls, requests signed by the page's own code, and native windows.
  Bot protections and CAPTCHAs are not bypassed.
- **Use it only where you are allowed to.** Calling a service's internal API can break its terms even with your own account. You are responsible for how you use it.

## Documentation

- [Full reference](docs/REFERENCE.md): how it works, every tool, guides, configuration, data and secrets, limits
- [For teams](docs/FOR-TEAMS.md): organization policy, shared catalogue, what is logged
- [Benchmark](bench/RESULTS.md): method, results, how to rerun it
- [Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

unwalled was called universal-mcp until version 0.2: the former variable names, data folder and command still work.

## License

[MIT](LICENSE) © 2026 Korrocorp
