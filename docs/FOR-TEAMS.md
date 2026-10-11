# unwalled for teams

Most companies run internal tools that no AI agent can use: a back office, an ERP screen, an intranet, a SOAP service
from 2009, a reporting portal. They have no public API and no documentation, and rewriting them is never the priority.

unwalled makes them usable by agents **without changing them and without writing integration code**: someone signs in
once and shows the agent the screens; unwalled records the calls those screens make and turns them into typed tools.
Everything runs on the employee's machine or a company server: no data goes to a third party.

This page covers what a team or an IT department needs on top of the [reference](REFERENCE.md):
rules that agents cannot change, a shared catalogue of recipes, and what is logged.

## Try it on the example back office

`examples/intranet` is a small back office behind a login form, like many internal tools. `unwalled demo` starts it and
discovers it for you; to see the agent do the discovery itself, start only the back office:

```bash
node examples/intranet/server.js 8099        # sign in as alice / demo
```

Then ask your agent:

> Use unwalled to discover http://127.0.0.1:8099/login: sign in as alice with password demo, then open order 1001,
> the customers page and customer 512. After that, tell me the status and total of orders 1042 and 1150,
> list the orders waiting for payment, and tell me how much customer 530 has ordered in total.

The agent signs in through a real browser once, then answers every question with one tool call
(`acme__get_api_v2_orders_order`, `acme__get_api_v2_orders`...), with the session kept. Its customer pages are
server-rendered, like a Django or Rails admin: they become `acme__page_customers` and `acme__page_customers_customer`,
which return the page's table rows and fields as JSON, and the "add a note" form becomes a tool whose CSRF field is filled for you.
On this app, a tool call answers in about 20 ms with under 100 characters to read, where reading the page in a browser
takes about 54 ms and 1,100 characters even in the most favourable setup ([benchmark](../bench/RESULTS.md)). With a real agent,
a question costs 3 model turns instead of 9 with a browser agent ([agent benchmark](../bench/AGENT.md)).

## Organization policy: rules agents cannot loosen

An administrator writes a JSON file and points `UNWALLED_ORG_POLICY` to it (for instance in the MCP client configuration
deployed to employees, with the file in a folder they cannot write to):

```json
{
  "readOnly": true,
  "allowedHosts": ["erp.acme.internal", "intranet.acme.internal"],
  "confirm": "writes",
  "disabledTools": ["ui", "oauth_login"],
  "audit": true
}
```

| Setting | Effect |
| --- | --- |
| `readOnly` | Every write is refused, in every recipe: HTTP calls, interface actions, WebSocket frames and MQTT publishing. Reads keep working. |
| `allowedHosts` | The only hosts any tool may reach (subdomains included). Checked before anything is contacted: discovery, sign-in, imports of remote files and databases, every generated tool, streams, and pages the interface tool lands on. |
| `confirm` | Minimum confirmation level (`destructive` or `writes`): a recipe can ask for more, never for less. |
| `disabledTools` | Management tools that are hidden from the agent and refused (for example `ui`, `discover`, `oauth_login`, `import_file`). |
| `audit` | Keeps the audit log on even if `UNWALLED_AUDIT=0` is set. |

The rules are applied on top of each recipe's own policy, and nothing the agent can call (`configure_recipe`, a new
or imported recipe, a macro) relaxes them. The agent is told which rules apply, so it does not keep trying.

A policy file that is named but missing, unreadable or invalid (an unknown setting, a misspelt tool name) **stops the
server** instead of running without the rules. Check a file before deploying it:

```bash
UNWALLED_ORG_POLICY=/etc/unwalled/policy.json unwalled policy
```

What the policy does not do: it governs what agents can do through unwalled. A person with a shell on the same machine
can still run other programs; protect the policy file and the data directory with the operating system's permissions.

## Shared recipe catalogue

One person discovers an internal tool; the whole team uses the result. Point `UNWALLED_TEAM_RECIPES` to a shared folder
(a network share, or a Git repository everyone pulls):

```bash
unwalled export erp /shared/unwalled-recipes/erp.json    # publish (recipes never contain secrets)
UNWALLED_TEAM_RECIPES=/shared/unwalled-recipes           # in each person's MCP client configuration
```

- Team recipes are only read. Each person keeps their own credentials, browser profile and policy: signing in is personal.
- Changing a team recipe (renaming tools, adding macros) saves a personal copy that takes precedence; deleting that copy
  brings the team's version back. A team recipe cannot be deleted from a personal installation.
- New or updated recipes in the folder are picked up when the agent lists recipes, without a restart.
- If the folder is unavailable (offline share), personal recipes keep working.
- Recipes from the catalogue get the same protections as any shared recipe: saved defaults and macros can never confirm
  a call held for confirmation, or read or write local files.

## What is stored and logged

- **Recipes** (shareable): endpoints, schemas, redacted examples. Credentials are detected and moved out before saving.
- **Secrets** (per person, encrypted at rest with Windows DPAPI or a passphrase): headers, tokens, cookies. Saved session
  cookies and the local state (which holds the sign-in steps used during discovery) are encrypted the same way.
- **Audit log** (`<home>/audit.log`, JSON Lines, rotated at 5 MB): time, recipe, tool, method, redacted URL, status,
  and blocked calls. No request or response bodies, no credentials.

See [SECURITY.md](../SECURITY.md) for the threat model and how to report a vulnerability.

## Good to know before rolling it out

- Deploying to many machines: `npm install --global github:KorroAi/unwalled`, then `unwalled setup --yes` adds it to every AI app
  found on the machine without questions (Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Gemini CLI, Codex), and
  `unwalled doctor` reports what is missing (exit code 1 on a blocking problem). Set `UNWALLED_ORG_POLICY` and
  `UNWALLED_TEAM_RECIPES` in the environment the apps start from.

- Captured internal APIs change when the tool is updated: `unwalled check <recipe> --repair` (or the `check_recipe` tool)
  detects broken tools and rediscovers them.
- Tools that render their pages on the server (Django or Rails admin, PHP back offices) become page tools: tables and
  fields come back as JSON, and their HTML forms become tools. Requests signed by the page's own JavaScript cannot be
  replayed: the agent can still use those screens through the `ui` tool (unless the policy disables it).
- A call that lands on the sign-in page (the session ended) is reported as such, never read as data.
- Using a vendor's internal API may be restricted by its license or terms, even for your own data. For software you build
  or own, there is no such question.
