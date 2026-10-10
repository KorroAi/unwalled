// Benchmark: answering the same questions through unwalled tools, or by driving a browser the way browser agents do.
//
// The browser side is a scripted best case for a browser agent: no model deciding what to click, the browser and the
// sign-in are already open, and each question costs one navigation plus one read of the page (Playwright's ARIA
// snapshot, the page format browser agents such as Playwright MCP give to the model). Real agents add model turns.
//
// Measured per question: wall-clock time, characters the model has to read, and whether the expected answer is in it.
// Run: node bench/run.js [--rounds 3] [--offline]   (writes bench/results/<date>.json and bench/RESULTS.md)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright-core";
import { startIntranet } from "../examples/intranet/server.js";

const { values } = parseArgs({ options: { rounds: { type: "string", default: "3" }, offline: { type: "boolean", default: false } } });
const ROUNDS = Math.max(1, Number(values.rounds));
const BIN = fileURLToPath(new URL("../bin/unwalled.js", import.meta.url));
const OUT = fileURLToPath(new URL("./results/", import.meta.url));

const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const timed = async (fn) => {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
};

/**
 * A task: how to set up both sides once, then a list of questions, each answered by one tool call (unwalled) and
 * one page visit (browser). `expected` is checked in both answers, so both sides are held to the same standard.
 * @typedef {{ id: string, label: string, live: boolean,
 *   setup: (ctx: any) => Promise<void>,
 *   questions: (ctx: any) => { ask: string, tool: string, args: any, page: string, expected: string }[],
 *   teardown?: (ctx: any) => Promise<void> }} Task
 */

/** @type {Task[]} */
const TASKS = [
  {
    id: "intranet",
    label: "Internal back office (local): status and total of an order, behind a login",
    live: false,
    async setup(ctx) {
      ctx.intranet = await startIntranet();
      const base = ctx.intranet.url;
      const discovered = await ctx.call("discover", {
        name: "acme", url: `${base}/login`, mode: "browser",
        actions: [{ fill: "#user", text: "alice" }, { fill: "#password", text: "demo" }, { click: "button[type=submit]" }, { goto: "/orders/1001" }],
      });
      ctx.discoverMs = discovered.ms;
      if (discovered.isError) throw new Error(discovered.text);
      ctx.tool = "acme__get_api_v2_orders_order";
      if (!(await ctx.toolNames("acme__")).includes(ctx.tool)) throw new Error(`No order tool generated: ${(await ctx.toolNames("acme__")).join(", ")}`);

      // Browser side: signed in once, before timing (best case).
      ctx.page = await ctx.browser.newPage();
      await ctx.page.goto(`${base}/login`);
      await ctx.page.fill("#user", "alice");
      await ctx.page.fill("#password", "demo");
      await Promise.all([ctx.page.waitForURL(/\/orders/), ctx.page.click("button[type=submit]")]);
    },
    questions: (ctx) =>
      [1003, 1017, 1042, 1088, 1123, 1150, 1177, 1199].map((id) => {
        const order = ctx.intranet.orders.find((o) => o.id === id);
        return { ask: `Status and total of order ${id}`, tool: ctx.tool, args: { path: { order: String(id) }, pick: "status,total" }, page: `${ctx.intranet.url}/orders/${id}`, expected: String(order.total) };
      }),
    teardown: async (ctx) => ctx.intranet?.close(),
  },
  {
    id: "crates",
    label: "crates.io (live): latest version of a Rust crate",
    live: true,
    async setup(ctx) {
      const discovered = await ctx.call("discover", { name: "crates", url: "https://crates.io/search?q=serde", actions: [{ goto: "/crates/serde" }] });
      ctx.discoverMs = discovered.ms;
      if (discovered.isError) throw new Error(discovered.text);
      ctx.page = await ctx.browser.newPage();
      // The expected answers come from the public API itself, independently of both sides.
      ctx.versions = {};
      for (const name of ctx.crates) {
        const data = await (await fetch(`https://crates.io/api/v1/crates/${name}`, { headers: { "user-agent": "unwalled-benchmark" } })).json();
        ctx.versions[name] = data.crate.max_stable_version ?? data.crate.max_version;
      }
    },
    questions: (ctx) =>
      ctx.crates.map((name) => ({
        ask: `Latest version of ${name}`, tool: "crates__get_api_v1_crates_crate", args: { path: { crate: name }, pick: "crate.max_stable_version,crate.max_version" },
        page: `https://crates.io/crates/${name}`, expected: ctx.versions[name],
      })),
  },
  {
    id: "hn",
    label: "Hacker News search (live): top story title for a query",
    live: true,
    async setup(ctx) {
      const discovered = await ctx.call("discover", { name: "hn", url: "https://hn.algolia.com/?q=model%20context%20protocol", mode: "browser", hosts: ["algolia.net"] });
      ctx.discoverMs = discovered.ms;
      if (discovered.isError) throw new Error(discovered.text);
      ctx.tool = (await ctx.toolNames("hn__")).find((n) => n.startsWith("hn__post_1_indexes_"));
      if (!ctx.tool) throw new Error(`No search tool generated: ${(await ctx.toolNames("hn__")).join(", ")}`);
      ctx.page = await ctx.browser.newPage();
      ctx.titles = {};
      for (const query of ctx.queries) {
        const data = await (await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=1`)).json();
        ctx.titles[query] = data.hits[0]?.title ?? "";
      }
    },
    questions: (ctx) =>
      ctx.queries.map((query) => ({
        ask: `Top story for "${query}"`, tool: ctx.tool, args: { body: { query, hitsPerPage: 5, tagFilters: ["story"] }, pick: "hits[*].title" },
        page: `https://hn.algolia.com/?q=${encodeURIComponent(query)}&type=story`,
        // Titles are compared on their first words: the page may highlight or shorten them.
        expected: ctx.titles[query].split(/\s+/).slice(0, 3).join(" "),
      })),
  },
];

async function main() {
  const home = mkdtempSync(join(tmpdir(), "unwalled-bench-"));
  const client = new Client({ name: "bench", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN], env: { ...process.env, UNWALLED_HOME: home, UNWALLED_RATE_LIMIT: "0" }, stderr: "ignore" }));
  const browser = await chromium.launch({ channel: process.env.UNWALLED_BROWSER === "chromium" ? undefined : process.env.UNWALLED_BROWSER || "chrome", headless: true });
  const call = async (name, args) => {
    const { value, ms } = await timed(() => client.callTool({ name, arguments: args }, undefined, { timeout: 240_000 }));
    return { text: /** @type {any} */ (value.content).map((c) => c.text ?? "").join("\n"), isError: !!value.isError, ms };
  };
  const toolNames = async (prefix) => (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith(prefix));
  const results = [];
  try {
    for (const task of TASKS) {
      if (task.live && values.offline) continue;
      const ctx = { call, toolNames, browser, crates: ["tokio", "serde", "rand", "clap", "reqwest", "anyhow"], queries: ["rust", "postgres", "webassembly", "sqlite", "kubernetes", "llm"] };
      process.stderr.write(`\n== ${task.label}\n`);
      try {
        await task.setup(ctx);
      } catch (error) {
        process.stderr.write(`   skipped: ${error.message}\n`);
        results.push({ task: task.id, label: task.label, skipped: String(error.message).slice(0, 300) });
        await task.teardown?.(ctx);
        continue;
      }
      const runs = [];
      const questions = task.questions(ctx);
      for (let round = 1; round <= ROUNDS; round++) {
        for (const q of questions) {
          const tool = await call(q.tool, q.args);
          // Size of the whole response, for the record: agents trim it with pick once they know its shape.
          const { pick, ...unpicked } = q.args;
          const full = round === 1 ? (await call(q.tool, unpicked)).text.length : undefined;
          const page = await timed(async () => {
            await ctx.page.goto(q.page, { waitUntil: "domcontentloaded" });
            // Best case for the browser: the page is read the moment the answer is on screen (an agent cannot know that).
            await ctx.page
              .waitForFunction((text) => document.body.innerText.toLowerCase().includes(text), q.expected.toLowerCase(), { timeout: 20_000, polling: 50 })
              .catch(() => {});
            return ctx.page.locator("body").ariaSnapshot();
          });
          const found = (text) => !!q.expected && text.toLowerCase().includes(q.expected.toLowerCase());
          runs.push({
            round, ask: q.ask, expected: q.expected,
            unwalled: { ms: Math.round(tool.ms), chars: tool.text.length, fullChars: full, ok: !tool.isError && found(tool.text) },
            browser: { ms: Math.round(page.ms), chars: page.value.length, ok: found(page.value) },
          });
          const last = runs[runs.length - 1];
          process.stderr.write(`   ${q.ask.padEnd(36)} unwalled ${String(last.unwalled.ms).padStart(5)} ms ${String(last.unwalled.chars).padStart(6)} ch ${last.unwalled.ok ? "ok" : "MISS"} | browser ${String(last.browser.ms).padStart(5)} ms ${String(last.browser.chars).padStart(6)} ch ${last.browser.ok ? "ok" : "MISS"}\n`);
        }
      }
      const side = (key) => ({
        medianMs: Math.round(median(runs.map((r) => r[key].ms))),
        medianChars: Math.round(median(runs.map((r) => r[key].chars))),
        ...(key === "unwalled" ? { medianFullChars: Math.round(median(runs.filter((r) => r.round === 1).map((r) => r.unwalled.fullChars))) } : {}),
        success: `${runs.filter((r) => r[key].ok).length}/${runs.length}`,
      });
      results.push({ task: task.id, label: task.label, discoverMs: Math.round(ctx.discoverMs), questions: questions.length, rounds: ROUNDS, unwalled: side("unwalled"), browser: side("browser"), runs });
      await ctx.page?.close();
      await task.teardown?.(ctx);
    }
  } finally {
    await browser.close();
    await client.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }

  const date = new Date().toISOString();
  const environment = { date, node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, rounds: ROUNDS };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${date.slice(0, 10)}.json`), JSON.stringify({ environment, results }, null, 2));
  writeFileSync(fileURLToPath(new URL("./RESULTS.md", import.meta.url)), report(environment, results));
  process.stderr.write(`\nWritten bench/RESULTS.md and bench/results/${date.slice(0, 10)}.json\n`);
}

/** @param {any} environment @param {any[]} results */
function report(environment, results) {
  const rows = results
    .filter((r) => !r.skipped)
    .map((r) => {
      const speed = (r.browser.medianMs / r.unwalled.medianMs).toFixed(1);
      const reading = Math.round(r.browser.medianChars / r.unwalled.medianChars);
      return `| ${r.label} | ${r.unwalled.medianMs} ms · ${r.unwalled.medianChars} chars (${r.unwalled.medianFullChars} untrimmed) · ${r.unwalled.success} | ${r.browser.medianMs} ms · ${r.browser.medianChars} chars · ${r.browser.success} | ${speed}× faster, ${reading}× less to read | ${(r.discoverMs / 1000).toFixed(1)} s |`;
    });
  const skipped = results.filter((r) => r.skipped).map((r) => `- ${r.label}: skipped (${r.skipped})`);
  return `# Benchmark: unwalled tools vs. a browser

Generated by \`node bench/run.js\` on ${environment.date.slice(0, 10)} (${environment.os}, Node ${environment.node}, ${environment.cpu}, ${environment.rounds} round(s)).
Raw data: \`bench/results/${environment.date.slice(0, 10)}.json\`.

Same questions, two ways to answer them:

- **unwalled**: one call to a tool generated by a single \`discover\`, through a real MCP client.
- **browser**: a scripted best case for a browser agent. The browser and the sign-in are already open, nothing decides
  what to click, each question costs one navigation and one read of the page as an ARIA snapshot (the format browser
  agents give to the model), and the page is read the very moment the answer appears on screen, which no real agent
  can know. A real agent also adds model turns, so real gaps are larger.
- unwalled answers use \`pick\` to keep only the needed fields, as the tool descriptions suggest; the untrimmed response
  size is shown in brackets.

Each answer is checked against a value obtained independently (the data set for the local app, the public API for live sites).
Times are medians per question; "chars" is what the model has to read (roughly 4 characters per token).

| Task | unwalled (time · chars · correct) | browser (time · chars · correct) | Difference | One-time discover |
| --- | --- | --- | --- | --- |
${rows.join("\n")}
${skipped.length ? `\n${skipped.join("\n")}\n` : ""}
## Limits

- Live sites change and their speed depends on the network: rerun to compare on your machine.
- The browser side is deliberately favourable (no model, warm browser, already signed in); it is a lower bound for browser agents.
- unwalled needs one discovery per site (last column). It pays off after a few questions; for a one-off question on an
  unknown site, a browser agent can be the simpler choice.
`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
