// Records the README demo and renders it as docs/demo.gif.
// Every tool call and output shown is real: the script runs unwalled through an MCP client against the example
// back office (examples/intranet), keeps what came back and how long it took, then draws it as a terminal session.
// Needs Chrome (or UNWALLED_BROWSER) and ffmpeg on the PATH. Run: node docs/demo/make-gif.js
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright-core";
import { startIntranet } from "../../examples/intranet/server.js";

const BIN = fileURLToPath(new URL("../../bin/unwalled.js", import.meta.url));
const OUTPUT = fileURLToPath(new URL("../demo.gif", import.meta.url));

/** Runs the scenario for real and returns the transcript lines. */
async function record() {
  const home = mkdtempSync(join(tmpdir(), "unwalled-demo-"));
  const intranet = await startIntranet(8099);
  const client = new Client({ name: "demo", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN], env: { ...process.env, UNWALLED_HOME: home }, stderr: "ignore" }));
  const call = async (name, args) => {
    const started = performance.now();
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 240_000 });
    const text = /** @type {any} */ (result.content)[0].text;
    if (result.isError) throw new Error(text);
    return { text, ms: performance.now() - started };
  };
  /** @type {{ kind: string, text: string }[]} */
  const lines = [];
  try {
    lines.push({ kind: "user", text: "Discover our back office at http://127.0.0.1:8099 (sign in as alice / demo) and open order 1001." });
    lines.push({ kind: "call", text: 'discover(name="acme", url="./login", actions=[sign in as alice, goto /orders/1001])' });
    const discovered = await call("discover", {
      name: "acme", url: `${intranet.url}/login`, mode: "browser",
      actions: [{ fill: "#user", text: "alice" }, { fill: "#password", text: "demo" }, { click: "button[type=submit]" }, { goto: "/orders/1001" }],
    });
    const endpoints = discovered.text.split("\n").filter((l) => /^\s+(GET|POST|PUT|PATCH|DELETE) /.test(l)).map((l) => l.trim().replace(/^(\w+) http:\/\/127\.0\.0\.1:\d+/, "$1 ").replace(/ \(\d+×\)$/, ""));
    lines.push({ kind: "out", text: `Discovered in ${(discovered.ms / 1000).toFixed(1)} s · signed in once, session kept · ${endpoints.length} endpoints → typed tools:` });
    for (const endpoint of endpoints.slice(0, 4)) lines.push({ kind: "dim", text: `  ${endpoint}` });

    lines.push({ kind: "user", text: "What are the status and total of order 1042?" });
    lines.push({ kind: "call", text: 'acme__get_api_v2_orders_order(path={order: "1042"}, pick="status,total")' });
    const order = await call("acme__get_api_v2_orders_order", { path: { order: "1042" }, pick: "status,total" });
    lines.push({ kind: "out", text: `${order.text.split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim()}   (${Math.round(order.ms)} ms)` });

    lines.push({ kind: "user", text: "Which orders are still waiting for payment?" });
    lines.push({ kind: "call", text: 'acme__get_api_v2_orders(query={status: "pending", per_page: 5}, pick="orders[*].id")' });
    const pending = await call("acme__get_api_v2_orders", { query: { status: "pending", per_page: 5 }, pick: "orders[*].id" });
    lines.push({ kind: "out", text: `${pending.text.split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim()}   (${Math.round(pending.ms)} ms)` });
    lines.push({ kind: "note", text: "No API docs, no integration code: the agent now uses the back office through tools." });
  } finally {
    await client.close();
    await intranet.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  return lines;
}

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const PREFIX = { user: '<span class="you">you</span> ', call: '<span class="agent">agent →</span> ', out: "        ", dim: "        ", note: "" };

/** @param {{ kind: string, text: string }[]} lines @param {number} shown @param {number} typed characters of the last line */
function frameHtml(lines, shown, typed) {
  const rows = lines.slice(0, shown).map((line, index) => {
    const text = index === shown - 1 ? line.text.slice(0, typed) : line.text;
    const cursor = index === shown - 1 && typed < line.text.length ? '<span class="cursor">▌</span>' : "";
    return `<div class="${line.kind}">${PREFIX[line.kind]}${escape(text)}${cursor}</div>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#0f172a;font:15px/1.55 "Cascadia Mono",Consolas,"SFMono-Regular",monospace;color:#e2e8f0}
.win{margin:18px;border-radius:10px;background:#111827;box-shadow:0 8px 30px #0008;overflow:hidden;height:438px}
.bar{background:#1f2937;padding:8px 12px;color:#94a3b8;font-size:13px}.bar b{color:#f8fafc}.dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:6px}
.body{padding:12px 16px;white-space:pre-wrap;word-break:break-word}.you{color:#38bdf8;font-weight:bold}.agent{color:#a78bfa;font-weight:bold}
.user{margin-top:10px;color:#f8fafc}.call{color:#c4b5fd}.out{color:#86efac}.dim{color:#94a3b8}.note{margin-top:12px;color:#fbbf24}.cursor{color:#f8fafc}
</style></head><body><div class="win"><div class="bar"><span class="dot" style="background:#ef4444"></span><span class="dot" style="background:#f59e0b"></span><span class="dot" style="background:#22c55e"></span>
<b>unwalled</b> · an AI agent using an internal back office (real calls, recorded)</div><div class="body">${rows.join("")}</div></div></body></html>`;
}

async function render(lines) {
  const frames = mkdtempSync(join(tmpdir(), "unwalled-frames-"));
  const browser = await chromium.launch({ channel: process.env.UNWALLED_BROWSER || "chrome" });
  const page = await browser.newPage({ viewport: { width: 980, height: 474 } });
  /** @type {{ file: string, seconds: number }[]} */
  const list = [];
  const shot = async (shown, typed, seconds) => {
    await page.setContent(frameHtml(lines, shown, typed));
    const file = join(frames, `${String(list.length).padStart(4, "0")}.png`);
    await page.screenshot({ path: file });
    list.push({ file, seconds });
  };
  try {
    for (let i = 1; i <= lines.length; i++) {
      const line = lines[i - 1];
      if (line.kind === "user" || line.kind === "call") {
        // Typed out, a few characters per frame.
        const step = line.kind === "user" ? 4 : 7;
        for (let typed = step; typed < line.text.length; typed += step) await shot(i, typed, 0.04);
      }
      await shot(i, line.text.length, line.kind === "out" ? 1.1 : line.kind === "note" ? 4 : line.kind === "dim" ? 0.25 : 0.6);
    }
  } finally {
    await browser.close();
  }
  const concat = list.map(({ file, seconds }) => `file '${file.replace(/\\/g, "/")}'\nduration ${seconds}`).join("\n") + `\nfile '${list[list.length - 1].file.replace(/\\/g, "/")}'\n`;
  writeFileSync(join(frames, "list.txt"), concat);
  const palette = join(frames, "palette.png");
  const input = ["-f", "concat", "-safe", "0", "-i", join(frames, "list.txt")];
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...input, "-vf", "fps=12,palettegen=max_colors=64", palette]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...input, "-i", palette, "-lavfi", "fps=12[x];[x][1:v]paletteuse=dither=none", "-loop", "0", OUTPUT]);
  rmSync(frames, { recursive: true, force: true });
}

const lines = await record();
for (const line of lines) console.log(`${line.kind.padEnd(5)} ${line.text}`);
mkdirSync(fileURLToPath(new URL("..", import.meta.url)), { recursive: true });
await render(lines);
console.log(`\nWritten ${OUTPUT}`);
