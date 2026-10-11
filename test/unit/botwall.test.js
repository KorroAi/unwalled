// Bot protection pages seen on real sites (Reddit, leboncoin/DataDome, GitLab, npm): reported, never bypassed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { botWall } from "../../src/discovery/capture.js";

const page = (title, text, html = "") => /** @type {any} */ ({ evaluate: async () => ({ title, text, html }) });

describe("bot protection pages", () => {
  it("recognises a challenge page served with HTTP 200", async () => {
    const reason = await botWall(page("Reddit - Prove your humanity", "Complete the challenge below and let us know you're a real person."), 200);
    assert.match(reason ?? "", /Prove your humanity.*does not bypass.*interactive=true/s);
  });

  it("treats 403 and 429 on the page itself as a block", async () => {
    assert.match((await botWall(page("", "", "<script src=https://ct.captcha-delivery.com/c.js>"), 403)) ?? "", /HTTP 403, "captcha-delivery"/);
    assert.match((await botWall(page("GitLab", "Retry later"), 429)) ?? "", /HTTP 429/);
  });

  it("does not flag a normal page that merely loads a protection script", async () => {
    assert.equal(await botWall(page("Shop", "Bikes", "<script src=https://js.datadome.co/tags.js></script>"), 200), null);
    assert.equal(await botWall(page("Access denied errors explained", "x".repeat(3000)), 200), null);
  });
});
