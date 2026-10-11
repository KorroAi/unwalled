# Changelog

## 0.5.1 — 2026-10-11

- Published on npm: `npx -y unwalled` (setup), `npm install --global unwalled` (command). The guided setup and the documentation use it;
  the development version still runs with `npx -y github:KorroAi/unwalled`.

## 0.5.0 — 2026-10-11

First steps for people, not only for agents: from nothing to an agent answering in a few minutes, without editing a configuration file.

### New

- **Guided setup**: `npx -y github:KorroAi/unwalled` in a terminal (or `unwalled setup`) checks the computer, offers to install the
  `unwalled` command, adds unwalled to the AI apps it finds (Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Gemini CLI, Codex)
  and connects a first source: a website or internal app (in a window where you sign in and open the pages your agent will use), a file
  or folder, a database, a ready-made service, or the demo. Configuration files are changed only when they are plain JSON, with a backup;
  `--yes` configures every app without questions, `--remove` takes unwalled out of all of them. MCP clients still start the server
  (they start it with pipes; a terminal gets the setup).
- **`unwalled add <source>`**: one command for every kind of source (website, file, folder, API description, collection, HAR, cURL list,
  database, preset), with a name taken from the source; it never replaces an existing recipe (`--merge` adds to it).
  `--browse` opens a window to sign in and click through the app.
- **`unwalled demo`**: starts the sample back office and discovers it, then gives the question to ask the agent.
  Checked with a real Claude Code (Sonnet) starting from an empty data folder: right answer, 4 turns, $0.043.
- **`unwalled key <name>`**: stores the key or token a ready-made service needs, typed without being shown (or piped).
- **`unwalled doctor`**: Node.js, the browser (started once), the data folder, encryption of secrets, and which AI apps start unwalled.
- The agent is told about files, databases and presets in the server's instructions, and an empty `list_recipes` says what to connect and how.

### Fixes

- An API address opened directly (the page is JSON, e.g. `unwalled add "https://api.open-meteo.com/v1/forecast?..."`) gave no tool: that address is now the endpoint, and its path is kept literal.
- Tool summaries: "Get one order" instead of "Get one order by order", "notes of an order" instead of "of a order".
- Test files and fixtures are in English; the benchmark report says why its raw answers are in French (the settings of the machine it ran on).
- README rewritten: what it does and how it works first, then the setup, one table to connect each kind of source, and the measurements.
- License: Apache License 2.0 (was MIT), with a NOTICE file.

## 0.4.0 — 2026-10-11

Built from what testing on 20 real websites (`bench/field.js`), a real Grafana behind a sign-in (`test/live/grafana.test.js`)
and a real agent (`bench/agent.js`, Claude Code against Playwright MCP) showed, followed by a line-by-line audit.

### New

- **Server-rendered tools become tools too.** Pages whose HTML carries the data (Django or Rails admin, PHP back offices, wikis) become `<recipe>__page_*` tools that return the page's tables as rows, its "label: value" fields, links and text as JSON; three or more pages of the same shape become one tool with a parameter. HTML forms posted during discovery become tools, with their CSRF field filled automatically. Docker Hub's search, which has no API call, now answers through a page tool.
- **Large answers are shortened instead of cut.** An unpicked JSON answer above `UNWALLED_COMPACT_CHARS` (6,000 by default) comes back with its lists cut to their first items, long texts clipped, every key kept, and the list of field paths `pick` accepts. crates.io's 445,000-character crate answer becomes about 6,400 characters. `max_chars` or `raw` returns the whole answer; pagination and `watch` always work on whole answers.
- **The result of `discover` (and of imports) is a ready-to-use guide**: every tool with what it does and a call that works, so the agent answers at once instead of searching the tools first.
- **Sign-in steps survive guessed selectors.** Agents write discovery actions without seeing the page; a wrong selector made the sign-in fail silently. A `fill` or `click` aimed at a user, password or submit field that is not on the page now uses the page's own field (and says so); when a step still fails, the result lists the page's real fields and their selectors.
- **Bot protection pages are reported** (Reddit, npm, GitLab, Stack Overflow, PyPI, leboncoin) instead of "the page may be server-rendered", with what to do (`interactive=true`, or a HAR from your own browser). `ui` flags CAPTCHA and challenge pages. Nothing is bypassed.
- **Ended sessions are recognised.** A call redirected to the sign-in page is treated as a 401: the session is renewed when possible, otherwise the agent is told, and the sign-in page is never returned as data.
- **Form CSRF tokens** (Rails `authenticity_token`, Django `csrfmiddlewaretoken`, Laravel `_token`) are filled with the session's current token when a call does not give one (found on OpenStreetMap).
- A POST to a search path (`/search`, `/query`, `/_search`: Algolia, Elasticsearch, Flathub) counts as a read, so read-only policies allow it, and is described as a search.
- Tools accept path and query values at the top level (`{"order": "1042"}`), a common agent habit that returned "Missing path parameter"; this also covers OpenAPI tools.
- `pick` reads `[]` as `[*]` (`[].title`).
- Field test (`bench/field.js` → `bench/FIELD.md`), agent benchmark (`bench/agent.js` → `bench/AGENT.md`), live Grafana test, and an example back office with server-rendered customer pages, a Django-style form and Rails-style CSRF notes.

### Security

- **Saved session cookies and local state are encrypted at rest.** Cookies saved next to browser profiles, and each recipe's local state (which holds the discovery inputs, sign-in steps and their typed passwords included), were written in clear text. They are now encrypted with the secrets' key (AES-256-GCM: DPAPI, passphrase or key file); files written by earlier versions are still read.
- **Typed passwords never reach a recipe or a message.** When a sign-in step failed, its typed text could appear in the warnings saved in the shareable recipe, and a password sent in a body field with an ordinary name (`pw`) was not recognised. Typed text is no longer shown anywhere, and whatever is typed into a password field is scrubbed from the recipe. The interface tool masks password fields by their real type, not only by selector.
- **A macro only chains its own recipe's tools.** A shared recipe's macro could call another recipe's tools with that recipe's credentials.
- **The organization policy is enforced by the engine**, not only by the MCP server: the command line, presets and `goto` steps of discovery and of the interface tool now follow `allowedHosts` too, and the interface tool no longer returns a page it was led to on a host that is not allowed.
- **A secret query parameter of one endpoint was added to every call to its host** (archive.org's `config.php?key=...` broke its search). Recipes record which endpoints were called with which secret parameters; only those get them. Free-form `__request` calls and recipes discovered before 0.4 keep the previous behaviour.
- Short tokens right after a path segment that announces one (`/hooks/abc123`, `/invite/x7k2`) are treated as secrets.
- **Body and query examples of imported collections** (Postman, Insomnia, Bruno) were copied as they were into tool descriptions, so into the shareable recipe: a password or key in a collection's example now stays out.
- **API keys in a URL path** (hosted Ethereum nodes such as Infura or Alchemy, `wss://host/ws/<token>` streams) are kept with the secrets and restored for their own host only; the recipe shows the path with `REDACTED`. Before, such a key either stayed in the recipe or was replaced there and broke the tool.
- A stream's tool id was built from its path before redaction, so a path token reached the tool name and the recipe; Socket.IO (`42[...]`) and plain-text message samples were saved without redaction.
- MySQL: `SELECT ... INTO OUTFILE / DUMPFILE` (which writes a file on the database server and is not stopped by a READ ONLY transaction) is refused, including inside executable comments (`/*! ... */`).

### Fixes

- Cookie sessions that rotate (Grafana) were lost: re-authentication only looked for new auth headers. A reload that renews the cookies now counts, and the call is retried.
- A site parameter named `query` or `path` (Grafana's search) given as a plain value was spread letter by letter into the URL.
- `check_recipe` called tools without their query values, so search and lookup tools looked broken while they worked (MDN, Bluesky).
- Error reporting and event logging (self-hosted Sentry, Bugsnag, gRPC-web log services), Cloudflare `/cdn-cgi/` calls and challenge forms, and Fastly beacons are no longer turned into tools.
- Long tool names keep the verb and the end of the path, which tell tools apart (`github__get_modelcontextprotocol_param2_deferred_c2e490`).
- Parameter names from plurals: "databases", "releases", "responses" gave `{databas}`, `{releas}`, `{respons}`.
- `unwalled import <name> postgres://...` (or an https address) turned the address into a local path.
- Macros read the JSON of page and SOAP tools (they read the raw response before).
- The server's instructions to the agent ran two sentences together; they now mention page tools and sign-in steps.
- SOAP tools and the compact-mode `__call` tool accept their arguments at the top level too.
- PostgreSQL and MySQL: parallel calls on one cached connection mixed their replies (each address now runs one statement at a time); a statement allowed to run longer than the request timeout was given up by the client and run twice; a failed sign-in left its socket open; the PostgreSQL TLS request had no time limit.
- Local data: values with a leading zero (`01234` postal codes) lost it; Excel sheets whose names give the same table name overwrote each other, and so did repeated column headers (Excel and CSV); whole files were read just to check for a SQLite header; an Excel entry's unpacked size is capped.
- iCalendar: an event's reminder (`VALARM`) overwrote the event's description.
- OData: 64-bit keys are written bare and v2 GUID keys as `guid'...'`; actions get a request body described from their parameters.
- AsyncAPI over MQTT: the recipe's base address is `http(s)://host`, and two channels whose names differ only by punctuation get distinct tools.
- gRPC-web: compressed frames are reported as such instead of being decoded as garbage. MQTT: a broker that closes before accepting the connection gives a clear error.
- XML: a numeric entity beyond Unicode (`&#99999999;`) threw; an element named `__proto__` was lost. `pick` and schema inference read only an object's own keys (`constructor` no longer resolves to a function), and `pick` reads quoted keys with dots (`$['a.b']`).
- Tests retry removing temporary folders: Windows keeps a closed browser's files locked for a moment, which made the end-to-end suite fail now and then (the intermittent failure noted since 0.2).

## 0.3.0 — 2026-10-11

- **Renamed to unwalled.** The former names keep working: `UNIVERSAL_MCP_*` variables are still read, an existing `~/.universal-mcp` data directory is still used, saved browser cookies are still found, and `universal-mcp` remains as a command alias.
- **Organization policy** (`UNWALLED_ORG_POLICY`): rules set by an administrator for every recipe that the agent cannot loosen (read-only, allowed hosts, minimum confirmation level, disabled management tools, mandatory audit log). Allowed hosts are checked before discovery, sign-in, remote imports, streams and interface pages are contacted. A missing or invalid policy stops the server; `unwalled policy` checks and shows it.
- **Shared team catalogue** (`UNWALLED_TEAM_RECIPES`): a read-only folder of recipes shared by a team; personal copies take precedence, deleting one brings the team version back, and new recipes are picked up by `list_recipes` without a restart.
- **Fix: stream tools now go through the safety policy.** WebSocket, Server-Sent Events and MQTT tools were not checked against a recipe's policy: a read-only recipe could still publish MQTT messages or send WebSocket frames, and allowed hosts were not enforced for streams. Sending or publishing now counts as a write; listening stays a read; stream tools accept `confirm`.
- **Fix: clean shutdown on Windows.** After network calls, the server could abort when its MCP client closed it ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"): it now lets Node exit by itself instead of forcing `process.exit()`. Covered by a live test.
- Example internal app (`examples/intranet`), benchmark against a scripted browser (`bench/run.js`, results in `bench/RESULTS.md`), recorded demo (`docs/demo.gif`, `docs/demo/make-gif.js`).
- Documentation: a short README; the full reference moved to `docs/REFERENCE.md`; `docs/FOR-TEAMS.md` for companies.

### Also since 0.2.0

- MySQL / MariaDB data source: built-in client (TLS, caching_sha2_password with TLS or RSA, mysql_native_password), read-only session and transaction, statement timeout, `?` parameters escaped client-side.
- Database clients refuse anything but reading statements before sending them (MySQL DDL would otherwise commit implicitly, outside the read-only transaction).
- PostgreSQL data source: built-in client (protocol v3, TLS, SCRAM-SHA-256 / MD5 / cleartext), read-only transactions with statement timeout, typed results; `import_file` takes a `postgres://` address, kept with the secrets.
- JSON served as text/plain or JavaScript, or behind an anti-hijacking prefix (`)]}'`, `while(1);`, `for(;;);`), is recognised in browser captures, HAR files and tool responses.
- `oauth_login`: first OAuth sign-in (authorization code + PKCE, loopback redirect) for Google, GitHub, Microsoft, Spotify or any provider; the token is stored for the API host and refreshed automatically with the existing refresh support.
- Preset catalogue: `discover(name, "preset:<id>")` (GitHub, Stripe, Vercel, ElevenLabs, Discord, Binance REST and streams, CoinGecko, Open-Meteo, Google APIs); addresses checked, small public APIs described from tested endpoints.
- In compact mode, OpenAPI recipes keep every operation (they are reached through `__operation` / `__call`) instead of the first 60.
- Local data sources: CSV, TSV, JSON records, JSON Lines, SQLite databases and folders of such files, queried with read-only SQL through `__tables` and `__sql` (node:sqlite, no extra dependency); data is reloaded when files change.
- Image responses (PNG, JPEG, GIF, WebP up to 2 MB, verified by signature) are returned to the agent as images, from generated tools and from `call_tool`.
- RSS and Atom feeds as data (YouTube channel feeds with video ids, views and ratings).
- Excel workbooks (`.xlsx`) and iCalendar files (`.ics`) as data; remote data addresses (CSV, JSON, Excel, iCalendar, SQLite) cached and refreshed, with the address kept as a secret.
- Repair re-imports recipes that came from a file or folder; exported SOAP and data recipes can be imported again.
- In-page requests are opt-in: requests leave from Node unless a recipe sets `policy.transport` to `auto` or `page`; a bot challenge returns a hint instead of an automatic in-page retry.
- Read-only tools: `paginate` (next-page tokens and URLs, page numbers, offsets).
- Secrets encrypted at rest (AES-256-GCM; key from Windows DPAPI, `UNIVERSAL_MCP_SECRET_KEY`, or a key file); plaintext files are re-encrypted on first read.
- Tool definitions compacted to a budget (`UNIVERSAL_MCP_SCHEMA_CHARS`); recipes above 20 operations use compact mode (`__operation` + `__call`).
- `pick` accepts standard JSONPath (`$.a[*].b`, `$..price`, `[?(@.price > 10)]`, `['odd key']`), recursive keys (`**price`) and negative indexes.
- Pagination reads the status and JSON returned by tools instead of parsing their text output.
- MQTT subscriptions with QoS 1; protobuf results say they were decoded without schema; `watch` defaults to 120 s.
- README: when to use universal-mcp and when not, and the limits of each protocol.
- Safer hints: PUT / PATCH / DELETE, GraphQL mutations and unknown operations, and JSON-RPC / SOAP methods that are not obviously readers are marked destructive; the server instructions tell the agent that tool results are untrusted data.

- WebSocket and Server-Sent Events: captured during browser discovery and from HAR files (Chrome's `_webSocketMessages`, event-stream bodies); one tool per stream plus `__stream`, replaying the captured frames in order with the profile's cookies, secrets kept out of recipes, heartbeats answered.
- Google Discovery documents (YouTube, Drive, Gmail, Sheets, Calendar...) are read like OpenAPI descriptions.
- `import_file`: OpenAPI / Swagger files, Google Discovery documents, Postman collections, Insomnia exports, Bruno collection folders, HAR files and shared recipes. `export_recipe` writes a recipe without secrets. CLI: `import`, `export`.
- `watch`: polls a read-only tool and reports what changed.
- `pick`: slices (`items[0:5]`), filters (`items[?price>10]`, `=`, `!=`, `<`, `>`, `~` contains, presence) and counts (`items.#`).
- Responses with `text/event-stream` are shown as text.
- Protobuf and gRPC-web responses are decoded without schema (fields by number, trailers shown).
- CSV, XML, RSS and Atom responses are converted to JSON.
- `import_curl` (CLI `curl`): tools from cURL commands, bash or Windows cmd syntax, credentials stored as secrets.
- JSON-RPC 1.0 / 2.0 (single and batch calls): one tool per method plus `__rpc`; the generic POST endpoint is dropped.
- `.http` / `.rest` request files (VS Code REST Client, JetBrains HTTP Client) imported with `import_file`.
- OData v2 / v4 services: `$metadata` found from the service root (or imported with `base_url`) and turned into list / get / create / update / delete tools per entity set, with `$filter`, `$select`, `$expand`...
- SOAP 1.1 / 1.2 web services: the WSDL (found at `?wsdl` or imported) becomes one tool per operation; JSON parameters are sent as XML and the response Body is returned as JSON, faults as errors.
- AsyncAPI 2.x / 3.x: WebSocket channels become stream tools (send examples as default frames, receive payloads as message shape).
- MQTT 3.1.1 client (TCP, TLS, WebSocket; QoS 0 subscriptions, publishing, credentials): AsyncAPI MQTT channels and `__stream` with `mqtt://` URLs.
- `import_file` `variables_file`: Postman environments, Insomnia exports, `.env` files or JSON objects.

## 0.2.0 — 2026-10-10

Security

- Secret detection by value as well as by name: JWTs, provider key formats (Stripe, AWS, GitHub, GitLab, Slack, Google, OpenAI/Anthropic, Hugging Face, npm, SendGrid), private keys, bearer tokens, long random strings and card numbers.
- Wider name rules (any header mentioning a key, token, session, signature...; `jwt`, `pass`, `private_key`, `cvv`, `card_number`...), arrays under sensitive keys, string literals in GraphQL documents, credentials and fragments in URLs, secret path segments (webhook tokens) which become parameters filled from the secret store.
- Every recipe is scrubbed of all stored secret values before it is written. Typed passwords are hidden from progress messages and warnings. A leak test covers 28 placements.

Fixed

- Per-request headers (`Idempotency-Key`, tracing ids) are never replayed; secret query parameter names keep their case; HAR recipes store the file name only; HAR form bodies exported as `params` are rebuilt.
- Failed browser re-authentication is not retried for 30 s; GraphQL errors count as broken in health checks; repair replays merged captures; in-page requests leave from the site's origin; undeclared OpenAPI path parameters are reported instead of sent as "undefined".
- Exploration waits between pages and skips side-effect links (add to cart, vote, follow...); macro steps that throw stop the macro with context; hidden tools stay usable in macros.
- Shared recipes can no longer act on the user's behalf: stored defaults and macro steps cannot contain `confirm`, `save_to`, `files` or request targets.
- A malformed recipe is skipped at startup instead of stopping the server; OpenAPI discovery probes well-known paths four at a time instead of all at once; a zero cache lifetime never serves a cached response.

New

- `ui` tool: interface control in the recipe's browser profile (snapshot with refs, act, read, screenshot), with confirmation for risky clicks.
- Autonomous exploration (`explore_pages`, CLI `--explore`) that never follows logout, delete or payment links.
- Plain-language tool descriptions and observed parameter values; `annotate_recipe` for agent-written names and descriptions.
- `define_macro`: tools that chain several calls with placeholders.
- Automatic re-authentication: browser reload on 401 or expired JWT, OAuth refresh tokens (`configure_recipe` `oauth`).
- In-page requests (real browser network stack) used automatically on bot challenges; stale CSRF tokens refreshed from cookies and meta tags.
- Safety: `dry_run`, confirmation of destructive calls (`UNIVERSAL_MCP_CONFIRM`), per-recipe policies (`configure_recipe`), default rate limit (`UNIVERSAL_MCP_RATE_LIMIT`), audit log.
- `check_recipe` (CLI `check`): health check of read-only tools and `repair` by rediscovery, keeping annotations and macros.
- Search mode for large tool sets: `search_tools`, `call_tool`, pinning (`UNIVERSAL_MCP_TOOL_MODE`).
- Saved default arguments per tool (`annotate_recipe` `defaults`), non-secret recipe headers (`configure_recipe` `headers`), per-call `timeout_ms`.
- Automatic retries of temporary failures (`UNIVERSAL_MCP_RETRIES`) and a read cache (`cache_seconds`, `policy.cacheSeconds`).
- Multipart uploads (`files`), downloads (`save_to`), base64 bodies, HTML responses as readable text.

## 0.1.0 — 2026-10-10

First release.

- Discovery from a live browser capture (REST and GraphQL), HAR files, and OpenAPI 3 / Swagger 2 (JSON or YAML, found automatically, including from Swagger UI pages).
- Inference of path templates with named parameters, typed query parameters, request-body and GraphQL-variable schemas, and response shapes.
- One MCP tool per endpoint or GraphQL operation, plus `__request`, `__graphql` and `__routes` helpers; tools added at runtime via `tools/list_changed`.
- Authentication: persistent browser profiles with saved session cookies, `login`, host-scoped replay of captured credentials, `set_credentials`.
- Secrets (auth headers, cookies, sensitive query parameters and body fields) redacted from recipes and stored separately.
- `pick` and `max_chars` to keep responses small; tool annotations for read-only and destructive calls.
- CLI: `discover`, `har`, `login`, `list`, `inspect`, `forget`.
