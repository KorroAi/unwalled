# universal-mcp

**Turn any website, HAR capture or OpenAPI spec into MCP tools. Discover once, call forever.**

Most websites and apps have no public API and no MCP server, yet they all talk to an internal API.
`universal-mcp` finds that API and gives it to your agent as typed, documented tools, and keeps them working:
it stays logged in, gets through bot checks, retries temporary failures, notices when the site changes and repairs itself.
When a site has no usable API at all, the agent can still use it through its interface.

```text
you:    Discover crates.io from https://crates.io/search?q=serde, then open the serde page.
agent:  discover(name="crates", url=..., actions=[{"goto": "/crates/serde"}])
        → 5 endpoints: crates__get_api_v1_crates, crates__get_api_v1_crates_crate, ...
you:    What is the latest version of tokio?
agent:  crates__get_api_v1_crates_crate(path={"crate": "tokio"}, pick="crate.max_version")
```

## Contents

- [How it works](#how-it-works)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Tools reference](#tools-reference)
- [Guides](#guides): browser actions and exploration · interface control · annotations, defaults and macros · HAR captures · safety · staying logged in · when the site changes · many tools
- [Command line](#command-line)
- [Configuration](#configuration)
- [Data and secrets](#data-and-secrets)
- [Limitations](#limitations)
- [Responsible use](#responsible-use)
- [Development](#development)
- [License](#license)

## How it works

```text
                         discover(name, url)
                                 │
          published OpenAPI / Swagger? ──yes──► operations become tools
                                 │ no
   a real browser loads the page, runs your actions, optionally explores the site,
   and records the JSON calls it makes (REST and GraphQL, same site + extra hosts)
                                 │
   inference: path templates · typed query parameters · body and variable schemas
              GraphQL operations · response shapes · secrets moved to a local store
                                 │
   recipe saved (shareable) ──► tools generated ──► tools/list_changed (no restart)
                                 │
   tool call ──► policy · confirmation · rate limit · cache ──► request with host-scoped credentials
                 (browser profile, in-page fetch on bot checks, re-authentication on 401, retries)
                                 │
                 response ──► pick / readable HTML / truncation ──► agent
```

The result is saved as a **recipe**. Discovery runs once (seconds); after that the tools are available in every session.

## Features

**Discovery**
- Three sources: live browser capture, HAR files (devtools, mitmproxy, Charles, Proxyman: mobile and desktop apps too), OpenAPI 3 / Swagger 2 (JSON or YAML, found automatically, including behind a Swagger UI page).
- REST and GraphQL: one tool per GraphQL operation with typed variables; batched and persisted (hash-only) queries supported; a raw `graphql` tool as well.
- Smart path templates: `/api/users/42` → `/api/users/{user}`; a page you visited (`/crates/serde`) turns `/api/v1/crates/serde` into `/api/v1/crates/{crate}`; sibling URLs returning the same kind of data are merged.
- Autonomous exploration (`explore_pages`): follows same-site links and clicks harmless "load more" buttons and tabs. Logout, delete, payment, add-to-cart, vote or follow links are never followed.
- Multipart uploads are recognised (file fields become a `files` argument).

**Tools an agent can use well**
- Plain-language descriptions ("Get one crate by crate", "Search", "Create or submit order") and the values seen for each query parameter.
- `annotate_recipe`: the agent renames and documents tools itself, hides noise, and saves default arguments.
- `define_macro`: one tool that chains several calls, passing values from one response to the next call.
- `pick` and `max_chars` keep responses small; HTML pages come back as readable text; `save_to` writes downloads to a file.
- Above 60 generated tools, only `search_tools` and `call_tool` are listed, so the agent's context stays small.

**Calls that keep working**
- Persistent browser profile per recipe (session cookies included) and a `login` tool that opens a visible window.
- Re-authentication: on a 401 or an expired JWT, browser recipes reload the site to pick up fresh tokens; OAuth refresh tokens renew access tokens.
- Bot protections: requests run inside a real page of the site (real browser network stack) when a challenge answers; stale CSRF tokens are refreshed from cookies or meta tags.
- Retries of temporary failures (429, 502, 503, 504, network errors) with `Retry-After` or exponential backoff; writes are retried only when the server did not process them.
- Read cache (`cache_seconds`, or per recipe), per-call timeouts (`timeout_ms`), non-secret recipe headers (language, API version).
- `check_recipe` probes every read-only tool and flags broken or changed endpoints; `repair=true` rediscovers the recipe and keeps annotations and macros.
- Interface control (`ui`) for sites without a usable API: snapshot with element refs, click, fill, read, screenshot, in the logged-in profile.

**Safety and privacy**
- Credentials are detected by name (headers, query parameters, body fields) **and by value** (JWTs, provider key formats, private keys, long random tokens, card numbers), moved to a local secret store, replayed **only to the host they came from**, and scrubbed from every recipe before it is written.
- `dry_run` previews any call; DELETE calls (or all writes, if you choose) and risky interface clicks need `confirm=true`.
- Per-recipe policies: read-only, allowed hosts, rate limit, transport, cache. Default rate limit: 5 requests per second per host.
- Audit log of every request (method, redacted URL, status), never bodies or credentials.
- Shared recipes cannot act on your behalf: stored defaults and macro steps cannot confirm calls, write or upload local files.

## Requirements

- Node.js 22 or newer.
- For browser capture, browser recipes and the `ui` tool: Google Chrome or Microsoft Edge (used automatically), or Playwright's Chromium
  (`npx playwright-core install chromium`, then `UNIVERSAL_MCP_BROWSER=chromium`). OpenAPI and HAR recipes do not need a browser.

## Installation

### Claude Code

```bash
claude mcp add universal -- npx -y github:KorroAi/universal-mcp
```

### Claude Desktop, Cursor, Windsurf and other MCP clients

```json
{
  "mcpServers": {
    "universal": {
      "command": "npx",
      "args": ["-y", "github:KorroAi/universal-mcp"]
    }
  }
}
```

On Windows, some clients cannot start `npx` directly: use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "github:KorroAi/universal-mcp"]`.

### From source

```bash
git clone https://github.com/KorroAi/universal-mcp.git
cd universal-mcp
npm install
claude mcp add universal -- node /absolute/path/to/universal-mcp/bin/universal-mcp.js
```

## Quick start

Ask your agent in plain language:

> Use universal to discover https://example.com, search for "lamp" and open the first product, then tell me its price.

The agent calls `discover` (with actions such as filling the search box), then the generated `<recipe>__*` tools.
For a site behind a login, ask it to call `login` first: a window opens, you sign in, and the cookies are kept.
After a few calls, ask it to `annotate_recipe` the tools it used and to `define_macro` the sequences you repeat.

## Tools reference

### Management tools

| Tool | What it does |
| --- | --- |
| `discover` | Creates a recipe from a URL. Options: `mode` (`auto`, `openapi`, `browser`), `actions`, `explore_pages`, `interactive`, `duration_seconds`, `hosts` (extra API hosts), `include` (OpenAPI operation filter), `max_endpoints`, `merge`. |
| `discover_har` | Creates a recipe from a `.har` file (absolute path). |
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
| Browser / HAR | one tool per REST endpoint (`<recipe>__get_api_items_item`), one per GraphQL operation (`<recipe>__gql_GetCart`), `<recipe>__graphql` when GraphQL is used, and `<recipe>__request` |
| OpenAPI | one tool per operation (up to 60 by default), `<recipe>__routes` to list every route, and `<recipe>__request` |
| Any | one tool per macro: `<recipe>__m_<id>` |

Generated tools take `path`, `query` and `body` (or `variables` and an optional replacement `query` document for GraphQL), plus:

| Argument | Meaning |
| --- | --- |
| `pick` | Comma-separated paths into the JSON response: `data.items[*].name`, `items.*.id`, `meta.total, data.user`. |
| `max_chars` | Maximum characters returned (default 40,000). |
| `save_to` | Absolute path where the response body is written (downloads, binary files). |
| `raw` | Return HTML as-is (by default HTML pages are turned into readable text). |
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

- **Confirmation**: DELETE calls (and the interface's risky clicks) return a preview and wait for `confirm=true`. `UNIVERSAL_MCP_CONFIRM=writes` extends this to every write; `none` disables it. Per recipe: `configure_recipe {"name": "x", "policy": {"confirm": "writes"}}`.
- **Read-only recipes**: `{"policy": {"readOnly": true}}` refuses every write and interface action.
- **Allowed hosts**: `{"policy": {"allowedHosts": ["api.example.com"]}}`.
- **Rate limit**: 5 requests per second per host by default (`UNIVERSAL_MCP_RATE_LIMIT`, or `policy.rateLimit`); retries, macros and exploration go through it.
- **Dry runs**: any generated tool with `dry_run: true` shows the exact request, credentials replaced by `<stored secret>`.
- **Audit log**: `<home>/audit.log` (JSON Lines, rotated at 5 MB) records time, recipe, tool, method, redacted URL, status, transport, retries, cache hits and re-authentication. `UNIVERSAL_MCP_AUDIT=0` disables it.

### Staying logged in

- **Browser recipes**: on a 401, or before sending a bearer JWT that has expired, the site is reloaded headlessly in the recipe's profile and the auth headers the app sends are kept. A failed attempt is not repeated for 30 seconds. If the session itself has ended, call `login`.
- **OAuth**: `configure_recipe {"name": "x", "oauth": {"host": "api.example.com", "token_url": "https://auth.example.com/oauth/token", "refresh_token": "...", "client_id": "..."}}`. Access tokens are refreshed on 401 and before expiry; rotated refresh tokens are kept.
- **Bot challenges**: browser recipes retry the request from inside a real page and keep doing so for that recipe (`policy.transport` forces `page` or `node`). If a CAPTCHA still blocks, `login` lets you solve it.

### When the site changes

`check_recipe {"name": "shop"}` calls each read-only tool with the example recorded at discovery and reports `ok`, `changed` (fields missing), `broken` (errors, GraphQL errors) or `auth`.
`check_recipe {"name": "shop", "repair": true}` rediscovers from the original inputs (kept locally, actions and merged captures included) and lists added and removed tools; annotations and macros are kept.
`universal-mcp check shop` does the same from the terminal and exits with code 1 when something is broken, which suits a scheduled job.

### Many tools

With `UNIVERSAL_MCP_TOOL_MODE=auto` (default), when recipes generate more than 60 tools (`UNIVERSAL_MCP_TOOL_THRESHOLD`) only the management tools are listed.
The agent finds tools with `search_tools` (`pin: true` lists them from then on) and runs them with `call_tool`. `all` always lists everything; `search` never lists generated tools.

## Command line

```bash
npx -y github:KorroAi/universal-mcp --help
universal-mcp discover crates "https://crates.io/search?q=serde" --actions '[{"goto":"/crates/serde"}]'
universal-mcp discover shop https://shop.example --explore 10
universal-mcp har myapp ./capture.har --host api.myapp.com
universal-mcp login github https://github.com/login
universal-mcp check crates --repair
universal-mcp list
universal-mcp inspect crates
universal-mcp forget crates --delete-profile
```

Without a command, `universal-mcp` runs the MCP server on stdio (what MCP clients launch).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `UNIVERSAL_MCP_HOME` | `~/.universal-mcp` | Data directory |
| `UNIVERSAL_MCP_BROWSER` | `chrome` | `chrome`, `msedge`, `chromium` (Playwright) or an absolute path to a Chromium-based browser. `chrome` falls back to Edge, then Playwright's Chromium. |
| `UNIVERSAL_MCP_MAX_OUTPUT` | `40000` | Default maximum characters per tool result |
| `UNIVERSAL_MCP_TIMEOUT_MS` | `30000` | Request timeout |
| `UNIVERSAL_MCP_MAX_ENDPOINTS` | `40` | Endpoints kept per browser/HAR recipe (most frequent first) |
| `UNIVERSAL_MCP_MAX_OPENAPI_TOOLS` | `60` | Operations turned into tools per OpenAPI recipe |
| `UNIVERSAL_MCP_CONFIRM` | `destructive` | Calls that need `confirm=true`: `destructive` (DELETE), `writes` (anything but reads) or `none` |
| `UNIVERSAL_MCP_RETRIES` | `2` | Automatic retries of temporary failures |
| `UNIVERSAL_MCP_RATE_LIMIT` | `5` | Requests per second per host (`0` = unlimited) |
| `UNIVERSAL_MCP_TOOL_MODE` | `auto` | `auto` (search mode above the threshold), `all` or `search` |
| `UNIVERSAL_MCP_TOOL_THRESHOLD` | `60` | Generated tools listed before `auto` switches to search mode |
| `UNIVERSAL_MCP_AUDIT` | on | `0` disables the audit log |

## Data and secrets

```text
~/.universal-mcp/
  recipes/<name>.json    shareable: endpoints, schemas, redacted examples, annotations, macros
  secrets/<name>.json    local only: auth headers, API keys, cookies from HAR, secret query and path values, OAuth refresh settings (mode 600)
  profiles/<name>/       local only: browser profile and saved cookies
  state/<name>.json      local only: policy, recipe headers, original discovery inputs (for re-authentication and repair), last health check
  audit.log              local only: one line per request, no bodies or credentials
```

Before a recipe is written, credentials are detected by name and by value and moved to `secrets/`, and every stored secret value is scrubbed from the recipe.
A leak test covers 28 placements (headers, query, path, fragments, `user:password@`, JSON and form bodies, arrays, GraphQL documents and variables, free text).
Treat `secrets/`, `profiles/` and `state/` like a password store: do not commit, sync or share them. See [SECURITY.md](SECURITY.md).

## Limitations

- **Desktop and native apps** are reached through their network traffic only (HAR capture through a proxy). universal-mcp does not drive native windows or programs.
- **Requests signed by the page's own code** (an HMAC computed in JavaScript for each call) cannot be replayed from captured examples; use `ui` for those flows.
- **WebSockets, server-sent events and binary protocols** (gRPC-web, protobuf) are not captured. Binary bodies can still be sent (`body_kind: "base64"`) and received (`save_to`).
- **CAPTCHAs** are not solved automatically: in-page requests get through many bot checks, and `login` lets a person solve the rest.
- **Secret detection is heuristic**: credentials with an obvious name, a known format or a long random value are caught, but a short, ordinary-looking token in a URL path (e.g. `/hooks/abc123`) looks like any other path segment. Review recipes before sharing them.
- **Path inference is heuristic**: if a parameter was not detected, call the endpoint through `<recipe>__request` or capture more pages with `merge: true` or `explore_pages`.
- **Health checks** only call read-only tools that have a recorded example; writes are never probed.
- **One process per profile**: two servers sharing the same data directory cannot use the same recipe's browser at the same time.

## Responsible use

Only use universal-mcp with services and accounts you are allowed to access, and respect their terms of service, rate limits and robots policies.
Do not use it for mass data collection; keep the default rate limit unless you have a reason and the right to raise it.
Recordings and recipes may contain personal data from your account: review them before sharing.
You are responsible for how you use this tool.

## Development

```bash
npm install
npm run check        # type check + unit tests + end-to-end tests (needs Chrome, Edge or Playwright's Chromium)
npm test             # unit tests only
npm run test:live    # optional: real websites (crates.io, Swagger Petstore)
```

Plain JavaScript (ES modules) with JSDoc types checked by TypeScript; no build step. See [CONTRIBUTING.md](CONTRIBUTING.md).

| Path | Role |
| --- | --- |
| `src/server.js` | MCP server: management tools, search mode |
| `src/core.js` | Engine: discovery, sending (policy, cache, retries, re-authentication, transports), health and repair, interface control |
| `src/discovery/` | Browser capture and exploration, HAR import, OpenAPI loading, inference, secret detection |
| `src/tools/` | Tool generation (REST, GraphQL, OpenAPI, macros, annotations), HTTP transports and response formatting, schemas, `pick` |
| `src/ui.js`, `src/auth.js`, `src/safety.js` | Interface control, token refresh, guard rails (policy, rate limit, retries, cache, audit) |
| `test/unit/`, `test/e2e/`, `test/live/` | Unit tests, end-to-end tests against local fixture sites, optional tests against real sites |

## License

[MIT](LICENSE) © 2026 korrocorp
