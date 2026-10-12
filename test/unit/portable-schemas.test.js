import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import { Engine } from "../../src/core.js";
import { MANAGEMENT_TOOLS } from "../../src/server.js";

const PETSTORE = fileURLToPath(new URL("../fixtures/petstore.yaml", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "unwalled-portable-"));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));

// Keywords some model providers reject in tool schemas (Gemini, OpenAI, Bedrock...): unwalled's tools avoid them all.
const UNPORTABLE = new Set(["$ref", "$defs", "definitions", "allOf", "not", "if", "then", "else", "patternProperties", "$schema"]);

/** @param {any} schema @param {string} path @param {string[]} problems */
function audit(schema, path, problems) {
  if (!schema || typeof schema !== "object") return;
  for (const key of Object.keys(schema)) if (UNPORTABLE.has(key)) problems.push(`${path}.${key}`);
  if (Array.isArray(schema.type)) problems.push(`${path}: type ${JSON.stringify(schema.type)}`);
  if (schema.type === "array" && !schema.items) problems.push(`${path}: array without items`);
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) problems.push(`${path}: property ${JSON.stringify(key)}`);
    audit(value, `${path}.${key}`, problems);
  }
  audit(schema.items, `${path}[]`, problems);
  if (typeof schema.additionalProperties === "object") audit(schema.additionalProperties, `${path}.*`, problems);
  for (const key of ["anyOf", "oneOf"]) for (const [i, part] of (schema[key] ?? []).entries()) audit(part, `${path}.${key}[${i}]`, problems);
}

/** @param {{ name: string, inputSchema: any }[]} tools */
function problemsOf(tools) {
  const problems = [];
  for (const tool of tools) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) problems.push(`name ${tool.name}`);
    if (tool.inputSchema.type !== "object") problems.push(`${tool.name}: top-level type`);
    for (const key of ["anyOf", "oneOf", "enum"]) if (tool.inputSchema[key]) problems.push(`${tool.name}: top-level ${key}`);
    audit(tool.inputSchema, tool.name, problems);
  }
  return problems;
}

describe("tool schemas every model provider accepts", () => {
  it("management tools", () => {
    assert.deepEqual(problemsOf(MANAGEMENT_TOOLS), []);
  });

  it("generated tools", async () => {
    process.env.UNWALLED_HOME = join(root, "generated");
    const engine = new Engine(loadConfig());
    try {
      await engine.importFile({ name: "pets", path: PETSTORE, baseUrl: "https://pets.example/v1" });
      const tools = [...engine.tools.values()];
      assert.ok(tools.length > 0);
      assert.deepEqual(problemsOf(tools), []);
    } finally {
      await engine.close();
    }
  });

  it("resets without null: policy.reset, empty header value, annotation reset", async () => {
    process.env.UNWALLED_HOME = join(root, "reset");
    const engine = new Engine(loadConfig());
    try {
      await engine.importFile({ name: "pets", path: PETSTORE, baseUrl: "https://pets.example/v1" });
      assert.deepEqual(engine.configure("pets", { policy: { readOnly: true, rateLimit: 2 } }).policy, { readOnly: true, rateLimit: 2 });
      assert.deepEqual(engine.configure("pets", { policy: { reset: true, confirm: "writes" } }).policy, { confirm: "writes" });
      assert.deepEqual(engine.configure("pets", { policy: { reset: true } }).policy, {});
      assert.deepEqual(engine.configure("pets", { policy: null }).policy, {}, "null still works");
      engine.configure("pets", { headers: { "accept-language": "fr", "x-api-version": "2" } });
      assert.deepEqual(engine.configure("pets", { headers: { "accept-language": "" } }).headers, { "x-api-version": "2" });
      engine.annotateRecipe("pets", { pets__list_pets: { name: "all_pets" } });
      assert.ok(engine.tools.has("pets__all_pets"));
      engine.annotateRecipe("pets", { pets__all_pets: { reset: true } });
      assert.ok(engine.tools.has("pets__list_pets") && !engine.tools.has("pets__all_pets"));
      assert.deepEqual(engine.recipe("pets").annotations, {});
    } finally {
      await engine.close();
    }
  });
});
