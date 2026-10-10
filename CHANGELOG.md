# Changelog

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
