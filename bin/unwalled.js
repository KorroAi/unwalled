#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`unwalled: ${error?.message ?? error}\n`);
  process.exit(1);
});
