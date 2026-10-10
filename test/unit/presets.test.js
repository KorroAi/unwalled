import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listPresets, PRESETS, resolvePreset } from "../../src/presets.js";

describe("presets", () => {
  it("resolve catalogue entries and any Google API", () => {
    assert.equal(/** @type {any} */ (resolvePreset("preset:github").source).url.endsWith("api.github.com.json"), true);
    assert.equal(resolvePreset("preset:CoinGecko").id, "coingecko");
    const google = resolvePreset("preset:google:youtube/v3");
    assert.equal(/** @type {any} */ (google.source).url, "https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest");
    assert.throws(() => resolvePreset("preset:nope"), /Unknown preset "nope"\. Presets: github, /);
    assert.match(listPresets(), /google:<api>\/<version>/);
  });

  it("built-in descriptions are valid OpenAPI / AsyncAPI documents", () => {
    for (const [id, preset] of Object.entries(PRESETS)) {
      const source = /** @type {any} */ (preset.source);
      if (source.spec) assert.ok(source.spec.openapi && source.spec.paths && source.spec.servers?.[0]?.url, id);
      if (source.asyncapi) assert.ok(source.asyncapi.asyncapi && source.asyncapi.channels, id);
      if (source.url) assert.match(source.url, /^https:\/\//, id);
    }
  });
});
