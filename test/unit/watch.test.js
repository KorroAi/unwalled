import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeChange, watch } from "../../src/watch.js";

describe("watch", () => {
  it("describes JSON changes field by field", () => {
    assert.equal(describeChange('{"p":1,"s":"open","tags":["a"]}', '{"p":2,"s":"open","tags":["a","b"]}'), "p: 1 → 2\n+ tags.1: \"b\"");
    assert.equal(describeChange("plain", "other"), "other");
  });

  it("reports only changes and stops on until", async () => {
    const prices = [100, 100, 101, 101, 105, 110, 120];
    let i = 0;
    let clock = 0;
    const run = async () => ({ text: `HTTP 200 — https://x.io/p\n${JSON.stringify({ price: prices[Math.min(i++, prices.length - 1)] })}`, isError: false });
    const notified = [];
    const result = await watch(run, {}, {
      intervalMs: 1000, durationMs: 60_000, until: '/"price":1[1-9][0-9]/', onChange: (m) => notified.push(m),
      sleep: async (ms) => void (clock += ms), now: () => clock,
    });
    assert.match(result.text, /^Watched 6 call\(s\) over 5s, 3 change\(s\), 0 error\(s\); stopped: "until" matched after 5s\./);
    assert.match(result.text, /price: 101 → 105/);
    assert.equal(notified.length, 3);
  });

  it("stops when the duration is over", async () => {
    let clock = 0;
    const result = await watch(async () => ({ text: "same", isError: false }), {}, { intervalMs: 10_000, durationMs: 25_000, sleep: async (ms) => void (clock += ms), now: () => clock });
    assert.match(result.text, /^Watched 3 call\(s\) over 20s, 0 change\(s\)/);
  });
});
