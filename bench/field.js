// Field test: how often does a single `discover` on a real, unmodified public website give working tools?
//
// For each site: one discover (default options unless noted), then check_recipe, which calls every read-only tool with
// the values seen during capture and reports which ones answer. A site counts as working when at least one tool answers.
// Nothing is tuned per site except the page to open; failures are reported with their reason.
// Run: node bench/field.js [--only id,id]   (writes bench/results/field-<date>.json and bench/FIELD.md)
// node bench/field.js --report bench/results/field-<date>.json   rewrites FIELD.md from a saved run
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { values } = parseArgs({ options: { only: { type: "string" }, report: { type: "string" } } });
const BIN = fileURLToPath(new URL("../bin/unwalled.js", import.meta.url));
const OUT = fileURLToPath(new URL("./results/", import.meta.url));

/**
 * Public pages with no sign-in, chosen for variety (single-page apps, server-rendered pages, protected sites).
 * `ask` is the question used to judge the result: a call to the site's main data tool with a term that was NOT seen
 * during discovery, and a word the answer must contain. `tool` matches the generated tool's name; `operation` is used
 * when the site publishes an OpenAPI description (the tool is then <name>__call).
 */
export const SITES = [
  { id: "crates", kind: "single-page app", url: "https://crates.io/search?q=serde", ask: { tool: /__get_api_v1_crates$/, args: { query: { q: "tokio", per_page: 3 } }, expect: "tokio" } },
  { id: "hn", kind: "search app", url: "https://hn.algolia.com/?q=sqlite", hosts: ["algolia.net"], ask: { tool: /__post_1_indexes_/, args: { body: { query: "postgres", hitsPerPage: 3 } }, expect: "postgres" } },
  { id: "mdn", kind: "documentation search", url: "https://developer.mozilla.org/en-US/search?q=fetch", ask: { tool: /__get_api_v1_search$/, args: { query: { q: "flexbox" } }, expect: "flexbox" } },
  { id: "bluesky", kind: "social network", url: "https://bsky.app/profile/bsky.app", hosts: ["bsky.app"], ask: { tool: /getProfile$/, args: { query: { actor: "atproto.com" } }, expect: "atproto" } },
  { id: "mastodon", kind: "social network", url: "https://mastodon.social/explore", ask: { tool: /__get_api_v1_trends_tags$/, args: { query: { limit: 3 } }, expect: "history" } },
  { id: "flathub", kind: "app store", url: "https://flathub.org/apps/search?q=editor", ask: { tool: /__post_api_v2_search$/, args: { body: { query: "gimp", filters: [], hits_per_page: 3, page: 1 } }, expect: "gimp" } },
  { id: "archive", kind: "library", url: "https://archive.org/search?query=apollo", ask: { tool: /page_production$/, args: { query: { user_query: "hubble", hits_per_page: 3, page: 1 } }, expect: "hubble" } },
  {
    id: "vscode", kind: "extension marketplace", url: "https://marketplace.visualstudio.com/search?term=python&target=VSCode",
    ask: { tool: /extensionquery$/, args: { body: { filters: [{ criteria: [{ filterType: 8, value: "Microsoft.VisualStudio.Code" }, { filterType: 10, value: "rust" }], pageNumber: 1, pageSize: 3, sortBy: 0, sortOrder: 0 }], flags: 914 } }, expect: "rust" },
  },
  { id: "huggingface", kind: "model hub", url: "https://huggingface.co/models?search=whisper", ask: { operation: "get_api_models_namespace_repo_refs", args: { path: { namespace: "google-bert", repo: "bert-base-uncased" } }, expect: "main" } },
  { id: "openlibrary", kind: "library", url: "https://openlibrary.org/search?q=dune", ask: { operation: "search_json_search_json_get", args: { query: { q: "foundation asimov", limit: 3 } }, expect: "Foundation" } },
  { id: "github", kind: "code hosting", url: "https://github.com/modelcontextprotocol/servers/issues", ask: { tool: /_deferred/, args: { path: { modelcontextprotocol: "inspector", param2: "issues" }, query: { q: "is:issue state:open", page: 1 } }, expect: "inspector" } },
  { id: "openstreetmap", kind: "map", url: "https://www.openstreetmap.org/search?query=Lyon", ask: { tool: /nominatim_query$/, args: { query: { query: "Marseille" } }, expect: "Marseille" } },
  { id: "dockerhub", kind: "server-rendered", url: "https://hub.docker.com/search?q=postgres", ask: { tool: /search/, args: { query: { q: "redis" } }, expect: "redis" } },
  { id: "pypi", kind: "server-rendered", url: "https://pypi.org/search/?q=requests", ask: { tool: /search/, args: { query: { q: "flask" } }, expect: "flask" } },
  { id: "wikipedia", kind: "server-rendered", url: "https://en.wikipedia.org/wiki/Model_Context_Protocol", ask: { tool: /page_wiki/, args: { path: { wiki: "SQLite" } }, expect: "Hipp" } },
  { id: "stackoverflow", kind: "server-rendered", url: "https://stackoverflow.com/questions/tagged/node.js", ask: { tool: /questions/, args: {}, expect: "node" } },
  { id: "npm", kind: "protected", url: "https://www.npmjs.com/search?q=playwright", ask: { tool: /search/, args: { query: { q: "vitest" } }, expect: "vitest" } },
  { id: "gitlab", kind: "protected", url: "https://gitlab.com/explore/projects/trending", ask: { tool: /projects/, args: {}, expect: "name" } },
  { id: "reddit", kind: "protected", url: "https://www.reddit.com/r/LocalLLaMA/", ask: { tool: /posts|listing|subreddit/, args: {}, expect: "title" } },
  { id: "leboncoin", kind: "protected", url: "https://www.leboncoin.fr/recherche?text=velo", ask: { tool: /search|finder/, args: {}, expect: "velo" } },
];

async function main() {
  if (values.report) {
    // Rewrites bench/FIELD.md from a saved run (no site is contacted).
    const saved = JSON.parse(readFileSync(values.report, "utf8"));
    writeFileSync(fileURLToPath(new URL("./FIELD.md", import.meta.url)), report(saved.environment, saved.results));
    return;
  }
  const sites = values.only ? SITES.filter((s) => values.only?.split(",").includes(s.id)) : SITES;
  const home = mkdtempSync(join(tmpdir(), "unwalled-field-"));
  const client = new Client({ name: "field", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN], env: { ...process.env, UNWALLED_HOME: home }, stderr: "ignore" }));
  const call = async (name, args) => {
    const started = performance.now();
    try {
      const value = /** @type {any} */ (await client.callTool({ name, arguments: args }, undefined, { timeout: 240_000 }));
      return { text: value.content.map((c) => c.text ?? "").join("\n"), isError: !!value.isError, ms: performance.now() - started };
    } catch (error) {
      return { text: String(error.message), isError: true, ms: performance.now() - started };
    }
  };
  const results = [];
  try {
    for (const site of sites) {
      process.stderr.write(`\n== ${site.id} (${site.url})\n`);
      const discovered = await call("discover", { name: site.id, url: site.url, ...(site.hosts ? { hosts: site.hosts } : {}) });
      const tools = (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith(`${site.id}__`));
      let health = { text: "", counts: {} };
      if (!discovered.isError && tools.length) {
        const checked = await call("check_recipe", { name: site.id });
        const counts = Object.fromEntries([...checked.text.split("\n")[0].matchAll(/(\d+) (\w+)/g)].map((m) => [m[2], Number(m[1])]));
        health = { text: checked.text, counts };
      }
      // The question: the main data tool, called with a term never seen during discovery.
      const ask = site.ask;
      const target = ask.operation ? (tools.includes(`${site.id}__call`) ? `${site.id}__call` : undefined) : tools.find((n) => !!ask.tool?.test(n));
      const answer = target ? await call(target, ask.operation ? { operation: ask.operation, arguments: { ...ask.args, max_chars: 4000 } } : { ...ask.args, max_chars: 4000 }) : undefined;
      const answered = !!answer && !answer.isError && /^HTTP 2/.test(answer.text) && answer.text.toLowerCase().includes(ask.expect.toLowerCase());
      const warnings = discovered.text.split("\n").filter((l) => l.startsWith("Warning: ")).map((l) => l.slice(9));
      const result = {
        id: site.id, kind: site.kind, url: site.url, discoverMs: Math.round(discovered.ms),
        source: /\(openapi\)/.test(discovered.text) ? "OpenAPI found" : "browser capture",
        toolNames: tools, tools: tools.length, answering: health.counts.ok ?? 0, health: health.counts,
        dataTool: target ?? null, answered, answerChars: answer?.text.length ?? 0,
        answerStart: answer?.text.slice(0, 200),
        blocked: warnings.some((w) => w.startsWith("Blocked: ")),
        reason: answered ? undefined : !target ? (warnings[0] ?? "no data tool generated").slice(0, 200) : (answer?.text.split("\n")[0] ?? "").slice(0, 200),
        healthDetail: health.text.split("\n").slice(1, 12),
      };
      process.stderr.write(`   ${result.tools} tools, ${result.answering} healthy, data tool ${target ?? "none"}: ${answered ? "answered" : `NO — ${result.reason}`}\n`);
      results.push(result);
      await call("forget", { name: site.id });
    }
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  const date = new Date().toISOString();
  const environment = { date, node: process.version, os: `${platform()} ${release()}` };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `field-${date.slice(0, 10)}${values.only ? "-partial" : ""}.json`), JSON.stringify({ environment, results }, null, 2));
  if (!values.only) writeFileSync(fileURLToPath(new URL("./FIELD.md", import.meta.url)), report(environment, results));
  process.stderr.write(`\n${results.filter((r) => r.answered).length}/${results.length} sites answered a new question\n`);
}

/** @param {any} environment @param {any[]} results */
function report(environment, results) {
  const answered = results.filter((r) => r.answered);
  const blocked = results.filter((r) => r.blocked);
  const other = results.filter((r) => !r.answered && !r.blocked);
  const rows = results.map(
    (r) =>
      `| ${r.id} | ${r.kind} | ${r.source} | ${r.answered ? "**yes**" : "no"} | ${r.tools} | ${(r.discoverMs / 1000).toFixed(1)} s | ${(r.answered ? `\`${r.dataTool}\`` : r.reason ?? "").replace(/\|/g, "/")} |`,
  );
  return [
    "# Field test: one discover on 20 real websites",
    "",
    `Generated by \`node bench/field.js\` on ${environment.date.slice(0, 10)} (${environment.os}, Node ${environment.node}). Raw data: \`bench/results/field-${environment.date.slice(0, 10)}.json\`.`,
    "",
    "For each public page: one `discover` with default options (no actions, no exploration, no sign-in). Then one question",
    "to the site's main data tool, **with a term never seen during discovery** (discover on \"serde\", ask about \"tokio\").",
    "It counts as answered when the call returns HTTP 2xx and the expected word is in the answer. The list includes",
    "server-rendered and bot-protected sites on purpose, and nothing was tuned per site except the question.",
    "",
    `**${answered.length} of ${results.length} sites answered.** Of the others, ${blocked.length} refused the automated browser (unwalled said so instead of failing silently)` +
      (other.length ? ` and ${other.length} gave no usable data call (${other.map((r) => r.id).join(", ")}).` : "."),
    "",
    "| Site | Kind | Source | Answered | Tools | Discover | Data tool, or why not |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Reading this table",
    "",
    "- \"Kind\" is how the site was classified before the run. Server-rendered sites send their data inside the HTML, not through an API: there is nothing to capture. The `ui` tool, an official API or `import_file` are the way there.",
    "- Bot protections are not bypassed. Discovering with `interactive=true` (you browse in a visible window) or importing a HAR from your own browser are the supported ways.",
    "- A discover with no actions only sees the calls made while the page loads; actions or `explore_pages` find more.",
    "- The questions were written after looking at the generated tools (as an agent does with their descriptions); the term asked was never seen by the discovery.",
    "- Live sites change: rerun to compare.",
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
