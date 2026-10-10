import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCsv, parseJsonLoose, xmlToJson } from "../../src/tools/formats.js";
import { formatResponse } from "../../src/tools/http.js";

describe("CSV", () => {
  it("parses quoted fields, doubled quotes, newlines and other delimiters", () => {
    assert.deepEqual(parseCsv('id,name,note\r\n1,"Lamp, blue","say ""hi"""\n2,Chair,"two\nlines"\n'), [
      { id: "1", name: "Lamp, blue", note: 'say "hi"' },
      { id: "2", name: "Chair", note: "two\nlines" },
    ]);
    assert.deepEqual(parseCsv("a;b\n1;2"), [{ a: "1", b: "2" }]);
    assert.deepEqual(parseCsv("﻿x\ty\n3\t4\n"), [{ x: "3", y: "4" }]);
  });
});

describe("XML", () => {
  it("converts elements, attributes, repeated elements, CDATA and entities", () => {
    const rss = `<?xml version="1.0"?><!-- feed --><rss version="2.0"><channel><title>News &amp; more</title>
      <item><title>First</title><link>https://x.io/1</link></item>
      <item><title><![CDATA[Second <b>bold</b>]]></title><guid isPermaLink="false">2</guid></item>
      <empty/></channel></rss>`;
    assert.deepEqual(xmlToJson(rss), {
      rss: {
        "@version": "2.0",
        channel: {
          title: "News & more",
          item: [{ title: "First", link: "https://x.io/1" }, { title: "Second <b>bold</b>", guid: { "@isPermaLink": "false", "#text": "2" } }],
          empty: "",
        },
      },
    });
    assert.equal(xmlToJson("<a><b></a>"), null);
  });

  it("is applied to tool results so pick works", () => {
    const result = { status: 200, statusText: "OK", contentType: "application/rss+xml; charset=utf-8", finalUrl: "https://x.io/feed", body: Buffer.from("<rss><channel><item><title>A</title></item><item><title>B</title></item></channel></rss>") };
    const body = (/** @type {any} */ value) => JSON.parse(value.text.split("\n").slice(1).join(""));
    assert.deepEqual(body(formatResponse(result, { pick: "rss.channel.item[*].title", maxChars: 1000 })), ["A", "B"]);
    const csv = { ...result, contentType: "text/csv", body: Buffer.from("sym,price\nBTC,60000\nETH,3000\n") };
    assert.deepEqual(body(formatResponse(csv, { pick: "[?price>5000].sym", maxChars: 1000 })), ["BTC"]);
    // HTML is not converted to JSON (it is turned into readable text, or kept raw with raw=true).
    const html = { ...result, contentType: "text/html", body: Buffer.from("<p>hi</p>") };
    assert.equal(formatResponse(html, { maxChars: 1000 }).text.split("\n")[1], "hi");
    assert.equal(formatResponse(html, { maxChars: 1000, raw: true }).text.split("\n")[1], "<p>hi</p>");
  });

  it("hands small images to the agent as images", () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    const result = formatResponse({ status: 200, statusText: "OK", contentType: "image/png", body: png, finalUrl: "https://x.io/chart.png" }, { maxChars: 1000 });
    assert.equal(result.image, png.toString("base64"));
    assert.equal(result.imageType, "image/png");
    assert.match(result.text, /image: image\/png, \d+ bytes/);
    const svg = formatResponse({ status: 200, statusText: "OK", contentType: "image/svg+xml", body: Buffer.from("<svg/>"), finalUrl: "https://x.io/a.svg" }, { maxChars: 1000 });
    assert.equal(svg.image, undefined, "SVG stays text");
  });

  it("reads JSON behind anti-hijacking prefixes or served as text", () => {
    assert.deepEqual(parseJsonLoose(")]}'\n{\"a\":1}"), { a: 1 });
    assert.deepEqual(parseJsonLoose("while(1);[1,2]"), [1, 2]);
    assert.deepEqual(parseJsonLoose("for(;;);{\"b\":true}"), { b: true });
    assert.equal(parseJsonLoose("<html></html>"), undefined);
    assert.equal(parseJsonLoose("console.log(1)"), undefined);
    const prefixed = formatResponse({ status: 200, statusText: "OK", contentType: "text/plain", body: Buffer.from(")]}'\n{\"items\":[{\"id\":7}]}"), finalUrl: "https://x.io/api" }, { pick: "items[0].id", maxChars: 1000 });
    assert.equal(prefixed.text.split("\n")[1], "7");
  });
});
