# Changelog

## 0.1.0 — 2026-10-10

First release.

- Discovery from a live browser capture (REST and GraphQL), HAR files, and OpenAPI 3 / Swagger 2 (JSON or YAML, found automatically, including from Swagger UI pages).
- Inference of path templates with named parameters, typed query parameters, request-body and GraphQL-variable schemas, and response shapes.
- One MCP tool per endpoint or GraphQL operation, plus `__request`, `__graphql` and `__routes` helpers; tools added at runtime via `tools/list_changed`.
- Authentication: persistent browser profiles with saved session cookies, `login`, host-scoped replay of captured credentials, `set_credentials`.
- Secrets (auth headers, cookies, sensitive query parameters and body fields) redacted from recipes and stored separately.
- `pick` and `max_chars` to keep responses small; tool annotations for read-only and destructive calls.
- CLI: `discover`, `har`, `login`, `list`, `inspect`, `forget`.
