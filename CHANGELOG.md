# Changelog

## Unreleased (realtime branch)

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
- Read-only tools: `paginate` (next-page tokens and URLs, page numbers, offsets) and `cache_seconds` (`UNIVERSAL_MCP_CACHE_SECONDS`).
- `watch`: polls a read-only tool and reports what changed.
- `pick`: slices (`items[0:5]`), filters (`items[?price>10]`, `=`, `!=`, `<`, `>`, `~` contains, presence) and counts (`items.#`).
- Responses with `text/event-stream` are shown as text.
- Protobuf and gRPC-web responses are decoded without schema (fields by number, trailers shown).
- CSV, XML, RSS and Atom responses are converted to JSON.
- Idempotent requests are retried on 429 / 502 / 503 / 504 (twice, `Retry-After` honoured up to 10 s).
- `import_curl` (CLI `curl`): tools from cURL commands, bash or Windows cmd syntax, credentials stored as secrets.
- JSON-RPC 1.0 / 2.0 (single and batch calls): one tool per method plus `__rpc`; the generic POST endpoint is dropped.
- `.http` / `.rest` request files (VS Code REST Client, JetBrains HTTP Client) imported with `import_file`.
- OData v2 / v4 services: `$metadata` found from the service root (or imported with `base_url`) and turned into list / get / create / update / delete tools per entity set, with `$filter`, `$select`, `$expand`...
- SOAP 1.1 / 1.2 web services: the WSDL (found at `?wsdl` or imported) becomes one tool per operation; JSON parameters are sent as XML and the response Body is returned as JSON, faults as errors.
- AsyncAPI 2.x / 3.x: WebSocket channels become stream tools (send examples as default frames, receive payloads as message shape).
- MQTT 3.1.1 client (TCP, TLS, WebSocket; QoS 0 subscriptions, publishing, credentials): AsyncAPI MQTT channels and `__stream` with `mqtt://` URLs.
- `import_file` `variables_file`: Postman environments, Insomnia exports, `.env` files or JSON objects.

## 0.1.0 — 2026-10-10

First release.

- Discovery from a live browser capture (REST and GraphQL), HAR files, and OpenAPI 3 / Swagger 2 (JSON or YAML, found automatically, including from Swagger UI pages).
- Inference of path templates with named parameters, typed query parameters, request-body and GraphQL-variable schemas, and response shapes.
- One MCP tool per endpoint or GraphQL operation, plus `__request`, `__graphql` and `__routes` helpers; tools added at runtime via `tools/list_changed`.
- Authentication: persistent browser profiles with saved session cookies, `login`, host-scoped replay of captured credentials, `set_credentials`.
- Secrets (auth headers, cookies, sensitive query parameters and body fields) redacted from recipes and stored separately.
- `pick` and `max_chars` to keep responses small; tool annotations for read-only and destructive calls.
- CLI: `discover`, `har`, `login`, `list`, `inspect`, `forget`.
