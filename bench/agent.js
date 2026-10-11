// Agent benchmark: the same questions asked to a real agent (Claude Code, non-interactive), once with unwalled and once
// with a browser MCP server (Playwright MCP, the usual way agents use websites). Nothing is scripted on either side:
// the agent decides what to call. Measured per run: whether the answer is right, model turns, cost, time.
//
// unwalled runs twice per question: "cold" (empty data folder: the agent must discover the site first, then use the
// tools it just created, in the same session) and "warm" (the recipe from the cold run is kept, as in daily use).
//
// Needs Claude Code (`claude`) signed in. Costs real model usage: about 12 runs.
// Run: node bench/agent.js [--model sonnet] [--only id,id]   (writes bench/results/agent-<date>.json and bench/AGENT.md)
// node bench/agent.js --recheck bench/results/agent-<date>.json   re-scores saved answers with the current checks, no new run
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startIntranet } from "../examples/intranet/server.js";

const { values } = parseArgs({ options: { model: { type: "string", default: "sonnet" }, only: { type: "string" }, budget: { type: "string", default: "1" }, sides: { type: "string" }, recheck: { type: "string" } } });
const BIN = fileURLToPath(new URL("../bin/unwalled.js", import.meta.url));
const OUT = fileURLToPath(new URL("./results/", import.meta.url));

/** @typedef {{ id: string, label: string, skip?: () => string | null, prompt: (ctx: any) => string, check: (answer: string, ctx: any) => boolean, expected: (ctx: any) => string }} Task */
/** @type {Task[]} */
const TASKS = [
  {
    id: "intranet",
    label: "Internal back office behind a login (local example app)",
    prompt: (ctx) => `Our back office is at ${ctx.intranet.url}/login (user: alice, password: demo). What are the status and the total amount of order 1042? Answer in one line.`,
    expected: (ctx) => {
      const order = ctx.intranet.orders.find((o) => o.id === 1042);
      return `${order.status}, ${order.total}`;
    },
    check: (answer, ctx) => {
      const order = ctx.intranet.orders.find((o) => o.id === 1042);
      const digits = answer.replace(/[\s,  ]/g, "");
      return answer.toLowerCase().includes(order.status.toLowerCase()) && digits.includes(String(order.total).replace(/[\s,]/g, ""));
    },
  },
  {
    id: "grafana",
    label: "Grafana behind a sign-in (real internal tool, local container)",
    skip: () => (process.env.UNWALLED_GRAFANA_URL ? null : "set UNWALLED_GRAFANA_URL and UNWALLED_GRAFANA_PASSWORD"),
    prompt: () =>
      `Our Grafana is at ${process.env.UNWALLED_GRAFANA_URL}/login (user: admin, password: ${process.env.UNWALLED_GRAFANA_PASSWORD}). Which dashboards have "Revenue" in their title? List their exact titles.`,
    expected: () => GRAFANA_DASHBOARDS.filter((t) => t.includes("Revenue")).join(", "),
    // Both matching titles must be named; agents often also mention the others to say they do not match.
    check: (answer) => GRAFANA_DASHBOARDS.filter((t) => t.includes("Revenue")).every((t) => answer.includes(t)),
  },
  {
    id: "crates",
    label: "crates.io: latest version of a crate",
    prompt: () => "On crates.io (https://crates.io), what is the latest stable version of the Rust crate tokio? Answer in one line.",
    expected: (ctx) => ctx.tokio,
    check: (answer, ctx) => answer.includes(ctx.tokio),
  },
  {
    id: "flathub",
    label: "Flathub: application id of an app",
    prompt: () => "On Flathub (https://flathub.org), what is the application ID of the image editor GIMP? Answer in one line.",
    expected: () => "org.gimp.GIMP",
    check: (answer) => answer.includes("org.gimp.GIMP"),
  },
  {
    id: "osm",
    label: "OpenStreetMap: coordinates of a city",
    prompt: () => "Using the OpenStreetMap website (https://www.openstreetmap.org), what are the latitude and longitude of the city of Marseille, France? Answer in one line with decimal degrees.",
    expected: () => "about 43.30, 5.37",
    check: (answer) => /43\.(2[5-9]|3[0-4])/.test(answer) && /\b5\.(3[3-9]|4[0-2])/.test(answer),
  },
];

// Dashboards created in the Grafana container before the runs.
const GRAFANA_DASHBOARDS = ["Revenue by region", "Revenue forecast 2027", "Server latency", "Support tickets"];

/** Creates the dashboards the Grafana question is about, through Grafana's own API. */
async function seedGrafana() {
  const auth = `Basic ${Buffer.from(`admin:${process.env.UNWALLED_GRAFANA_PASSWORD}`).toString("base64")}`;
  for (const title of GRAFANA_DASHBOARDS) {
    const response = await fetch(`${process.env.UNWALLED_GRAFANA_URL}/api/dashboards/db`, {
      method: "POST", headers: { authorization: auth, "content-type": "application/json" },
      // A fixed uid per title: seeding again replaces the dashboard instead of adding a duplicate.
      body: JSON.stringify({ dashboard: { uid: `unwalled-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 40), title, panels: [] }, overwrite: true }),
    });
    if (!response.ok) throw new Error(`Grafana: ${response.status} ${await response.text()}`);
  }
}

const RULES = {
  unwalled: "Use only the unwalled tools to get the answer.",
  browser: "Use only the browser tools to get the answer.",
};

/**
 * One non-interactive Claude Code run with a single MCP server. Every built-in tool that could reach the web or the
 * disk is disabled, so the answer can only come from that server.
 * @param {string} prompt @param {Record<string, any>} server @param {string} cwd
 */
function runAgent(prompt, server, cwd) {
  const config = join(cwd, "mcp.json");
  writeFileSync(config, JSON.stringify({ mcpServers: server }));
  const name = Object.keys(server)[0];
  const args = [
    "-p", prompt, "--model", values.model, "--output-format", "stream-json", "--verbose",
    "--mcp-config", config, "--strict-mcp-config", "--allowedTools", `mcp__${name}__*`,
    "--disallowedTools", "Bash", "PowerShell", "WebFetch", "WebSearch", "Read", "Write", "Edit", "Glob", "Grep", "Agent", "NotebookEdit", "Skill",
    "--max-budget-usd", values.budget,
  ];
  return new Promise((resolve) => {
    const child = spawn(process.env.CLAUDE_BIN ?? "claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (error) => (err += String(error)));
    const timer = setTimeout(() => child.kill(), 600_000);
    child.on("close", () => {
      clearTimeout(timer);
      const events = out.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      const result = events.find((e) => e.type === "result") ?? {};
      const toolCalls = events
        .filter((e) => e.type === "assistant")
        .flatMap((e) => e.message?.content ?? [])
        .filter((c) => c.type === "tool_use")
        .map((c) => c.name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, ""));
      const init = events.find((e) => e.type === "system" && e.subtype === "init");
      // Every call and the start of its result, to understand what the agent did.
      const results = new Map(
        events
          .filter((e) => e.type === "user")
          .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
          .filter((c) => c.type === "tool_result")
          .map((c) => [c.tool_use_id, (Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join(" ") : String(c.content ?? "")).slice(0, 400)]),
      );
      const trace = events
        .filter((e) => e.type === "assistant")
        .flatMap((e) => e.message?.content ?? [])
        .filter((c) => c.type === "tool_use")
        .map((c) => ({ tool: c.name, input: JSON.stringify(c.input).slice(0, 400), result: results.get(c.id) ?? "" }));
      resolve({
        answer: String(result.result ?? ""), costUsd: result.total_cost_usd ?? null, turns: result.num_turns ?? null,
        ms: result.duration_ms ?? null, toolCalls, trace, serverStatus: init?.mcp_servers ?? null, error: result.is_error ? result.subtype : result.type ? null : err.slice(0, 500) || "no result",
      });
    });
  });
}

/** Re-scores the saved answers of a run with the current checks and rewrites the report (no model call). @param {string} file */
async function recheck(file) {
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const crate = await (await fetch("https://crates.io/api/v1/crates/tokio", { headers: { "user-agent": "unwalled-benchmark" } })).json();
  // The local back office is deterministic: its data does not need the server.
  const intranet = { orders: (await startIntranet()).orders };
  const ctx = { intranet, tokio: saved.results.find((r) => r.task === "crates")?.expected ?? crate.crate.max_stable_version };
  let changed = 0;
  for (const result of saved.results) {
    const task = TASKS.find((t) => t.id === result.task);
    if (!task) continue;
    const ok = task.check(result.answer, ctx);
    if (ok !== result.ok) changed++;
    result.ok = ok;
  }
  saved.environment.rechecked = new Date().toISOString();
  writeFileSync(file, JSON.stringify(saved, null, 2));
  writeFileSync(fileURLToPath(new URL("./AGENT.md", import.meta.url)), report(saved.environment, saved.results));
  process.stderr.write(`${changed} result(s) changed\n`);
  process.exit(0);
}

async function main() {
  if (values.recheck) return recheck(values.recheck);
  const tasks = (values.only ? TASKS.filter((t) => values.only?.split(",").includes(t.id)) : TASKS).filter((t) => {
    const reason = t.skip?.();
    if (reason) process.stderr.write(`skipping ${t.id}: ${reason}\n`);
    return !reason;
  });
  if (tasks.some((t) => t.id === "grafana")) await seedGrafana();
  const intranet = await startIntranet();
  const crate = await (await fetch("https://crates.io/api/v1/crates/tokio", { headers: { "user-agent": "unwalled-benchmark" } })).json();
  const ctx = { intranet, tokio: crate.crate.max_stable_version };
  const results = [];
  try {
    for (const task of tasks) {
      const home = mkdtempSync(join(tmpdir(), "unwalled-agent-"));
      const cwd = mkdtempSync(join(tmpdir(), "unwalled-agent-cwd-"));
      const unwalled = { unwalled: { type: "stdio", command: process.execPath, args: [BIN], env: { UNWALLED_HOME: home } } };
      const browser = { playwright: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@0.0.83", "--headless", "--isolated"] } };
      const prompt = task.prompt(ctx);
      for (const [side, server, rules] of /** @type {const} */ ([["unwalled cold", unwalled, RULES.unwalled], ["unwalled warm", unwalled, RULES.unwalled], ["browser", browser, RULES.browser]]).filter(([side]) => !values.sides || values.sides.split(",").includes(side))) {
        process.stderr.write(`\n== ${task.id} / ${side}\n`);
        const run = /** @type {any} */ (await runAgent(`${prompt}\n${rules}`, server, cwd));
        const ok = task.check(run.answer, ctx);
        process.stderr.write(`   ${ok ? "RIGHT" : "WRONG"} · ${run.turns} turns · $${run.costUsd?.toFixed(3)} · ${Math.round((run.ms ?? 0) / 1000)} s · ${run.toolCalls.join(", ")}\n   ${run.answer.replace(/\s+/g, " ").slice(0, 200)}\n`);
        results.push({ task: task.id, label: task.label, side, ok, expected: task.expected(ctx), ...run });
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  } finally {
    await intranet.close();
  }
  const date = new Date().toISOString();
  const environment = { date, model: values.model, os: `${platform()} ${release()}`, node: process.version };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `agent-${date.slice(0, 10)}${values.only || values.sides ? "-partial" : ""}.json`), JSON.stringify({ environment, results }, null, 2));
  if (!values.only && !values.sides) writeFileSync(fileURLToPath(new URL("./AGENT.md", import.meta.url)), report(environment, results));
}

/** @param {any} environment @param {any[]} results */
function report(environment, results) {
  const sides = ["unwalled cold", "unwalled warm", "browser"];
  const sum = (list, key) => list.reduce((a, r) => a + (r[key] ?? 0), 0);
  const totals = sides.map((side) => {
    const runs = results.filter((r) => r.side === side);
    return `| ${side} | ${runs.filter((r) => r.ok).length}/${runs.length} | ${sum(runs, "turns")} | $${sum(runs, "costUsd").toFixed(2)} | ${Math.round(sum(runs, "ms") / 1000)} s |`;
  });
  const rows = results.map(
    (r) => `| ${r.task} | ${r.side} | ${r.ok ? "right" : "**wrong**"} | ${r.turns ?? "?"} | $${(r.costUsd ?? 0).toFixed(3)} | ${Math.round((r.ms ?? 0) / 1000)} s | ${r.toolCalls.join(", ").replace(/\|/g, "/")} |`,
  );
  return [
    "# Agent benchmark: a real agent with unwalled vs. with a browser",
    "",
    `Generated by \`node bench/agent.js\` on ${environment.date.slice(0, 10)} with Claude Code, model \`${environment.model}\` (${environment.os}). Raw data, including every answer: \`bench/results/agent-${environment.date.slice(0, 10)}.json\`.`,
    "",
    "Same question, same model, nothing scripted: the agent decides what to call. Each run gets a single MCP server, and",
    "every built-in tool that could reach the web or the disk is disabled.",
    "",
    "- **unwalled cold**: empty data folder. The agent has to discover the site, then use the tools it just created, in the same session.",
    "- **unwalled warm**: the recipe saved by the cold run is kept, as in daily use.",
    "- **browser**: [Playwright MCP](https://github.com/microsoft/playwright-mcp), headless, the common way agents use websites.",
    "",
    "| Side | Right answers | Model turns | Cost | Time |",
    "| --- | --- | --- | --- | --- |",
    ...totals,
    "",
    "| Question | Side | Answer | Turns | Cost | Time | Tools called |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Limits",
    "",
    `- ${new Set(results.map((r) => r.task)).size} questions, one run each: an indication, not a statistic. Model behaviour varies between runs; rerun to compare.`,
    ...(environment.rechecked ? [`- The answers were re-scored on ${environment.rechecked.slice(0, 10)} with corrected checks (\`--recheck\`); no run was repeated. The raw answers are in the JSON file.`] : []),
    "- Cost is what Claude Code reports for the run (`total_cost_usd`), including its own system prompt.",
    "- Live sites change; the expected answers are fetched or known independently (see `bench/agent.js`).",
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
