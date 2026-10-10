#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`universal-mcp: ${error?.message ?? error}\n`);
  process.exit(1);
});
