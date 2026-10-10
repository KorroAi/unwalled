// Logging goes to stderr: stdout is reserved for the MCP stdio protocol.

/** @param {...unknown} parts */
export function log(...parts) {
  process.stderr.write(`[universal-mcp] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`);
}
