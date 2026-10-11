// Server-rendered pages: structured extraction and page templates.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferPages, redirectedToSignIn } from "../../src/discovery/pages.js";
import { extractPage } from "../../src/tools/page.js";

const html = `<!doctype html><html><head><title>Customers · Admin</title><script>var x = "<table>";</script></head><body>
<nav><a href="/">Home</a> <a href="/logout">Sign out</a></nav>
<h1>Swift &amp; Co</h1>
<dl><dt>City</dt><dd>Lyon</dd><dt>Since:</dt><dd>2019</dd></dl>
<table><tr><th>Order</th><th>Status</th><th>Total</th></tr>
<tr><td><a href="/orders/1">1</a></td><td>paid</td><td>880&nbsp;EUR</td></tr>
<tr><td>2</td><td><b>open</b></td><td>12</td></tr></table>
<table><tr><td>VAT number</td><td>FR123</td></tr></table>
<a href="https://elsewhere.test/x">External</a> <a href="/customers?page=2">Next page</a>
</body></html>`;

describe("server-rendered pages", () => {
  it("extracts tables as rows, label/value fields, same-site links and text", () => {
    const page = extractPage(html, "https://crm.test/customers/7");
    assert.equal(page.title, "Swift & Co");
    assert.deepEqual(page.fields, { City: "Lyon", Since: "2019", "VAT number": "FR123" });
    assert.deepEqual(page.tables, [{ columns: ["Order", "Status", "Total"], rows: [{ Order: "1", Status: "paid", Total: "880 EUR" }, { Order: "2", Status: "open", Total: "12" }] }]);
    assert.deepEqual(page.links?.map((l) => l.href), ["/", "/orders/1", "/customers?page=2"], "sign-out and external links are left out");
    assert.match(page.text, /Swift & Co/);
    assert.doesNotMatch(page.text, /var x/);
  });

  it("reads 'Label: value' lines when the page has no field list", () => {
    const page = extractPage("<h1>Order 7</h1><p>Status: paid</p><p>Customer: Swift · Total: 880 EUR</p>", "https://crm.test/orders/7");
    assert.deepEqual(page.fields, { Status: "paid", Customer: "Swift", Total: "880 EUR" });
  });

  it("turns pages into templates, skipping app shells and account pages", () => {
    const pages = inferPages([
      { url: "https://crm.test/customers/512", textLength: 900, tables: 1 },
      { url: "https://crm.test/customers/530", textLength: 950, tables: 1 },
      { url: "https://crm.test/customers?city=Lyon&page=1", textLength: 2000, tables: 1 },
      { url: "https://crm.test/login", textLength: 600, tables: 0 },
      { url: "https://crm.test/app", textLength: 120, tables: 0 },
      { url: "https://crm.test/invite/x7k2", textLength: 800, tables: 0 },
    ]);
    const byTemplate = Object.fromEntries(pages.map((p) => [p.pathTemplate, p]));
    assert.deepEqual(Object.keys(byTemplate).sort(), ["/customers", "/customers/{customer}", "/invite/{invite}"]);
    assert.equal(byTemplate["/customers/{customer}"].observed, 2);
    assert.equal(byTemplate["/customers/{customer}"].pathExamples.customer, "512");
    assert.deepEqual(Object.keys(byTemplate["/customers"].query), ["city", "page"]);
    assert.deepEqual(byTemplate["/invite/{invite}"].pathExamples, {}, "a token in the path is not kept as an example");
  });

  it("merges three or more pages that differ only by their last segment", () => {
    const pages = inferPages(["Lyon", "Nantes", "Lille"].map((city) => ({ url: `https://wiki.test/wiki/${city}`, textLength: 5000, tables: 0 })));
    assert.equal(pages.length, 1);
    assert.equal(pages[0].pathTemplate, "/wiki/{wiki}");
    assert.equal(pages[0].observed, 3);
    assert.equal(inferPages(["Lyon", "Nantes"].map((city) => ({ url: `https://wiki.test/wiki/${city}`, textLength: 5000, tables: 0 }))).length, 2, "two pages are not enough");
  });

  it("recognises a redirection to the sign-in page", () => {
    assert.equal(redirectedToSignIn("https://crm.test/customers/1", "https://crm.test/login?next=/customers/1"), true);
    assert.equal(redirectedToSignIn("https://crm.test/customers/1", "https://crm.test/customers/1"), false);
    assert.equal(redirectedToSignIn("https://crm.test/login", "https://crm.test/login?error=1"), false);
    assert.equal(redirectedToSignIn("https://crm.test/a", "https://crm.test/authors/3"), false);
  });
});
