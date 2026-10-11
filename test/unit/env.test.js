import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import { defaultHome, env } from "../../src/env.js";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("environment variables after the rename", () => {
  it("reads UNWALLED_ variables", () => {
    process.env.UNWALLED_TIMEOUT_MS = "1234";
    assert.equal(env("TIMEOUT_MS"), "1234");
    assert.equal(loadConfig().requestTimeoutMs, 1234);
  });

  it("still reads the former UNIVERSAL_MCP_ spelling", () => {
    delete process.env.UNWALLED_RATE_LIMIT;
    process.env.UNIVERSAL_MCP_RATE_LIMIT = "2";
    assert.equal(loadConfig().rateLimit, 2);
  });

  it("prefers the new spelling when both are set", () => {
    process.env.UNWALLED_CONFIRM = "writes";
    process.env.UNIVERSAL_MCP_CONFIRM = "none";
    assert.equal(loadConfig().confirm, "writes");
  });

  it("names the new variable in error messages", () => {
    process.env.UNIVERSAL_MCP_RETRIES = "-1";
    delete process.env.UNWALLED_RETRIES;
    assert.throws(() => loadConfig(), /UNWALLED_RETRIES must be a non-negative number/);
  });

  it("keeps using an existing ~/.universal-mcp data directory", () => {
    const fake = mkdtempSync(join(tmpdir(), "unwalled-home-"));
    process.env.HOME = fake;
    process.env.USERPROFILE = fake;
    try {
      assert.equal(defaultHome(), join(fake, ".unwalled"));
      mkdirSync(join(fake, ".universal-mcp"));
      assert.equal(defaultHome(), join(fake, ".universal-mcp"));
      mkdirSync(join(fake, ".unwalled"));
      assert.equal(defaultHome(), join(fake, ".unwalled"));
    } finally {
      rmSync(fake, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  });
});
