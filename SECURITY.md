# Security

## What unwalled stores

- `recipes/` — endpoints, schemas and redacted examples. Designed to be shareable.
- `secrets/` — authorization headers, API keys, cookies from HAR files and secret query parameters, keyed by host. Local only, created with mode 600 on POSIX systems.
- `profiles/` — browser profiles, including cookies for the sites you signed in to. Local only; the session cookies unwalled saves next to the profile are encrypted.
- `state/` — per-recipe policy, the original discovery inputs (URL and actions, sign-in steps included) and the last health check. Local only, encrypted.

Secrets, saved cookies and state are encrypted with AES-256-GCM. The key comes from `UNWALLED_SECRET_KEY` (a passphrase), else from Windows DPAPI
(only the same Windows user can use it), else from a key file in the data directory (mode 600): on that last option, anyone who can read the data
directory can read the key, so protect the directory.
- `audit.log` — one line per request: time, recipe, tool, method, redacted URL, status. No bodies, no credentials.

Before a recipe is written, credentials are detected by name and by value and moved to `secrets/`, and every stored secret value,
as well as any text typed into a password field during discovery, is scrubbed from the recipe. Typed text never appears in progress
messages or warnings. Detection is heuristic (see the limitations in docs/REFERENCE.md): review a recipe before sharing it.

## Using a recipe someone else wrote

A recipe describes endpoints, so it decides where its tools send requests. Treat a shared recipe like code from that person:

- Credentials are only sent to the host they were captured or set for, never to another host named in the recipe.
- Stored defaults and macro steps cannot confirm held calls, write files (`save_to`) or upload files (`files`): those arguments are dropped.
- A macro only chains the tools of its own recipe: it cannot drive another recipe's tools, and so cannot use another recipe's credentials.
- Calls still run with your cookies for the recipe's own hosts: read the endpoints (`inspect_recipe`) before using a recipe from an untrusted source,
  and consider `configure_recipe` with `policy.readOnly` or `policy.allowedHosts`.
- A malformed recipe file is skipped at startup rather than loaded.

## Safety controls

- DELETE calls and risky interface clicks need `confirm=true` (`UNWALLED_CONFIRM=writes` extends this to every write).
- `dry_run` shows any request with credentials hidden. The default rate limit is 5 requests per second per host.
- The audit log never contains request bodies or credentials.
- Stream tools (WebSocket, Server-Sent Events, MQTT) follow the same policy: sending frames or publishing is a write.
- An administrator can set an organization policy (`UNWALLED_ORG_POLICY`) that applies to every recipe and that the agent cannot
  loosen: read-only, allowed hosts, confirmation level, disabled tools, mandatory audit. It is enforced by the engine, so the
  command line follows it too. A missing or invalid policy file stops the
  server. Protect the file with the operating system's permissions. See [docs/FOR-TEAMS.md](docs/FOR-TEAMS.md).
- Recipes of a shared team catalogue (`UNWALLED_TEAM_RECIPES`) are treated like any shared recipe; protect who can write to that folder.

Credentials are only ever sent to the host they were captured for (or set for with `set_credentials`).
The data directory defaults to `~/.unwalled` (`UNWALLED_HOME`). Treat `secrets/`, `profiles/` and `state/` like a password store:
do not commit, sync or share them.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security advisories) on this repository
rather than in a public issue. Include steps to reproduce and the impact.
