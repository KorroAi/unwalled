import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import { buildStreamTools } from "../../src/realtime/tools.js";
import { checkPolicy, describeOrgPolicy, intentOf, loadOrgPolicy } from "../../src/safety.js";
import { orgAddressBlock } from "../../src/server.js";

const dir = mkdtempSync(join(tmpdir(), "unwalled-org-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

let count = 0;
/** @param {any} content */
function policyFile(content) {
  const file = join(dir, `policy-${++count}.json`);
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

/** @param {string} method @param {string} address @returns {{ intent: import("../../src/safety.js").Intent, url: URL, confirmed: boolean }} */
const call = (method, address, confirmed = false) => ({ intent: intentOf(method), url: new URL(address), confirmed });

describe("organization policy file", () => {
  it("is optional", () => {
    assert.equal(loadOrgPolicy(undefined), null);
    assert.equal(loadOrgPolicy(""), null);
  });

  it("reads the rules and normalises host names", () => {
    const policy = loadOrgPolicy(policyFile({ readOnly: true, allowedHosts: ["ERP.corp.example"], confirm: "writes", disabledTools: ["ui"], audit: true }));
    assert.deepEqual(policy, { readOnly: true, allowedHosts: ["erp.corp.example"], confirm: "writes", disabledTools: ["ui"], audit: true });
  });

  it("refuses to start with a missing or invalid file instead of running without the rules", () => {
    assert.throws(() => loadOrgPolicy(join(dir, "missing.json")), /Cannot read the organization policy/);
    assert.throws(() => loadOrgPolicy(policyFile("{ not json")), /Cannot read the organization policy/);
    assert.throws(() => loadOrgPolicy(policyFile([])), /expected a JSON object/);
    assert.throws(() => loadOrgPolicy(policyFile({ readonly: true })), /unknown setting\(s\) readonly/);
    assert.throws(() => loadOrgPolicy(policyFile({ readOnly: "yes" })), /readOnly must be true or false/);
    assert.throws(() => loadOrgPolicy(policyFile({ confirm: "always" })), /confirm must be one of/);
    assert.throws(() => loadOrgPolicy(policyFile({ allowedHosts: ["https://erp.corp"] })), /allowedHosts must be a list of names/);
  });

  it("is loaded from UNWALLED_ORG_POLICY and keeps the audit log on when it asks to", () => {
    process.env.UNWALLED_HOME = dir;
    process.env.UNWALLED_AUDIT = "0";
    assert.equal(loadConfig().auditFile, null);
    process.env.UNWALLED_ORG_POLICY = policyFile({ audit: true });
    assert.equal(loadConfig().auditFile, join(dir, "audit.log"));
    assert.deepEqual(loadConfig().orgPolicy, { audit: true });
  });

  it("is described to the agent in one line", () => {
    assert.equal(describeOrgPolicy(null), "");
    assert.match(describeOrgPolicy({ readOnly: true, allowedHosts: ["erp.corp"], confirm: "writes", disabledTools: ["ui"] }), /read-only.*only these hosts: erp\.corp.*every write.*disabled tools: ui/);
  });
});

describe("organization policy enforcement", () => {
  const org = { readOnly: true, allowedHosts: ["erp.corp"] };

  it("blocks hosts outside the allowed list, even when the recipe allows them", () => {
    const decision = checkPolicy({ allowedHosts: ["evil.example"] }, call("GET", "https://evil.example/x"), "destructive", org);
    assert.equal(decision?.blocked, true);
    assert.match(decision?.reason ?? "", /organization policy: evil\.example is not an allowed host/);
    assert.equal(checkPolicy({}, call("GET", "https://api.erp.corp/x"), "destructive", org), null, "subdomains are allowed");
  });

  it("makes every recipe read-only, whatever the recipe says", () => {
    const decision = checkPolicy({ readOnly: false }, call("POST", "https://erp.corp/orders", true), "none", org);
    assert.equal(decision?.blocked, true);
    assert.match(decision?.reason ?? "", /organization policy: every recipe is read-only/);
  });

  it("only ever raises the confirmation level", () => {
    const strict = { confirm: /** @type {const} */ ("writes") };
    assert.match(checkPolicy({ confirm: "none" }, call("POST", "https://erp.corp/x"), "none", strict)?.reason ?? "", /needs confirmation/);
    assert.equal(checkPolicy({ confirm: "none" }, call("POST", "https://erp.corp/x", true), "none", strict), null);
    const lax = { confirm: /** @type {const} */ ("none") };
    assert.match(checkPolicy({ confirm: "writes" }, call("POST", "https://erp.corp/x"), "destructive", lax)?.reason ?? "", /needs confirmation/, "a lax organization setting does not loosen a recipe");
  });

  it("checks the addresses management tools are about to open", () => {
    assert.equal(orgAddressBlock(null, { url: "https://anything.example" }), null);
    assert.match(orgAddressBlock(org, { url: "https://other.example/app" }) ?? "", /other\.example is not an allowed host/);
    assert.equal(orgAddressBlock(org, { url: "https://erp.corp/app" }), null);
    assert.match(orgAddressBlock(org, { path: "postgres://u:p@db.other.example:5432/x" }) ?? "", /db\.other\.example:5432/);
    assert.equal(orgAddressBlock(org, { path: "C:/data/sales.csv" }), null, "local files are not addresses");
    assert.match(orgAddressBlock(org, { host: "github.com" }) ?? "", /github\.com/);
    assert.match(orgAddressBlock(org, { token_url: "https://login.other.example/token" }) ?? "", /login\.other\.example/);
  });

  it("is enforced by the engine itself, so the command line and presets follow it too", async () => {
    process.env.UNWALLED_HOME = join(dir, "engine-home");
    const { Engine } = await import("../../src/core.js");
    const engine = new Engine({ ...loadConfig(), orgPolicy: org });
    try {
      await assert.rejects(engine.discover({ name: "x", url: "https://other.example/app" }), /other\.example is not an allowed host/);
      await assert.rejects(engine.discover({ name: "x", url: "https://erp.corp/app", actions: [{ goto: "https://other.example/" }] }), /other\.example/);
      await assert.rejects(engine.discover({ name: "gh", url: "preset:github" }), /not an allowed host/);
      await assert.rejects(engine.importFile({ name: "db", path: "postgres://u:p@db.other.example:5432/x" }), /db\.other\.example/);
      await assert.rejects(engine.login({ name: "x", url: "https://other.example/login" }), /not an allowed host/);
    } finally {
      await engine.close();
    }
  });
});

describe("stream tools and the safety policy", () => {
  const recipe = {
    name: "home",
    streams: [{ id: "bus", kind: "mqtt", url: "mqtt://broker.local:1883", topics: ["home/#"], send: [], messageTypes: [], messageShape: "", samples: [], observed: 1, received: 0 }],
  };

  it("checks a stream before connecting, and counts publishing as a write", async () => {
    /** @type {any[]} */ const checks = [];
    let connected = false;
    const runtime = {
      maxOutputChars: 1000,
      streamAuth: async () => {
        connected = true;
        return { headers: {}, query: {}, frames: {} };
      },
      guard: (_recipe, url, intent, confirmed) => {
        checks.push({ url, intent, confirmed });
        return { text: "Blocked: read-only", isError: true };
      },
    };
    const [tool, generic] = buildStreamTools(recipe, /** @type {any} */ (runtime), (suffix) => `home__${suffix}`);
    const listened = await tool.run({ duration_seconds: 1 });
    const published = await tool.run({ publish: [{ topic: "home/light", message: "on" }], confirm: true });
    const viaGeneric = await generic.run({ url: "mqtt://broker.local:1883", topics: ["home/#"], publish: [{ topic: "home/light", message: "on" }] });
    assert.equal(connected, false, "nothing is contacted when the policy refuses");
    assert.deepEqual(checks, [
      { url: "mqtt://broker.local:1883", intent: "read", confirmed: false },
      { url: "mqtt://broker.local:1883", intent: "write", confirmed: true },
      { url: "mqtt://broker.local:1883", intent: "write", confirmed: false },
    ]);
    for (const result of [listened, published, viaGeneric]) assert.deepEqual(result, { text: "Blocked: read-only", isError: true });
  });
});
