# universal-mcp

**Turn any website, HAR capture or OpenAPI spec into MCP tools. Discover once, call forever.**

Most websites and apps have no public API and no MCP server, yet they all talk to an internal API.
`universal-mcp` finds that API and hands it to your agent as ready-to-use, typed tools:

1. **Discover**: point it at a URL. It looks for a published OpenAPI/Swagger description first; if there is none,
   it opens a real browser, loads the page (optionally clicks, types and navigates), and records the JSON calls the page makes, REST and GraphQL alike.
2. **Infer**: it groups the calls into endpoints, turns ids and the values you navigated to into named parameters, types query parameters, infers request-body and GraphQL-variable schemas, and summarises response shapes.
3. **Call**: every endpoint becomes an MCP tool (`<recipe>__<endpoint>`), added to the running session immediately through `tools/list_changed`.
   Calls reuse the browser profile's cookies and the captured auth headers, so logged-in sites keep working.

The result is saved as a **recipe**. Discovery runs once (seconds); after that the tools are available in every session.

```text
you:    Discover crates.io from https://crates.io/search?q=serde, then open the serde page.
agent:  discover(name="crates", url=..., actions=[{"goto": "/crates/serde"}])
        → 5 endpoints: crates__get_api_v1_crates, crates__get_api_v1_crates_crate, ...
you:    What is the latest version of tokio?
agent:  crates__get_api_v1_crates_crate(path={"crate": "tokio"}, pick="crate.max_version")
```

## Features

- **Many sources**: live browser capture, HAR files (devtools, mitmproxy, Charles, Proxyman: mobile and desktop apps too), OpenAPI 3 / Swagger 2 (JSON or YAML, found automatically, including behind a Swagger UI page),
  Google Discovery documents (YouTube Data and Analytics, Drive, Gmail, Sheets, Calendar and every other Google API), OData services (`$metadata`: SAP, Dynamics, SharePoint...), SOAP web services (WSDL),
  and local files: Postman collections, Insomnia exports, Bruno collection folders, AsyncAPI 2/3 (WebSocket channels), `.http` / `.rest` files (VS Code REST Client, JetBrains), shared recipes.
- **cURL and JSON-RPC**: paste "Copy as cURL" commands to get tools without a browser (`import_curl`); JSON-RPC calls (Ethereum and Bitcoin nodes, Kodi, Transmission, Odoo...) become one tool per method.
- **Realtime streams**: WebSocket and Server-Sent Events connections opened by the page are captured with their protocol (subscribe and auth frames, in order) and become tools that connect, replay the handshake and return the messages received for a chosen duration.
- **REST and GraphQL**: GraphQL operations become one tool each, with typed variables; batched and persisted (hash-only) queries are supported. A raw `graphql` tool is added as well.
- **Smart path templates**: `/api/users/42` → `/api/users/{user}`; a page you visited (`/crates/serde`) turns `/api/v1/crates/serde` into `/api/v1/crates/{crate}`; sibling URLs returning the same kind of data are merged.
- **Auth that works**: persistent browser profile per recipe (session cookies included), a `login` tool that opens a visible window, captured bearer tokens and API keys replayed **only to the host they came from**, and `set_credentials` for API keys.
- **Secrets stay out of recipes**: auth headers, cookies, and sensitive query parameters or body fields (`token`, `password`, `api_key`...) are redacted from recipes and stored separately, so recipes are safe to share.
- **CSV and XML too**: CSV, XML, RSS and Atom responses are converted to JSON, so `pick`, filters and pagination work on them.
- **Resilient calls**: idempotent requests answered with 429, 502, 503 or 504 are retried twice, honouring `Retry-After` (up to 10 s).
- **Binary responses**: protobuf and gRPC-web (binary or text) bodies are decoded into JSON keyed by field number, so `pick` works on them too.
- **Agent-friendly output**: `pick` extracts just the fields you need (`items[*].name`, slices `items[0:5]`, filters `items[?price>10]`, counts `items.#`), `max_chars` bounds the response, and tool annotations mark read-only and destructive calls.
- **Pagination, cache and watching**: read-only tools can merge several pages (`paginate`), reuse recent results (`cache_seconds`), and be polled with `watch`, which reports only what changed.
- **Robust schemas**: property names that Claude's API would reject (e.g. `page[size]`) are kept out of tool schemas but remain usable, so one odd parameter never breaks the tool list.
- **Hot reload**: new tools appear without restarting the client; recipes load at startup.
- **CLI included**: discover, import, inspect and manage recipes from the terminal.

## Requirements

- Node.js 22 or newer.
- For browser capture and browser-based calls: Google Chrome or Microsoft Edge (used automatically), or Playwright's Chromium
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

## Usage

Ask your agent in plain language: *"Use universal to discover https://example.com, search for 'lamp' and open the first product, then tell me its price."*
The agent calls the management tools below, then the generated ones.

### Management tools

| Tool | What it does |
| --- | --- |
| `discover` | Creates a recipe from a URL. Options: `mode` (`auto`, `openapi`, `browser`), `actions`, `interactive`, `duration_seconds`, `hosts` (extra API hosts), `include` (OpenAPI operation filter), `max_endpoints`, `merge`. |
| `discover_har` | Creates a recipe from a `.har` file (absolute path). |
| `import_file` | Creates a recipe from a local file or folder: OpenAPI / Swagger, Google Discovery document, OData `$metadata` or WSDL (with `base_url`), Postman collection, Insomnia export, Bruno collection, `.http` / `.rest` file, HAR, or a recipe shared with `export_recipe`. Options: `base_url`, `variables`, `variables_file` (Postman environment, Insomnia export, `.env`, JSON), `environment` (Bruno), `include`. |
| `import_curl` | Creates tools from cURL commands (devtools "Copy as cURL", bash or Windows cmd). Nothing is sent while importing; credentials go to local secrets. |
| `export_recipe` | Writes a recipe (never its secrets) to a JSON file. |
| `watch` | Calls a read-only generated tool every `interval_seconds` for up to `duration_seconds`, and returns the changes (field by field for JSON); `until` stops early. |
| `login` | Opens a visible browser on the recipe's profile so you can sign in; cookies are kept. |
| `set_credentials` | Stores headers (or `?name` query parameters) sent to one host, e.g. `{"authorization": "Bearer ..."}`. |
| `list_recipes` | Lists recipes, endpoints and tools. |
| `inspect_recipe` | Shows a recipe in detail, with credential header names (never values). |
| `forget` | Deletes a recipe and its credentials; `delete_profile` also removes its cookies. |

### Browser actions

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

Values you type or navigate to are recognised in API paths and become parameters.
For flows that are hard to script, use `interactive: true`: a window opens, you browse, and the capture ends when you close it.

### Generated tools

| Recipe type | Tools |
| --- | --- |
| Browser / HAR | one tool per REST endpoint (`<recipe>__get_api_items_item`), one per GraphQL operation (`<recipe>__gql_GetCart`), `<recipe>__graphql` when GraphQL is used, and `<recipe>__request` |
| OpenAPI / imported files | one tool per operation (up to 60 by default), `<recipe>__routes` to list every route, and `<recipe>__request` |
| SOAP (WSDL) | one tool per operation (`<recipe>__GetQuote`) taking `params` as JSON, sent as XML; the SOAP Body comes back as JSON and a Fault is an error |
| Recipes with JSON-RPC | one tool per method (`<recipe>__rpc_eth_getBalance`) taking `params`, and `<recipe>__rpc` for any method |
| Recipes with streams | one tool per WebSocket / event stream (`<recipe>__stream_ws_prices`) and `<recipe>__stream` for any `ws(s)://` or event-stream URL |

Generated tools take `path`, `query` and `body` (or `variables` for GraphQL), plus:

- `pick`: comma-separated paths into the JSON response: `data.items[*].name`, `items.*.id`, `meta.total, data.user`.
- `max_chars`: maximum characters returned (default 40,000).

Read-only tools also accept:

- `paginate`: `{ "max_pages": 5, "max_items": 1000, "items_path": "data.items" }`. Follows next-page tokens and URLs found in the response
  (`nextPageToken`, `next_cursor`, `links.next`, `pageInfo.endCursor`...), otherwise increments a page number or offset passed in `query`
  (`{"page": 1}`, `{"offset": 0}`), and returns the merged items. `pick` then applies to each item.
- `cache_seconds`: reuse an identical successful call made less than this many seconds ago.

Stream tools accept `duration_seconds` (default 10), `max_messages` (default 50), `filter` (text or `/regex/`), `pick` (applied to each JSON message),
`query` (override URL parameters) and, for WebSockets, `send` (extra frames) and `skip_captured_frames`.
Common heartbeats are answered automatically (Engine.IO / Socket.IO, graphql-ws and JSON `ping`).

`<recipe>__request` sends any request (absolute URL, or a path relative to the recipe's base URL) with the recipe's cookies and credentials.

### Capturing apps with a HAR file

- **Chrome / Edge**: DevTools → Network → use the app → right-click → *Save all as HAR with content*.
- **mitmproxy** (mobile and desktop apps): `mitmdump --set hardump=./capture.har`, route the device through the proxy, use the app, stop mitmdump.
- **Charles / Proxyman**: export the session as HAR.

Then: `discover_har(name="myapp", har_path="/absolute/path/capture.har")`.
Cookies and auth headers found in the file are stored as local secrets and replayed to their original hosts.

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
export_recipe(name="shop", path="/abs/path/shop-recipe.json")   # share it; the receiver runs import_file
```

### Command line

```bash
npx -y github:KorroAi/universal-mcp --help
universal-mcp discover crates "https://crates.io/search?q=serde" --actions '[{"goto":"/crates/serde"}]'
universal-mcp har myapp ./capture.har --host api.myapp.com
universal-mcp import team-api ./Team.postman_collection.json --base-url https://api.example.com
universal-mcp export crates ./crates-recipe.json
universal-mcp curl myapi ./commands.txt
universal-mcp login github https://github.com/login
universal-mcp list
universal-mcp inspect crates
universal-mcp forget crates --delete-profile
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `UNIVERSAL_MCP_HOME` | `~/.universal-mcp` | Data directory |
| `UNIVERSAL_MCP_BROWSER` | `chrome` | `chrome`, `msedge`, `chromium` (Playwright) or an absolute path to a Chromium-based browser. `chrome` falls back to Edge, then Playwright's Chromium. |
| `UNIVERSAL_MCP_MAX_OUTPUT` | `40000` | Default maximum characters per tool result |
| `UNIVERSAL_MCP_TIMEOUT_MS` | `30000` | Request timeout |
| `UNIVERSAL_MCP_MAX_ENDPOINTS` | `40` | Endpoints kept per browser/HAR recipe (most frequent first) |
| `UNIVERSAL_MCP_MAX_OPENAPI_TOOLS` | `60` | Operations turned into tools per OpenAPI recipe |
| `UNIVERSAL_MCP_CACHE_SECONDS` | `0` | Default `cache_seconds` of read-only tools (0 = no cache unless asked) |

Data layout:

```text
~/.universal-mcp/
  recipes/<name>.json    shareable: endpoints, schemas, examples (secrets redacted)
  secrets/<name>.json    local only: auth headers, cookies from HAR, secret query parameters (mode 600)
  profiles/<name>/       local only: browser profile and saved cookies
```

## How it works

```text
            ┌──────────── discover(url) ────────────┐
            │                                        │
   OpenAPI found? ──yes──► normalize operations      │
            │no                                      │
   real browser loads the page, runs actions,        │
   records xhr/fetch JSON traffic (same site + hosts)│
            │                                        ▼
   infer: path templates · query types · body and variable schemas
          GraphQL operations · response shapes · secrets split out
            │
   recipe saved ──► tools generated ──► tools/list_changed
            │
   tool call ──► request (browser profile or fetch) + host-scoped secrets ──► pick / truncate ──► agent
```

## Limitations

- **Server-rendered pages** (HTML built on the server, no JSON calls) expose no API to capture. Use the agent's browser tools for those.
- **Tokens computed in the page** (request signing, short-lived tokens refreshed by JavaScript) may expire; rerun `discover` or `login`. Bearer tokens are replayed as captured.
- **Binary protocols**: protobuf and gRPC-web responses are decoded without their .proto schema, so fields appear by number (`{"1": "name", "2": 150}`) and types are guessed; binary request bodies are not rebuilt. Event streams read with `fetch()` (rather than `EventSource`) are recorded without sample messages.
- **Stream replays** come from Node, not from the page: servers that require a browser-only handshake may refuse them.
- **Anti-bot protections** (CAPTCHAs, bot scoring) can block headless capture; `interactive: true` or `login` usually helps.
- **Path inference is heuristic**: if a parameter was not detected, call the endpoint through `<recipe>__request` or capture more pages with `merge: true`.
- Recipes can break when a site changes its API: rediscover.

## Responsible use

Only use universal-mcp with services you are allowed to access, and respect their terms of service, rate limits and robots policies.
Recordings and recipes may contain personal data from your account: review them before sharing.
You are responsible for how you use this tool.

## Development

```bash
npm install
npm run typecheck      # TypeScript checks on the JSDoc-annotated sources
npm test               # unit tests
npm run test:e2e       # end-to-end: real MCP client + local fixture sites + browser
UNIVERSAL_MCP_LIVE=1 node --test test/live/   # optional: real public websites
npm run check          # typecheck + all offline tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
