# Contributing

Thanks for your interest in improving unwalled.

## Setup

```bash
npm install
npm run check
```

`npm run check` runs the type checker, the unit tests and the end-to-end tests. The end-to-end tests start local
fixture websites and drive the server through a real MCP client; they need Chrome or Edge, or Playwright's Chromium
(`npx playwright-core install chromium` and `UNWALLED_BROWSER=chromium`).

Tests against real services are optional:

- `UNWALLED_LIVE=1 npm run test:live`: public websites and APIs (crates.io, Hacker News, Petstore, OData, SOAP, Binance...).
- `test/live/postgres.test.js`, `test/live/mysql.test.js`, `test/live/grafana.test.js`: real servers in Docker; each file says how to start its container.
- `node bench/field.js` (20 real websites) and `node bench/agent.js` (a real agent through Claude Code; it costs model usage).

## Guidelines

- Plain JavaScript (ES modules) with JSDoc types, checked by `tsc`; no build step.
- Keep `stdout` free of logs: it carries the MCP protocol. Use `log()` from `src/log.js`.
- Never write secrets into recipes. Anything that looks like a credential belongs in the secrets store.
- Add a unit test for inference changes (`test/unit/infer.test.js`, or `test/unit/infer-realworld.test.js` for cases found on a real site)
  and an end-to-end test for behaviour visible to MCP clients.
- Anything that can end up in a recipe goes through `src/discovery/secrets.js`; extend the leak test (`test/unit/secrets.test.js`) when you add a new place where captured values are stored.
- Calls that change data must stay behind the safety policy (`src/safety.js`): never let a recipe confirm calls, write or upload local files by itself.
- Update `CHANGELOG.md`.

## Reporting bugs

Open an issue with the command or tool call, the site type (SPA, GraphQL, OpenAPI, HAR), the error output, and your
Node.js, OS and browser versions. Do not attach recipes, HAR files or profiles that contain personal data or credentials.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), like the rest of the project.
