# unwalled — full reference

Everything about [unwalled](../README.md): how it works, every tool, guides, configuration, data, compatibility and limits.
For companies, see also [For teams](FOR-TEAMS.md).

## Contents

- [How it works](#how-it-works)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Tools reference](#tools-reference)
- [Guides](#guides)
- [Command line](#command-line)
- [Configuration](#configuration)
- [Data and secrets](#data-and-secrets)
- [Compatibility](#compatibility)
- [When to use it, and when not](#when-to-use-it-and-when-not)
- [Limitations](#limitations)
- [Responsible use](#responsible-use)
- [Development](#development)

## How it works

```text
                         discover(name, url)
                                 │
          published OpenAPI / Swagger? ──yes──► operations become tools
                                 │ no
   a real browser loads the page, runs your actions, optionally explores the site,
   and records the JSON calls it makes (REST and GraphQL, same site + extra hosts),
   the HTML forms it posts and the server-rendered pages it loads
                                 │
   inference: path templates · typed query parameters · body and variable schemas
              GraphQL operations · response shapes · secrets moved to a local store
                                 │
   recipe saved (shareable) ──► tools generated ──► tools/list_changed (no restart)
                                 │
   tool call ──► policy · confirmation · rate limit · cache ──► request with host-scoped credentials
                 (browser profile, opt-in in-page fetch, re-authentication on 401, retries)
                                 │
                 response ──► pick / page as JSON / shortened view of large answers ──► agent
```

The result is saved as a **recipe**. Discovery runs once (seconds); after that the tools are available in every session.

## Features

**Discovery**
- Three sources: live browser capture, HAR files (devtools, mitmproxy, Charles, Proxyman: mobile and desktop apps too), OpenAPI 3 / Swagger 2 (JSON or YAML, found automatically, including behind a Swagger UI page).
- REST and GraphQL: one tool per GraphQL operation with typed variables; batched and persisted (hash-only) queries supported; a raw `graphql` tool as well.
- Smart path templates: `/api/users/42` → `/api/users/{user}`; a page you visited (`/crates/serde`) turns `/api/v1/crates/serde` into `/api/v1/crates/{crate}`; sibling URLs returning the same kind of data are merged.
- Autonomous exploration (`explore_pages`): follows same-site links and clicks harmless "load more" buttons and tabs. Logout, delete, payment, add-to-cart, vote or follow links are never followed.
- Multipart uploads are recognised (file fields become a `files` argument).
- **Server-rendered tools** (Django or Rails admin, PHP back offices, wikis): pages whose HTML carries the data become `<recipe>__page_*` tools that return
  the page's tables as rows, its "label: value" fields, links and text as JSON; three or more pages of the same shape (`/wiki/A`, `/wiki/B`, `/wiki/C`) become one tool with a parameter.
  HTML forms posted during discovery become tools too.
- Sign-in steps survive guessed selectors: a `fill` or `click` aimed at a user, password or submit field that is not on the page uses the page's own field;
  when a step still fails, the page's real fields are listed. Bot protection pages are reported as such, never bypassed.

**Tools an agent can use well**
- Plain-language descriptions ("Get one crate by crate", "Search", "Create or submit order") and the values seen for each query parameter.
- The result of `discover` lists every tool with what it does and a call that works, so the agent can answer at once instead of searching the tools first.
- Large JSON answers are shown shortened (lists cut to their first items, long texts clipped) with the field paths `pick` accepts:
  crates.io's 445,000-character crate answer becomes about 6,400 characters. `max_chars` or `raw` returns the whole answer.
- Path and query values passed at the top level (`{"order": "1042"}`) are accepted, as agents often write them.
- `annotate_recipe`: the agent renames and documents tools itself, hides noise, and saves default arguments.
- `define_macro`: one tool that chains several calls, passing values from one response to the next call.
- `pick` and `max_chars` keep responses small; HTML pages come back as readable text; `save_to` writes downloads to a file.
- Above 60 generated tools, only `search_tools` and `call_tool` are listed, so the agent's context stays small.

**Calls that keep working**
- Persistent browser profile per recipe (session cookies included) and a `login` tool that opens a visible window.
- Re-authentication: on a 401 or an expired JWT, browser recipes reload the site to pick up fresh tokens; OAuth refresh tokens renew access tokens.
- Stale CSRF tokens are refreshed from cookies or meta tags, in headers and in form fields (Rails `authenticity_token`, Django `csrfmiddlewaretoken`, Laravel `_token`).
  A call redirected to the sign-in page is treated as an ended session (renewed, or reported), never as data. In-page requests (from a real page of the site) are available as an opt-in per recipe, for sites you are allowed to automate.
- Retries of temporary failures (429, 502, 503, 504, network errors) with `Retry-After` or exponential backoff; writes are retried only when the server did not process them.
- Read cache (`cache_seconds`, or per recipe), per-call timeouts (`timeout_ms`), non-secret recipe headers (language, API version).
- `check_recipe` probes every read-only tool and flags broken or changed endpoints; `repair=true` rediscovers the recipe and keeps annotations and macros.
- Interface control (`ui`) for sites without a usable API: snapshot with element refs, click, fill, read, screenshot, in the logged-in profile.

**Safety and privacy**
- Credentials are detected by name (headers, query parameters, body fields) **and by value** (JWTs, provider key formats, private keys, long random tokens, card numbers), moved to a local secret store, replayed **only to the host they came from**, and scrubbed from every recipe before it is written.
- `dry_run` previews any call; DELETE calls (or all writes, if you choose) and risky interface clicks need `confirm=true`.
- Per-recipe policies: read-only, allowed hosts, rate limit, transport, cache. Default rate limit: 5 requests per second per host.
- Audit log of every request (method, redacted URL, status), never bodies or credentials.
- Shared recipes cannot act on your behalf: stored defaults and macro steps cannot confirm calls, write or upload local files, and a macro only chains its own recipe's tools.
- Secrets, saved session cookies and local state (which holds the sign-in steps of discovery) are encrypted at rest; text typed into password fields never reaches a recipe or a message.

**More sources and protocols**
- Ready-made sources: `discover(name, "preset:<id>")` for GitHub, Stripe, Vercel, ElevenLabs, Discord, Binance (REST and live streams), CoinGecko, Open-Meteo,
  YouTube, Gmail, Drive, Sheets, Calendar and any Google API (`preset:google:<api>/<version>`); the recipe says how to give credentials when the API needs them.
  In compact mode every operation of a large API is reachable (GitHub: about 1,200 operations through `__operation` / `__call`).
- Databases: PostgreSQL (Supabase, Neon, Railway, your own server) and MySQL / MariaDB (WordPress and most web hosts):
  `import_file(name, "postgres://user:password@host:5432/db?sslmode=require")` or `"mysql://user:password@host:3306/db"` gives the same `__tables` / `__sql` tools.
  Only reading statements are sent, inside a read-only session and transaction with a statement timeout; the address (with its password) is stored with the encrypted secrets. No dependency.
- Local and remote data: CSV, TSV, Excel (`.xlsx`, one table per sheet), iCalendar (`.ics`: events, to-dos), RSS / Atom feeds (YouTube channel feeds include views and ratings),
  JSON records, JSON Lines, SQLite databases or a folder of such files
  become tables queried with read-only SQL (`<recipe>__tables`, `<recipe>__sql`), joins across files included. An http(s) address works too (published spreadsheet, private
  calendar feed, open data): it is cached and refreshed (`refresh_seconds`), and the address itself is stored with the secrets, not in the recipe.
- Google Discovery documents (YouTube Data and Analytics, Drive, Gmail, Sheets, Calendar and every other Google API), OData services (`$metadata`: SAP, Dynamics, SharePoint...), SOAP web services (WSDL), JSON-RPC (one tool per method: Ethereum and Bitcoin nodes, Kodi, Transmission, Odoo...).
- Local files with `import_file`: OpenAPI / Swagger, Postman collections (and environments), Insomnia exports, Bruno collection folders, AsyncAPI 2/3, `.http` / `.rest` files, `.env` variables, shared recipes; `import_curl` for "Copy as cURL" commands; `export_recipe` to share a recipe without its secrets.
- Realtime: WebSocket and Server-Sent Events captured with their protocol (subscribe and auth frames, in order) become tools that connect, replay the handshake and return the messages received for a chosen duration; MQTT brokers (TCP, TLS, WebSocket; wildcards, publishing).
- Responses: images (PNG, JPEG, GIF, WebP up to 2 MB, checked by signature) reach the agent as images; CSV, XML, RSS and Atom come back as JSON; protobuf and gRPC-web are decoded without schema; `pick` also takes slices (`items[0:5]`), filters (`items[?price>10]`), counts (`items.#`) and JSONPath (`$..price`); `paginate` merges pages; `watch` reports what changed.
- Encrypted secrets (AES-256-GCM, key protected by Windows DPAPI or derived from `UNWALLED_SECRET_KEY`), and compact tool lists: schemas fit a per-tool budget and recipes with more than 20 operations expose `<recipe>__operation` + `<recipe>__call` (a 62-operation Google API costs about 2 KB of tool definitions instead of 165 KB).

## Requirements

- Node.js 22 or newer.
- For browser capture, browser recipes and the `ui` tool: Google Chrome or Microsoft Edge (used automatically), or Playwright's Chromium
  (`npx playwright-core install chromium`, then `UNWALLED_BROWSER=chromium`). OpenAPI and HAR recipes do not need a browser.

## Installation

### Guided setup (recommended)

```bash
npx -y unwalled
```

Started in a terminal, unwalled runs its setup in three steps:

1. **Checks this computer**: Node.js, the browser it will use, the data folder, how secrets are encrypted.
2. **Adds unwalled to the AI apps it finds**, after asking for each one: Claude Code (through `claude mcp add --scope user`),
   Claude Desktop, Cursor, Windsurf, VS Code (`mcp.json`, used by Copilot's agent mode), Gemini CLI and Codex CLI.
   Configuration files are changed only when they are plain JSON (a file with comments is left as it is, and the entry to paste is shown);
   a copy of each file is kept next to it as `<file>.unwalled-backup`. It then says how each app loads the change (a new session, a restart).
3. **Connects a first source**: a website or internal app (in a window where you sign in and open the pages your agent will use),
   a file or folder, a database, a ready-made service (it asks for the key without showing it), or the demo back office.

`unwalled setup --yes` adds unwalled to every app found without questions (for scripts); `unwalled setup --remove` removes it from all of them
(recipes and secrets stay in the data folder). `unwalled doctor` runs the checks again at any time.

The apps start unwalled the way you ran it: through `npx` when you ran it with `npx` (with `cmd /c` on Windows), otherwise by the full paths
of Node.js and of `bin/unwalled.js`, which work even for apps that do not see your shell's `PATH` (Claude Desktop on macOS).

### Claude Code

```bash
claude mcp add --scope user unwalled -- npx -y unwalled
```

### Claude Desktop, Cursor, Windsurf and other MCP clients

```json
{
  "mcpServers": {
    "unwalled": {
      "command": "npx",
      "args": ["-y", "unwalled"]
    }
  }
}
```

On Windows, some clients cannot start `npx` directly: use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "unwalled"]`.

The key differs in a few apps: VS Code's `mcp.json` uses `"servers"` instead of `"mcpServers"`; Codex CLI reads TOML
(`[mcp_servers.unwalled]`, `command = "npx"`, `args = ["-y", "unwalled"]`). Any client that can start a stdio MCP server works the same way
(Zed, Cline, Continue, OpenCode, an agent built on an MCP SDK), whatever model it runs: the tools are plain MCP, and their schemas avoid
the JSON Schema features some model providers reject (`$ref`, `allOf`, type lists...).

The development version (the repository's `main` branch) runs with `npx -y github:KorroAi/unwalled`.

### From source

```bash
git clone https://github.com/KorroAi/unwalled.git
cd unwalled
npm install
node bin/unwalled.js setup
```

## Quick start

**Try it in one minute** with the demo back office (orders and customers behind a sign-in, on your machine):

```bash
unwalled demo        # or: npx -y unwalled demo
```

It starts the back office, discovers it (signing in as alice, opening an order and two customer pages) and prints the question to ask
your agent: *"Using acme, what is the status and total of order 1042? And which customers are in Lyon?"*. Keep it running while you try.

**Connect your own sources** from the terminal with one command; the kind of source is detected:

```bash
unwalled add https://erp.example.com --browse     # a window opens: sign in, open the pages your agent will use, close it
unwalled add https://crates.io --explore 10       # public site: no window, follows up to 10 links
unwalled add ./sales-2026.xlsx                    # a file or folder (CSV, Excel, JSON, SQLite, iCalendar...)
unwalled add ./openapi.yaml --base-url https://api.example.com   # API descriptions, Postman, Insomnia, Bruno, HAR, cURL lists
unwalled add postgres://reader:secret@db.example.com/shop        # a database, read-only
unwalled add preset:github && unwalled key github # a ready-made service, then its token (typed without being shown)
```

The name of the recipe comes from the source (`erp`, `sales-2026`, `shop`...; `--name` sets another one), and an existing recipe is never
replaced by `add` (use `--merge` to add to it).

**Or ask your agent in plain language:**

> Use unwalled to discover https://example.com, search for "lamp" and open the first product, then tell me its price.

The agent calls `discover` (with actions such as filling the search box), then the generated `<recipe>__*` tools.
For a site behind a sign-in, give the agent the sign-in details: it passes them as `discover` actions (guessed selectors are matched to the page's own fields).
Or ask it to call `login`: a window opens, you sign in yourself, and the cookies are kept.
After a few calls, ask it to `annotate_recipe` the tools it used and to `define_macro` the sequences you repeat.

## Tools reference

### Management tools

| Tool | What it does |
| --- | --- |
| `discover` | Creates a recipe from a URL. Options: `mode` (`auto`, `openapi`, `browser`), `actions`, `explore_pages`, `interactive`, `duration_seconds`, `hosts` (extra API hosts), `include` (OpenAPI operation filter), `max_endpoints`, `merge`. |
| `discover_har` | Creates a recipe from a `.har` file (absolute path). |
| `import_file` | Creates a recipe from a local file or folder: OpenAPI / Swagger, Google Discovery document, OData `$metadata` or WSDL (with `base_url`), Postman collection, Insomnia export, Bruno collection, `.http` / `.rest` file, HAR, or a recipe shared with `export_recipe`. Options: `base_url`, `variables`, `variables_file` (Postman environment, Insomnia export, `.env`, JSON), `environment` (Bruno), `include`. |
| `import_curl` | Creates tools from cURL commands (devtools "Copy as cURL", bash or Windows cmd). Nothing is sent while importing; credentials go to local secrets. |
| `oauth_login` | First OAuth sign-in (authorization code + PKCE): the consent page opens in a visible window, then the token is stored for the API host and refreshed automatically. `provider`: google, github, microsoft, spotify, or `authorize_url` + `token_url`. |
| `export_recipe` | Writes a recipe (never its secrets) to a JSON file. |
| `watch` | Calls a read-only generated tool every `interval_seconds` for up to `duration_seconds`, and returns the changes (field by field for JSON); `until` stops early. |
| `login` | Opens a visible browser on the recipe's profile so you can sign in (or solve a challenge); cookies are kept. |
| `set_credentials` | Stores headers (or `?name` query parameters) sent to one host, e.g. `{"authorization": "Bearer ..."}`. |
| `configure_recipe` | Local `policy` (`readOnly`, `confirm`, `allowedHosts`, `rateLimit`, `transport`, `cacheSeconds`), `oauth` refresh settings, non-secret `headers`. |
| `annotate_recipe` | Names, descriptions, parameter hints, `hidden` and `defaults` for the generated tools (saved in the recipe). |
| `define_macro` | Creates a tool that chains several calls (`{{params.x}}`, `{{steps.name.path}}` placeholders). |
| `check_recipe` | Health check of the read-only tools; `repair=true` rediscovers the recipe. |
| `ui` | Drives the site's interface: `open`, `snapshot`, `act`, `read`, `screenshot`, `close`. |
| `list_recipes` | Lists recipes, endpoints, macros and tools. |
| `inspect_recipe` | Shows a recipe in detail, its local policy and last health check, with credential header names (never values). |
| `forget` | Deletes a recipe, its credentials and local state; `delete_profile` also removes its cookies. |
| `search_tools` / `call_tool` | Find generated tools by keyword (optionally `pin` them) and run them. |

### Generated tools

| Recipe type | Tools |
| --- | --- |
| Browser / HAR | one tool per REST endpoint (`<recipe>__get_api_items_item`), one per GraphQL operation (`<recipe>__gql_GetCart`), `<recipe>__graphql` when GraphQL is used, one per server-rendered page template (`<recipe>__page_customers_customer`), and `<recipe>__request` |
| OpenAPI | one tool per operation (up to 60 by default), `<recipe>__routes` to list every route, and `<recipe>__request` |
| Any | one tool per macro: `<recipe>__m_<id>` |

Generated tools take `path`, `query` and `body` (or `variables` and an optional replacement `query` document for GraphQL).
REST tools also accept path and query values at the top level (`{"order": "1042"}` for `{"path": {"order": "1042"}}`), a common agent habit. Plus:

| Argument | Meaning |
| --- | --- |
| `pick` | Comma-separated paths into the JSON response: `data.items[*].name`, `items.*.id`, `meta.total, data.user`. |
| `max_chars` | Maximum characters returned (default 40,000). Giving it also turns off the shortened view of large answers. |
| `save_to` | Absolute path where the response body is written (downloads, binary files). |
| `raw` | Return HTML as-is (by default HTML pages are turned into readable text, and page tools into JSON). |
| `dry_run` | Show the request that would be sent, credentials hidden, without sending it. |
| `confirm` | Confirm a call held by the safety policy (DELETE by default). |
| `cache_seconds` | Reads only: reuse a response fetched less than this many seconds ago. |
| `timeout_ms` | Timeout of this call (1 s to 5 min). |
| `files` | Multipart endpoints and `__request`: form field name → absolute file path to upload. |

`<recipe>__request` sends any request (absolute URL, or a path relative to the recipe's base URL) with the recipe's cookies and credentials;
`body_kind` is `json` (default), `form`, `text`, `multipart` or `base64`.

## Guides

### Browser actions and exploration

`actions` is a list of steps run after the page loads. Each step has exactly one key:

```json
[
  { "click": "#accept-cookies" },
  { "fill": "input[name=q]", "text": "lamp" },
  { "press": "Enter" },
  { "waitFor": ".results" },
  { "goto": "/product/blue-lamp" },
  { "scroll": 3000 },
  { "wait": 1000 }
]
```

Values you type or navigate to are recognised in API paths and become parameters. Text typed into password-like fields is hidden from progress messages.
Agents write these selectors without seeing the page: when a `fill` or `click` selector is not on the page and names a sign-in field
(user, email, login, password, submit...), the page's own field of that kind is used and the substitution is reported. When a step still fails,
the result lists the page's real fields with a selector for each, so the agent can retry.
If the site shows a bot protection page instead of its content, the result says so (`Blocked: ...`) rather than reporting an empty page.
For flows that are hard to script, use `interactive: true`: a window opens, you browse, and the capture ends when you close it.
`explore_pages: 10` additionally visits up to 10 same-site pages (waiting between pages to respect the rate limit) and reports how many new API calls each page revealed.

### Interface control

When a site has no usable API (server-rendered pages, requests signed by the page's code), `ui` drives its interface in the recipe's browser profile:

```text
ui(name="shop", action="open", url="https://shop.example/catalogue")   → [e3] text input "Find" … [e4] button "Find"
ui(name="shop", action="act", steps=[{"fill": "e3", "text": "lamp"}, {"click": "e4"}])   → step log + new snapshot
ui(name="shop", action="read", selector="main")   → page text
ui(name="shop", action="screenshot")   → PNG image (or save_to)
```

Steps: `click`, `fill` (+`text`), `select` (+`value`), `check`, `uncheck`, `press`, `hover`, `goto`, `wait`, `waitFor`, `scroll`, addressed by ref or CSS selector.
Clicks on controls labelled delete, pay, buy, send, confirm… are held until `confirm=true`. `visible=true` shows the window.
When the page is a bot check (CAPTCHA, challenge), snapshots and reads start with a `Blocked:` line: open it with `visible=true` and let a person solve it.

### Pagination, streams and MQTT

Read-only tools also accept:

- `paginate`: `{ "max_pages": 5, "max_items": 1000, "items_path": "data.items" }`. Follows next-page tokens and URLs found in the response
  (`nextPageToken`, `next_cursor`, `links.next`, `pageInfo.endCursor`...), otherwise increments a page number or offset passed in `query`
  (`{"page": 1}`, `{"offset": 0}`), and returns the merged items. `pick` then applies to each item.

Stream tools accept `duration_seconds` (default 10), `max_messages` (default 50), `filter` (text or `/regex/`), `pick` (applied to each JSON message),
`query` (override URL parameters) and, for WebSockets, `send` (extra frames) and `skip_captured_frames`.
Common heartbeats are answered automatically (Engine.IO / Socket.IO, graphql-ws and JSON `ping`).
MQTT tools take `topics` (wildcards `+` and `#`) and `publish` (`[{"topic", "message", "retain"}]`); credentials come from `set_credentials(host, {"mqtt-username": ..., "mqtt-password": ...})`
or from the URL (`mqtt://user:password@host`). Messages are returned as `{"topic", "payload"}`, so `pick="payload.celsius"` works.

`<recipe>__request` sends any request (absolute URL, or a path relative to the recipe's base URL) with the recipe's cookies and credentials.

Imported SOAP services get one tool per operation taking `params` as JSON (sent as XML; the SOAP Body comes back as JSON and a Fault is an error),
JSON-RPC methods one tool each plus `<recipe>__rpc`, and streams one tool each plus `<recipe>__stream` for any `ws(s)://`, event-stream or `mqtt(s)://` URL.

### Annotations, defaults and macros

After trying the generated tools, the agent can make them easier to use; the result is saved in the recipe and shared with it:

```json
annotate_recipe {"name": "shop", "annotations": {
  "shop__get_api_search": {"name": "search_products", "description": "Search the catalogue", "params": {"query.q": "Search text"}},
  "shop__get_api_products": {"defaults": {"query": {"limit": 50}}},
  "shop__get_api_debug": {"hidden": true}
}}

define_macro {"name": "shop", "macro": {
  "id": "first_result_price", "description": "Price of the first search result",
  "params": {"q": {"type": "string", "required": true}},
  "steps": [
    {"tool": "search_products", "args": {"query": {"q": "{{params.q}}"}}, "as": "search"},
    {"tool": "get_api_products_product", "args": {"path": {"product": "{{steps.search.results[0].id}}"}}}
  ],
  "result": "{{steps.1.price}}"
}}
```

This creates `shop__m_first_result_price(q)`. Defaults are merged one level deep and explicit arguments win.
Stored defaults and macro steps may only contain `path`, `query`, `body`, `variables`, `header`, `pick`, `max_chars`, `raw`, `cache_seconds`, `timeout_ms`, `operationName` and `filter`;
confirmation is given by calling the macro itself with `confirm=true`.

### HAR captures

- **Chrome / Edge**: DevTools → Network → use the app → right-click → *Save all as HAR with content*.
- **mitmproxy** (mobile and desktop apps): `mitmdump --set hardump=./capture.har`, route the device through the proxy, use the app, stop mitmdump.
- **Charles / Proxyman**: export the session as HAR.

Then: `discover_har(name="myapp", har_path="/absolute/path/capture.har")`.
Cookies and credentials found in the file are stored as local secrets and replayed to their original hosts; the recipe keeps only the file name.

### Safety

- **Confirmation**: DELETE calls (and the interface's risky clicks) return a preview and wait for `confirm=true`. `UNWALLED_CONFIRM=writes` extends this to every write; `none` disables it. Per recipe: `configure_recipe {"name": "x", "policy": {"confirm": "writes"}}`.
- **Read-only recipes**: `{"policy": {"readOnly": true}}` refuses every write and interface action. Stream tools count as writes when they send frames or publish MQTT messages; listening stays allowed.
- **Allowed hosts**: `{"policy": {"allowedHosts": ["api.example.com"]}}`.
- **Rate limit**: 5 requests per second per host by default (`UNWALLED_RATE_LIMIT`, or `policy.rateLimit`); retries, macros and exploration go through it.
- **Dry runs**: any generated tool with `dry_run: true` shows the exact request, credentials replaced by `<stored secret>`.
- **Audit log**: `<home>/audit.log` (JSON Lines, rotated at 5 MB) records time, recipe, tool, method, redacted URL, status, transport, retries, cache hits and re-authentication. `UNWALLED_AUDIT=0` disables it.
- **Organization policy**: rules set by an administrator for every recipe, which the agent cannot loosen (read-only, allowed hosts, confirmation, disabled tools, mandatory audit). See [For teams](FOR-TEAMS.md).

### Staying logged in

- **Browser recipes**: on a 401, or before sending a bearer JWT that has expired, the site is reloaded headlessly in the recipe's profile and the auth headers the app sends are kept. A failed attempt is not repeated for 30 seconds. If the session itself has ended, call `login`.
- **OAuth**: `configure_recipe {"name": "x", "oauth": {"host": "api.example.com", "token_url": "https://auth.example.com/oauth/token", "refresh_token": "...", "client_id": "..."}}`. Access tokens are refreshed on 401 and before expiry; rotated refresh tokens are kept.
- **Bot challenges**: requests leave from Node by default and a challenge is reported with a hint. If you are allowed to automate the site, `configure_recipe {"policy": {"transport": "auto"}}`
  retries from inside a real page after a challenge (`"page"` always uses the page). If a CAPTCHA still blocks, `login` lets you solve it.
- **Form CSRF tokens**: when an endpoint was captured with a token field in its body (`authenticity_token`, `csrfmiddlewaretoken`, `_token`, `_csrf`...)
  and a call does not give one, the session's current token is read from the site's page (`<meta name="csrf-token">`) or its CSRF cookie and added.
  Rails, Django and Laravel forms work without the agent knowing about the token.

### When the site changes

`check_recipe {"name": "shop"}` calls each read-only tool with the example recorded at discovery and reports `ok`, `changed` (fields missing), `broken` (errors, GraphQL errors) or `auth`.
`check_recipe {"name": "shop", "repair": true}` rediscovers from the original inputs (kept locally, actions and merged captures included) and lists added and removed tools; annotations and macros are kept.
`unwalled check shop` does the same from the terminal and exits with code 1 when something is broken, which suits a scheduled job.

### Many tools

With `UNWALLED_TOOL_MODE=auto` (default), when recipes generate more than 60 tools (`UNWALLED_TOOL_THRESHOLD`) only the management tools are listed.
The agent finds tools with `search_tools` (`pin: true` lists them from then on) and runs them with `call_tool`. `all` always lists everything; `search` never lists generated tools.

### Google APIs (YouTube, Drive, Gmail...)

Google publishes its APIs as Discovery documents, which `discover` reads like OpenAPI:

```text
discover(name="youtube", url="https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest", include="search_list|videos_list|channels_list")
set_credentials(name="youtube", host="youtube.googleapis.com", headers={"x-goog-api-key": "<your API key>"})
youtube__youtube_search_list(query={"part": ["snippet"], "q": "bitcoin", "maxResults": 5}, pick="items[*].snippet.title")
```

The list of documents is at `https://www.googleapis.com/discovery/v1/apis`. Public data needs an API key from the Google Cloud console;
your own data (YouTube Analytics, Drive, Gmail) needs an OAuth access token: `set_credentials(..., headers={"authorization": "Bearer <token>"})`.

### Importing API files

```text
import_file(name="stripe", path="/abs/path/openapi.yaml")
import_file(name="team-api", path="/abs/path/Team.postman_collection.json", variables={"baseUrl": "https://api.example.com"})
import_file(name="shop", path="/abs/path/bruno/shop", environment="prod")
import_file(name="api", path="/abs/path/requests.http", variables={"host": "https://api.example.com"})
import_file(name="team", path="/abs/path/Team.postman_collection.json", variables_file="/abs/path/Prod.postman_environment.json")
import_file(name="ticker", path="/abs/path/asyncapi.yaml")                # WebSocket channels -> stream tools
discover(name="erp", url="https://erp.example.com/odata/v4/sales/")      # OData: finds $metadata
discover(name="calc", url="http://www.dneonline.com/calculator.asmx")    # SOAP: finds ?wsdl
import_file(name="sales", path="/abs/path/exports")                     # folder of CSV / Excel / JSON / SQLite files -> SQL tables
import_file(name="agenda", path="https://calendar.example.com/private-.../basic.ics", refresh_seconds=600)
export_recipe(name="shop", path="/abs/path/shop-recipe.json")   # share it; the receiver runs import_file
```

### Compact mode and search mode

Recipes with more than 20 operations (`UNWALLED_FOLD_THRESHOLD`) expose `<recipe>__operation` (list operations, or read one's parameters) and `<recipe>__call`
instead of one tool per operation; tool schemas are also compacted to `UNWALLED_SCHEMA_CHARS`. Search mode (above) still applies to the remaining tools.

## Command line

```bash
npx -y unwalled --help
unwalled setup                      # guided setup (also what "unwalled" alone does in a terminal)
unwalled setup --remove             # remove unwalled from every AI app
unwalled doctor                     # checks: Node.js, browser, data folder, encryption, AI apps
unwalled demo --port 8099           # demo back office, discovered as the "acme" recipe
unwalled add <address | file | folder | database | preset:<id>> [--name <name>] [--browse] [--explore <pages>] [--base-url <url>] [--merge]
unwalled key github                 # store the token a service needs (not shown; or piped: echo "$TOKEN" | unwalled key github)
unwalled discover crates "https://crates.io/search?q=serde" --actions '[{"goto":"/crates/serde"}]'
unwalled discover shop https://shop.example --explore 10
unwalled har myapp ./capture.har --host api.myapp.com
unwalled import team-api ./Team.postman_collection.json --base-url https://api.example.com
unwalled export crates ./crates-recipe.json
unwalled curl myapi ./commands.txt
unwalled login github https://github.com/login
unwalled check crates --repair
unwalled list
unwalled inspect crates
unwalled forget crates --delete-profile
```

Without a command, `unwalled` runs the guided setup when it is started from a terminal, and the MCP server on stdio otherwise
(MCP clients start it with pipes). `unwalled serve` always runs the server.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `UNWALLED_HOME` | `~/.unwalled` | Data directory |
| `UNWALLED_BROWSER` | `chrome` | `chrome`, `msedge`, `chromium` (Playwright) or an absolute path to a Chromium-based browser. `chrome` falls back to Edge, then Playwright's Chromium. |
| `UNWALLED_MAX_OUTPUT` | `40000` | Default maximum characters per tool result |
| `UNWALLED_COMPACT_CHARS` | `6000` | Unpicked JSON answers longer than this are shown shortened, with their field paths (`0` = always in full) |
| `UNWALLED_TIMEOUT_MS` | `30000` | Request timeout |
| `UNWALLED_MAX_ENDPOINTS` | `40` | Endpoints kept per browser/HAR recipe (most frequent first) |
| `UNWALLED_MAX_OPENAPI_TOOLS` | `60` | Operations turned into tools per OpenAPI recipe |
| `UNWALLED_CONFIRM` | `destructive` | Calls that need `confirm=true`: `destructive` (DELETE), `writes` (anything but reads) or `none` |
| `UNWALLED_RETRIES` | `2` | Automatic retries of temporary failures |
| `UNWALLED_RATE_LIMIT` | `5` | Requests per second per host (`0` = unlimited) |
| `UNWALLED_TOOL_MODE` | `auto` | `auto` (search mode above the threshold), `all` or `search` |
| `UNWALLED_TOOL_THRESHOLD` | `60` | Generated tools listed before `auto` switches to search mode |
| `UNWALLED_AUDIT` | on | `0` disables the audit log |
| `UNWALLED_SECRET_KEY` | (unset) | Passphrase for the encryption key of secrets, saved cookies and local state. Unset: Windows DPAPI, or a key file next to the data elsewhere |
| `UNWALLED_PLAINTEXT_SECRETS` | (unset) | `1` stores secrets, cookies and state unencrypted (not recommended) |
| `UNWALLED_SCHEMA_CHARS` | `3000` | Budget of one tool's description + input schema |
| `UNWALLED_FOLD_THRESHOLD` | `20` | Above this many operations a recipe uses compact mode (`0` = never) |
| `UNWALLED_ORG_POLICY` | (unset) | Path of an organization policy that agents cannot loosen: see [For teams](FOR-TEAMS.md) |
| `UNWALLED_TEAM_RECIPES` | (unset) | Shared, read-only recipe folder of a team: see [For teams](FOR-TEAMS.md) |

The project used to be called universal-mcp: `UNIVERSAL_MCP_*` variables are still read, an existing `~/.universal-mcp`
data directory is still used, and the `universal-mcp` command remains as an alias.

## Data and secrets

```text
~/.unwalled/
  recipes/<name>.json    shareable: endpoints, schemas, redacted examples, annotations, macros
  secrets/<name>.json    local only, encrypted: auth headers, API keys, cookies from HAR, secret query and path values, OAuth refresh settings
  secret.key.dpapi       Windows: the encryption key, protected for the current user (secret.key elsewhere)
  profiles/<name>/       local only: browser profile, and saved session cookies (encrypted)
  state/<name>.json      local only, encrypted: policy, recipe headers, original discovery inputs with their sign-in steps (for re-authentication and repair), last health check
  audit.log              local only: one line per request, no bodies or credentials
```

Before a recipe is written, credentials are detected by name and by value and moved to `secrets/`, and every stored secret value, as well as any text typed
into a password field during discovery, is scrubbed from the recipe.
A leak test covers 28 placements (headers, query, path, fragments, `user:password@`, JSON and form bodies, arrays, GraphQL documents and variables, free text).
Treat `secrets/`, `profiles/` and `state/` like a password store: do not commit, sync or share them. See [SECURITY.md](../SECURITY.md).

## Compatibility

What is covered, and how it was checked. "Live" means a real public service in `test/live/` (run with `UNWALLED_LIVE=1`);
"local" means a local test server or file in the offline suite. Anything not listed here is not claimed.

| Source | Checked against | Known limits |
| --- | --- | --- |
| Browser capture (REST, GraphQL) | live: crates.io, Hacker News search (Algolia), and a field test of 20 public sites ([bench/FIELD.md](../bench/FIELD.md)); real Grafana 12 in Docker behind a sign-in, with its session token rotating every minute (`test/live/grafana.test.js`); local: login with guessed selectors, CSRF in headers and form fields, token rotation, ended sessions | Bot protections are reported, not bypassed |
| Server-rendered pages and HTML forms | live: Docker Hub search (field test); local: a Django-style customer list, detail page and form with a CSRF field (`test/e2e/intranet.e2e.test.js`) | Tables, definition lists and "label: value" lines are extracted; layouts built only from styled `div`s come back as text |
| OpenAPI 3 / Swagger 2 | live: Petstore, GitHub (about 1,200 operations), presets | |
| Google Discovery (YouTube, Gmail, Drive...) | live: YouTube Data API description and call (API key needed for answers) | User data needs an OAuth client of your own |
| OData v2 / v4 | live: Northwind demo service | No `$batch` |
| SOAP 1.1 / 1.2 (WSDL) | live: public calculator service | No WS-Security, no external XSD imports |
| WebSocket / Server-Sent Events | live: Binance trade stream; local: auth frames, cookies, heartbeats | Replayed from Node; event streams read with `fetch()` have no samples |
| AsyncAPI 2 / 3 | live: Binance streams preset; local: WebSocket and MQTT channels | |
| MQTT 3.1.1 | local broker: wildcards, publishing, credentials, QoS 0 / 1 | No MQTT 5 |
| JSON-RPC 1.0 / 2.0 | local server (single and batch calls) | |
| Postman, Insomnia, Bruno, `.http`, cURL, HAR | local servers and files | Postman scripts and Bruno scripts are not run |
| Local / remote data (CSV, TSV, Excel, iCalendar, RSS / Atom, JSON, SQLite) | live: GitHub-hosted CSV, YouTube channel feed, Hacker News RSS; local files | Read-only SQL; Excel dates stay serial numbers |
| PostgreSQL (`postgres://...`) | real PostgreSQL 17 in Docker: TLS (require / prefer / disable), SCRAM, types, read-only, timeouts (`test/live/postgres.test.js`) | Read-only by design |
| MySQL / MariaDB (`mysql://`, `mariadb://`) | real MySQL 8.4 and MariaDB 11 in Docker, with and without TLS (caching_sha2_password over TLS or RSA, mysql_native_password) (`test/live/mysql.test.js`) | Read-only by design; `?` parameters are escaped client-side; MariaDB JSON arrives as text |
| OAuth sign-in (`oauth_login`) | local provider through a real browser (PKCE, refresh) | Needs an OAuth client created by the user |
| Responses: protobuf, gRPC-web, CSV, XML, images | local | Protobuf decoded without schema |

## When to use it, and when not

- **Prefer an official option when there is one.** If a service publishes an API, an OpenAPI description or an MCP server, use it
  (unwalled can import the description): it is documented, stable and allowed. Captured internal APIs change without notice.
- **Good fits**: your own tools and dashboards, internal company apps, APIs documented only as Postman/Insomnia/Bruno/.http/cURL
  collections, OData and SOAP services, devices on your network (MQTT, local web interfaces), public data APIs.
- **Poor fits**: sites that forbid automated access in their terms, and anything where an account ban would hurt.

## Limitations

- **Desktop and native apps** are reached through their network traffic only (HAR capture through a proxy). unwalled does not drive native windows or programs.
- **Requests signed by the page's own code** (an HMAC computed in JavaScript for each call) cannot be replayed from captured examples; use `ui` for those flows.
- **Binary protocols**: protobuf and gRPC-web responses are decoded without their .proto schema, so fields appear by number and types are guessed; binary bodies can be sent (`body_kind: "base64"`) and saved (`save_to`).
- **Streams are bounded**: MCP is request/response, so stream tools and `watch` listen for a limited time and return what they saw; long calls may hit the MCP client's tool timeout.
  Stream replays come from Node, not from the page: servers that require a browser-only handshake may refuse them. Event streams read with `fetch()` are recorded without sample messages.
- **Approximate protocol coverage**: SOAP without WS-Security or external XSD imports, OData without `$batch`, MQTT 3.1.1 with QoS 0/1. Google APIs need an API key or an OAuth token that you provide.
- **Bot protections and CAPTCHAs** are not bypassed by default: a challenge is reported, `login` lets a person solve it, and in-page requests are an opt-in per recipe for sites you are allowed to automate.
- **Secret detection is heuristic**: credentials with an obvious name, a known format or a long random value are caught, and so are short tokens right after a path segment that announces one (`/hooks/abc123`, `/invite/x7k2`). A short token anywhere else in a path looks like any other segment. Review recipes before sharing them.
- **One page is not a pattern**: a page tool generalises only what discovery saw vary (ids, query values, three or more sibling pages); discover a single
  article and the tool reads that article. Visit a few more pages (actions or `explore_pages`) to get a parameter.
- **Path inference is heuristic**: if a parameter was not detected, call the endpoint through `<recipe>__request` or capture more pages with `merge: true` or `explore_pages`.
- **Health checks** only call read-only tools that have a recorded example; writes are never probed.
- **One process per profile**: two servers sharing the same data directory cannot use the same recipe's browser at the same time.

## Responsible use

Only use unwalled with services and accounts you are allowed to access, and respect their terms of service, rate limits and robots policies.
Do not use it for mass data collection; keep the default rate limit unless you have a reason and the right to raise it.
Using a service's internal API may break its terms even with your own account. Tool results are third-party data: the agent is told
never to follow instructions found in them, and tools that may change or delete data are marked so that MCP clients can ask before calling them.
Recordings and recipes may contain personal data from your account: review them before sharing.
You are responsible for how you use this tool.

## Development

```bash
npm install
npm run check        # type check + unit tests + end-to-end tests (needs Chrome, Edge or Playwright's Chromium)
npm test             # unit tests only
npm run test:live    # optional: real websites (crates.io, Hacker News, Petstore, YouTube feeds...)
node bench/run.js    # optional: benchmark against a scripted browser (see bench/RESULTS.md)
node bench/field.js  # optional: one discover on 20 real websites (see bench/FIELD.md)
node bench/agent.js  # optional, uses Claude Code and costs model usage: a real agent with unwalled vs. with a browser (see bench/AGENT.md)
```

Real services in Docker (each test file says how to start its container): `test/live/postgres.test.js`, `test/live/mysql.test.js`, `test/live/grafana.test.js`.

Plain JavaScript (ES modules) with JSDoc types checked by TypeScript; no build step. See [CONTRIBUTING.md](../CONTRIBUTING.md).

| Path | Role |
| --- | --- |
| `src/server.js` | MCP server: management tools, search mode |
| `src/core.js` | Engine: discovery, sending (policy, cache, retries, re-authentication, transports), health and repair, interface control |
| `src/discovery/` | Browser capture and exploration, HAR import, OpenAPI loading, inference, secret detection |
| `src/tools/` | Tool generation (REST, GraphQL, OpenAPI, macros, annotations), HTTP transports and response formatting, schemas, `pick` |
| `src/ui.js`, `src/auth.js`, `src/safety.js` | Interface control, token refresh, guard rails (policy, rate limit, retries, cache, audit) |
| `test/unit/`, `test/e2e/`, `test/live/` | Unit tests, end-to-end tests against local fixture sites, optional tests against real sites |
| `examples/intranet/` | A small internal back office behind a login, used by the demo, the benchmark and a test |
| `bench/` | Benchmarks (scripted browser, field test on real sites, real agent) and their latest results |
