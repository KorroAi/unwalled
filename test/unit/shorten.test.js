// Large responses are shown shortened with their field paths (crates.io's crate endpoint answers 445,000 characters).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatResponse } from "../../src/tools/http.js";
import { fieldPaths, shortenJson } from "../../src/tools/shorten.js";

const big = {
  crate: { name: "tokio", max_stable_version: "1.53.2", description: "x".repeat(2000), keywords: ["async", "net", "io", "rt"] },
  versions: Array.from({ length: 300 }, (_, i) => ({ id: i, num: `1.${i}.0`, features: { full: ["a", "b"] } })),
};
const response = (body) => ({ status: 200, statusText: "OK", contentType: "application/json", body: Buffer.from(JSON.stringify(body)), finalUrl: "https://h.test/x" });

describe("shortened responses", () => {
  it("keeps every key, cuts lists and long texts, and fits the budget", () => {
    const text = shortenJson(big, 2000);
    assert.ok(text.length <= 2000, String(text.length));
    const view = JSON.parse(text);
    assert.equal(view.crate.max_stable_version, "1.53.2");
    assert.match(view.crate.description, /… \(2000 chars\)$/);
    assert.match(String(view.versions.at(-1)), /more items$/);
  });

  it("lists the paths pick accepts, once each", () => {
    const paths = fieldPaths(big);
    for (const expected of ["crate.name", "crate.max_stable_version", "crate.keywords", "versions[*].num", "versions[*].features.full"]) assert.ok(paths.includes(expected), expected);
    assert.equal(new Set(paths).size, paths.length);
  });

  it("applies only to large, unpicked, successful JSON answers", () => {
    const shortened = formatResponse(response(big), { maxChars: 40_000, compact: 3000 });
    assert.match(shortened.text, /shortened view/);
    assert.match(shortened.text, /Fields: .*versions\[\*\]\.num/);
    assert.deepEqual(shortened.json, big, "callers such as pagination still get the whole response");
    assert.doesNotMatch(formatResponse(response(big), { maxChars: 1_000_000, compact: 0 }).text, /shortened view/);
    assert.doesNotMatch(formatResponse(response(big), { maxChars: 40_000, compact: 3000, pick: "crate.name" }).text, /shortened view/);
    assert.doesNotMatch(formatResponse(response({ a: 1 }), { maxChars: 40_000, compact: 3000 }).text, /shortened view/);
    const unmatched = formatResponse(response(big), { maxChars: 40_000, compact: 3000, pick: "nope" });
    assert.match(unmatched.text, /pick "nope" matched nothing[\s\S]*shortened view/);
  });
});
