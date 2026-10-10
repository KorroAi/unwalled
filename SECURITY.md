# Security

## What universal-mcp stores

- `recipes/` — endpoints, schemas and redacted examples. Designed to be shareable.
- `secrets/` — authorization headers, API keys, cookies from HAR files and secret query parameters, keyed by host. Local only, created with mode 600 on POSIX systems.
- `profiles/` — browser profiles, including cookies for the sites you signed in to. Local only.

Credentials are only ever sent to the host they were captured for (or set for with `set_credentials`).
The data directory defaults to `~/.universal-mcp` (`UNIVERSAL_MCP_HOME`). Treat `secrets/` and `profiles/` like a password store:
do not commit, sync or share them.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security advisories) on this repository
rather than in a public issue. Include steps to reproduce and the impact.
