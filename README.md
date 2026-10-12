# unwalled

**Let your AI agent use the software that has no API: your back office, intranet, dashboards and portals, plus your API files, spreadsheets and databases.**

https://github.com/user-attachments/assets/14cbfae4-4984-4ca3-a0b6-37a1b19ff0d4

You show unwalled an app once. It records what the app does behind the screen and turns it into tools your agent
(Claude, Cursor, Copilot, any MCP client) calls directly: no clicking through pages, no integration code, nothing to change in the app.
Everything runs on your computer.

## How it works

1. **Show it a source**: open the app once (signing in if needed), or give it a file, an API description or a database address.
2. **unwalled writes the tools**: one typed tool per thing the app can do (list orders, read a customer, search...), saved as a *recipe*.
3. **Your agent uses them**: it asks "order 1042?" and gets the answer in one call, already signed in.

The tools keep working: unwalled stays signed in, renews sessions and retries; when the app changes, it detects the broken tools and can repair the recipe.

![An agent signs in to an internal back office once, then answers questions through generated tools](docs/demo.gif)

<sub>Real calls against the [example back office](examples/intranet/server.js), recorded with [`docs/demo/make-gif.js`](docs/demo/make-gif.js).</sub>

## Get started

You need [Node.js](https://nodejs.org) 22 or newer. In a terminal:

```bash
npx -y unwalled
```

A guided setup then:

1. checks your computer (Node.js, browser, encryption of your secrets);
2. adds unwalled to the AI apps it finds, asking for each one: Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Gemini CLI, Codex;
3. connects your first source, or a demo.

**Any other MCP client** (Zed, Cline, Continue, OpenCode, your own agent...) starts it the standard way:

```json
{ "mcpServers": { "unwalled": { "command": "npx", "args": ["-y", "unwalled"] } } }
```

On Windows, some clients need `"command": "cmd"` with `"args": ["/c", "npx", "-y", "unwalled"]`. unwalled is a plain stdio MCP server:
it works with any model your client uses (Claude, GPT, Gemini, local models), and its tool schemas avoid the JSON Schema features
some providers reject. More clients: [installation](docs/REFERENCE.md#installation).

**Try it in one minute:** choose the demo, or run `unwalled demo`. It starts a sample back office on your computer (orders and customers
behind a sign-in) and connects it. Then ask your agent:

> Using acme, what is the status and total of order 1042? And which customers are in Lyon?

## Connect your own sources

One command per source; unwalled recognises what it is.

| What you have | Command |
| --- | --- |
| An internal app, or any site you sign in to | `unwalled add https://erp.example.com --browse` <br><sub>A window opens: sign in, open the pages your agent will need, close it.</sub> |
| A public website | `unwalled add https://crates.io --explore 10` |
| An API address | `unwalled add "https://api.open-meteo.com/v1/forecast?latitude=45.76&longitude=4.84&current=temperature_2m"` |
| An API description or collection | `unwalled add ./openapi.yaml` (also Postman, Insomnia, Bruno, `.http`, HAR, a list of cURL commands) |
| A spreadsheet or data file | `unwalled add ./sales-2026.xlsx` (also CSV, JSON, SQLite, calendars, RSS, or a whole folder) |
| A database | `unwalled add postgres://reader:secret@db.example.com/shop` (or `mysql://`), always read-only |
| A ready-made service | `unwalled add preset:github`, then `unwalled key github` to store its token |

You can also just ask your agent: *"Discover https://grafana.example.com and tell me which dashboards mention revenue"*,
or *"Import this CSV and summarise it"*. It does the same thing through unwalled's tools.

Other commands: `unwalled list` (your recipes), `unwalled doctor` (check everything), `unwalled setup --remove` (uninstall from your AI apps),
`unwalled --help` (all commands). Without the setup's installation, write `npx -y unwalled` instead of `unwalled`.

## What it connects

| Source | How |
| --- | --- |
| Web apps, also behind a sign-in | The calls the app makes to its own server (REST, GraphQL) become tools |
| Server-rendered tools (Django or Rails admin, PHP, wikis) | Pages become tools returning their tables and fields as JSON; their forms become tools too |
| Mobile and desktop apps | Through a HAR capture of their traffic (mitmproxy, Charles, Proxyman, browser devtools) |
| Documented APIs | OpenAPI / Swagger (found automatically), Postman, Insomnia, Bruno, `.http`, cURL, Google APIs, OData, SOAP, JSON-RPC, AsyncAPI |
| Ready-made services | GitHub, Stripe, Vercel, ElevenLabs, Discord, Binance, CoinGecko, Open-Meteo, every Google API |
| Data | CSV, Excel, JSON, SQLite, iCalendar, RSS / Atom, PostgreSQL, MySQL / MariaDB, queried with read-only SQL |
| Live data | WebSocket, Server-Sent Events, MQTT |

How each one was tested, and its limits: [compatibility table](docs/REFERENCE.md#compatibility).

## Is it worth it?

Measured with a real agent (Claude Code, Sonnet), the same questions asked with unwalled and with a browser agent (Playwright MCP),
every answer checked: 15 runs, 15 right answers ([method and raw data](bench/AGENT.md)).

| Per question, on apps behind a sign-in | Model turns | Cost |
| --- | --- | --- |
| **unwalled** (app already connected) | **3 to 4** | **$0.022 to $0.030** |
| Browser agent | 8 to 9 | $0.055 to $0.059 |

- **Where it pays:** apps you sign in to and use again and again: 1.8 to 2.7 times cheaper per question.
- **Where it does not:** a public page a browser can simply open. There, a browser agent does as well.
- On [20 real public websites](bench/FIELD.md), one automatic discovery answered a new question on 13 of them;
  6 blocked automated browsers (unwalled reports it and does not bypass them).

## Safe by default

- **Your credentials stay yours**: passwords, keys and cookies are kept out of recipes, encrypted on your computer,
  and only ever sent to the site they belong to.
- **Nothing destructive without you**: deletions and risky clicks wait for your confirmation; any call can be previewed first.
- **Databases are read-only**, and you can make any recipe read-only or limit the sites it may reach.
- **Every request is logged** (without bodies or secrets), and the agent is told never to obey instructions found in the data it reads.

More in [SECURITY.md](SECURITY.md).

## For teams

unwalled runs on your machines and needs no change to your tools. For IT, it adds an **organization policy** the agent cannot loosen
(read-only, allowed sites, disabled tools, mandatory audit) and a **shared catalogue**: one person connects a tool, the whole team uses it,
each with their own sign-in. See [For teams](docs/FOR-TEAMS.md).

## Good to know

- **Prefer an official integration when there is one.** If a service offers an API or an MCP server, use it (unwalled can import its description).
- **Not everything can be captured**: requests signed by the page's own code, and desktop windows. Bot protections and CAPTCHAs
  are reported, never bypassed.
- **Use it where you are allowed to.** A service's internal API may be covered by its terms of use, even with your own account.

## Documentation

- [Full reference](docs/REFERENCE.md): every tool and command, guides, configuration, data and secrets, limits
- [For teams](docs/FOR-TEAMS.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)
- Benchmarks: [real agent](bench/AGENT.md), [20 real websites](bench/FIELD.md), [speed and size of calls](bench/RESULTS.md)

## License

[Apache License 2.0](LICENSE) © 2026 Korrocorp (see [NOTICE](NOTICE))
