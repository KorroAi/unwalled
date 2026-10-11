# Changelog

## 0.4.0 — 2026-10-11

Found by testing on 20 real websites (`bench/field.js`), on a real Grafana behind a sign-in (`test/live/grafana.test.js`) and with a real agent (`bench/agent.js`):

- **Fix: cookie sessions that rotate were lost.** Re-authentication only looked for new auth headers after reloading the site, so an app whose session cookie rotates (Grafana, every few minutes by default) answered 401 for good. A reload that renews the cookies now counts, and the call is retried.
- **Fix: a site parameter named `query` or `path`** (Grafana's search is `?query=`) given as a plain value was spread letter by letter into the URL; it is now sent as that parameter.
- `pick` reads `[]` as `[*]` (`[].title`), as agents often write it.

- **Bot protection pages are reported.** Discovery said "the page may be server-rendered" when a site had answered with a challenge (Reddit, npm, GitLab, Stack Overflow, leboncoin): it now says the site refused the automated browser and what to do (`interactive=true`, or a HAR from your own browser). `ui` flags CAPTCHA and challenge pages the same way. Nothing is bypassed.
- **Sign-in steps survive guessed selectors.** Agents write discovery actions without seeing the page, and a wrong selector made the sign-in fail silently. A `fill` or `click` aimed at a user, password or submit field that is not on the page now uses the page's own field (and says so); when a step still fails, the result lists the page's real fields and their selectors.
- **Form CSRF tokens** (Rails `authenticity_token`, Django `csrfmiddlewaretoken`, Laravel `_token`...) are filled with the session's current token when a call does not give one (found on OpenStreetMap).
- **Fix: `check_recipe` called tools without their query values**, so search and lookup tools were reported broken while they worked (MDN, Bluesky). Health checks now replay the query parameters seen on every captured call.
- **Fix: a secret query parameter of one endpoint was added to every call to its host** (archive.org's `config.php?key=...` broke its search). Recipes now record which endpoints were called with which secret parameters, and only those get them; free-form `__request` calls and recipes discovered before 0.4 keep the previous behaviour.
- The example back office has order notes protected by a Rails-style CSRF token, covered end to end with guessed sign-in selectors and top-level arguments.
- REST tools accept path and query values at the top level (`{"order": "1042"}`), a common agent mistake that returned "Missing path parameter".
- Long tool names keep the verb and the end of the path, which tell tools apart, instead of the start (`github__get_modelcontextprotocol_param2_deferred_c2e490`).
- Short tokens right after a path segment that announces one (`/hooks/abc123`, `/invite/x7k2`) are treated as secrets.
- Error reporting and event logging sent to a site's own hosts (self-hosted Sentry, Bugsnag, gRPC-web log services), Cloudflare `/cdn-cgi/` calls and Fastly beacons are no longer turned into tools.
- Field test (`bench/field.js` → `bench/FIELD.md`) and agent benchmark (`bench/agent.js` → `bench/AGENT.md`).

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
