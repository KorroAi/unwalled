// Leak test: a HAR full of fake secrets, placed everywhere a real capture can carry one.
// None of them may appear in the shareable recipe, in tool names or in tool descriptions.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Engine } from "../../src/core.js";
import { looksLikeSecret, looksSensitive, redact, redactGraphqlQuery, redactText, redactUrl, scrubRecipe } from "../../src/discovery/secrets.js";

const H = "https://api.trap.test";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJDQU5BUkkxNCJ9.CANARI14sigXy";
const WEBHOOK = "CANARI13xK9mQ2vL7pR4sT8wY1zA3c";

/** [needle, description, entry] */
const CASES = [];
/** @param {string} needle @param {string} label @param {string} method @param {string} url @param {[string, string][]} [headers] @param {unknown} [body] @param {string} [mime] */
function trap(needle, label, method, url, headers = [], body = null, mime = "application/json") {
  CASES.push({
    needle, label,
    entry: {
      _resourceType: "xhr",
      request: {
        method, url, headers: headers.map(([name, value]) => ({ name, value })),
        ...(body != null ? { postData: { mimeType: mime, text: typeof body === "string" ? body : JSON.stringify(body) } } : {}),
      },
      response: { status: 200, content: { mimeType: "application/json", text: JSON.stringify({ ok: true }) } },
    },
  });
}

trap("CANARI01", "Authorization header", "GET", `${H}/v1/a`, [["Authorization", "Bearer CANARI01"]]);
trap("CANARI02", "X-RapidAPI-Key header", "GET", `${H}/v1/b`, [["X-RapidAPI-Key", "CANARI02"]]);
trap("CANARI03", "x-goog-api-key header", "GET", `${H}/v1/c`, [["x-goog-api-key", "CANARI03"]]);
trap("CANARI04", "Ocp-Apim-Subscription-Key header", "GET", `${H}/v1/d`, [["Ocp-Apim-Subscription-Key", "CANARI04"]]);
trap("CANARI05", "X-Client-Key header", "GET", `${H}/v1/e`, [["X-Client-Key", "CANARI05"]]);
trap("CANARI06", "Cookie header", "GET", `${H}/v1/f`, [["Cookie", "sid=CANARI06"]]);
trap("CANARI07", "?access_token", "GET", `${H}/v1/g?access_token=CANARI07`);
trap("CANARI08", "?key", "GET", `${H}/v1/h?key=CANARI08`);
trap("CANARI09", "?private_key", "GET", `${H}/v1/i?private_key=CANARI09`);
trap("CANARI10", "?jwt", "GET", `${H}/v1/i2?jwt=CANARI10`);
trap("CANARI11", "user:password@ in the URL", "GET", `https://user:CANARI11@api.trap.test/v1/j`);
trap("CANARI12", "#access_token fragment", "GET", `${H}/v1/k#access_token=CANARI12`);
trap(WEBHOOK, "token in the path (webhook)", "POST", `${H}/hooks/T000/${WEBHOOK}`, [], { text: "hi" });
trap("CANARI14", "JWT in the path", "GET", `${H}/v1/reset/${JWT}`);
trap("CANARI15", "JSON password", "POST", `${H}/v1/login`, [], { email: "a@b.c", password: "CANARI15" });
trap("CANARI16", "JSON private_key", "POST", `${H}/v1/keys`, [], { name: "x", private_key: "CANARI16" });
trap("CANARI17", "array under a tokens key", "POST", `${H}/v1/multi`, [], { tokens: ["CANARI17"] });
trap("4111 1111 1111 1111", "card number", "POST", `${H}/v1/pay`, [], { card_number: "4111 1111 1111 1111", cvv: "CANARI19" });
trap("CANARI19", "cvv", "POST", `${H}/v1/pay2`, [], { cvv: "CANARI19" });
trap("sk_live_CANARI20abcdefgh", "Stripe key under a neutral name", "POST", `${H}/v1/anon`, [], { value: "sk_live_CANARI20abcdefgh" });
trap("CANARI21", "form pass=", "POST", `${H}/v1/form`, [], "user=a&pass=CANARI21", "application/x-www-form-urlencoded");
trap("CANARI22", "form password=", "POST", `${H}/v1/form2`, [], "user=a&password=CANARI22", "application/x-www-form-urlencoded");
trap("CANARI23", "password written inside a GraphQL query", "POST", `${H}/graphql`, [], { operationName: "Login", query: 'mutation Login { login(email:"a", password:"CANARI23") { id } }', variables: {} });
trap("CANARI24", "GraphQL apiToken variable", "POST", `${H}/graphql`, [], { operationName: "Me", query: "query Me($t: String) { me(t: $t) { id } }", variables: { apiToken: "CANARI24" } });
trap("ghp_CANARI25abcdefghijklmnopqrstu", "GitHub token inside free text", "POST", `${H}/v1/notes`, [], { note: "my key is ghp_CANARI25abcdefghijklmnopqrstu" });
trap("CANARI26", "JWT in a neutral header", "GET", `${H}/v1/m`, [["X-Thing", "eyJhbGciOiJIUzI1NiJ9.eyJDQU5BUkkyNiI6MX0.CANARI26sig"]]);
trap("CANARI27", "random API key in a neutral query parameter", "GET", `${H}/v1/n?k2=CANARI27Zx81Lq0Wm3Np5Rt7Vb9Yc2`);
trap("CANARI28", "secret in the source page URL", "GET", `${H}/v1/o?q=x&session=CANARI28`);

const homes = [];
after(() => homes.forEach((home) => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })));

/** @param {object[]} entries */
async function importHar(entries) {
  const home = mkdtempSync(join(tmpdir(), "unwalled-leak-"));
  homes.push(home);
  const config = /** @type {any} */ ({
    home, recipesDir: join(home, "recipes"), profilesDir: join(home, "profiles"), secretsDir: join(home, "secrets"), stateDir: join(home, "state"), auditFile: null, confirm: "destructive", rateLimit: 0, toolMode: "all", toolThreshold: 60,
    browser: "chrome", maxOutputChars: 40_000, requestTimeoutMs: 5000, maxEndpoints: 200, maxOpenApiTools: 60,
  });
  const harPath = join(home, "trap.har");
  writeFileSync(harPath, JSON.stringify({ log: { version: "1.2", pages: [{ id: "p", title: "https://app.trap.test/?token=CANARI28" }], entries } }));
  const engine = new Engine(config);
  const recipe = await engine.discoverHar({ name: "trap", harPath });
  const tools = engine.toolsOf("trap");
  return {
    engine, home,
    recipeText: readFileSync(join(home, "recipes", "trap.json"), "utf8"),
    secretText: existsSync(join(home, "secrets", "trap.json")) ? readFileSync(join(home, "secrets", "trap.json"), "utf8") : "",
    toolText: JSON.stringify(tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }))),
    recipe, tools,
  };
}

describe("secret leaks", () => {
  for (const { needle, label, entry } of CASES) {
    it(`keeps out of the recipe: ${label}`, async () => {
      const { recipeText, toolText } = await importHar([entry]);
      assert.ok(!recipeText.includes(needle), `${label} leaked into the recipe:\n${recipeText}`);
      assert.ok(!toolText.includes(needle), `${label} leaked into tool names or descriptions`);
    });
  }

  it("keeps everything out when all traps are captured together", async () => {
    const { recipeText, toolText } = await importHar(CASES.map((c) => c.entry));
    for (const { needle, label } of CASES) {
      assert.ok(!recipeText.includes(needle), `${label} leaked`);
      assert.ok(!toolText.includes(needle), `${label} leaked into tools`);
    }
  });

  it("stores replayable credentials in the secret store and still uses them", async () => {
    const { secretText, tools } = await importHar([CASES[1].entry, CASES.find((c) => c.needle === WEBHOOK).entry, CASES[10].entry]);
    for (const needle of ["CANARI02", WEBHOOK]) assert.ok(secretText.includes(needle), `${needle} should be in the secret store`);
    assert.ok(/authorization/.test(secretText), "URL credentials become a Basic authorization header");
    const webhook = tools.find((t) => /hooks/.test(t.name));
    assert.ok(webhook, "webhook tool exists");
    assert.ok(!webhook.inputSchema.required?.includes("path"), "the secret path parameter is optional");
  });
});

describe("secret detectors", () => {
  it("recognises credentials by value", () => {
    for (const value of [JWT, "sk_live_abcdefgh1234", "AKIAABCDEFGHIJKLMNOP", "ghp_abcdefghijklmnopqrstuv", "xoxb-1234567890-abc", "Bearer abc123def456", "Zx81Lq0Wm3Np5Rt7Vb9Yc2Qa4Sd"])
      assert.ok(looksLikeSecret(value), value);
    for (const value of ["hello world", "serde", "2026-10-10T12:00:00Z", "550e8400-e29b-41d4-a716-446655440000", "Basic authentication required", "blue-lamp"])
      assert.ok(!looksLikeSecret(value), value);
    assert.ok(looksSensitive("4111111111111111"));
    assert.ok(!looksSensitive("1234567890123456"), "not a valid card number");
  });

  it("redacts nested values, URLs, form bodies and GraphQL literals", () => {
    assert.deepEqual(redact({ a: { password: { value: "x" } }, list: { tokens: ["t1", "t2"] }, ok: "fine" }), { a: { password: { value: "REDACTED" } }, list: { tokens: ["REDACTED", "REDACTED"] }, ok: "fine" });
    const url = redactUrl("https://u:p@h.test/hooks/Zx81Lq0Wm3Np5Rt7Vb9Yc2Qa4Sd?token=t&q=lamp#x=1");
    assert.equal(url, "https://h.test/hooks/REDACTED?token=REDACTED&q=lamp");
    // Short tokens are recognised by the segment before them; ordinary words and ids there are not secrets.
    assert.equal(redactUrl("https://h.test/hooks/abc123"), "https://h.test/hooks/REDACTED");
    assert.equal(redactUrl("https://h.test/invite/x7k2/accept"), "https://h.test/invite/REDACTED/accept");
    assert.equal(redactUrl("https://h.test/api/tokens/new"), "https://h.test/api/tokens/new");
    assert.equal(redactUrl("https://h.test/keys/42"), "https://h.test/keys/42");
    assert.equal(redactUrl("https://h.test/orders/ab12cd"), "https://h.test/orders/ab12cd");
    assert.equal(redactText("a=1&pass=secret"), "a=1&pass=REDACTED");
    assert.equal(redactGraphqlQuery('mutation { login(user:"a", password:"p") }'), 'mutation { login(user:"a", password:"REDACTED") }');
    assert.deepEqual(scrubRecipe({ d: "x Bearer abc123def456 y", e: "known-secret-value" }, ["known-secret-value"]), { d: "x REDACTED y", e: "REDACTED" });
  });
});
