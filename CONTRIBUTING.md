# Contributing

Thanks for your interest in improving universal-mcp.

## Setup

```bash
npm install
npm run check
```

`npm run check` runs the type checker, the unit tests and the end-to-end tests. The end-to-end tests start local
fixture websites and drive the server through a real MCP client; they need Chrome or Edge, or Playwright's Chromium
(`npx playwright-core install chromium` and `UNIVERSAL_MCP_BROWSER=chromium`).

Tests against real websites are optional: `UNIVERSAL_MCP_LIVE=1 node --test test/live/`.

## Guidelines

- Plain JavaScript (ES modules) with JSDoc types, checked by `tsc`; no build step.
- Keep `stdout` free of logs: it carries the MCP protocol. Use `log()` from `src/log.js`.
- Never write secrets into recipes. Anything that looks like a credential belongs in the secrets store.
- Add a unit test for inference changes (`test/unit/infer.test.js`) and an end-to-end test for behaviour visible to MCP clients.
- Update `CHANGELOG.md`.

## Reporting bugs

Open an issue with the command or tool call, the site type (SPA, GraphQL, OpenAPI, HAR), the error output, and your
Node.js, OS and browser versions. Do not attach recipes, HAR files or profiles that contain personal data or credentials.
