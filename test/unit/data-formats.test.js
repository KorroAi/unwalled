import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readFeed, readIcs, readXlsx } from "../../src/data/formats.js";

const fixture = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe("Excel and iCalendar readers", () => {
  it("reads every sheet of a workbook written by openpyxl", () => {
    const sheets = readXlsx(readFileSync(fixture("sample.xlsx")));
    assert.deepEqual(Object.keys(sheets), ["Ventes 2026", "Clients"]);
    assert.deepEqual(sheets["Ventes 2026"], [
      { produit: "lampe", quantité: 3, prix: 12.5, payé: true, note: "rouge & bleu" },
      { produit: "chaise", quantité: 1, prix: 40, payé: false, note: null },
      { produit: "table", quantité: 2, prix: 99.99, payé: true, note: "<fragile>" },
    ]);
    assert.deepEqual(sheets.Clients, [{ id: 1, nom: "Acme" }, { id: 2, nom: "Globex" }], "leading empty rows are skipped");
  });

  it("reads events and to-dos of an iCalendar file", () => {
    const { events, todos } = readIcs(readFileSync(fixture("sample.ics"), "utf8"));
    assert.equal(events.length, 2);
    assert.deepEqual(
      { ...events[0] },
      {
        uid: "1@test", dtstart: "2026-10-12T09:00:00", timezone: "Europe/Paris", dtend: "2026-10-12T10:00:00", summary: "Project review, Q4 roadmap",
        description: "Ordre du jour :\n1. backtest", location: "Visio", organizer: "me@example.com", attendees: "a@example.com, b@example.com", rrule: "FREQ=WEEKLY;BYDAY=MO",
      },
    );
    assert.equal(events[1].dtstart, "2026-10-15");
    assert.deepEqual(todos, [{ uid: "3@test", due: "2026-10-20T17:00:00Z", summary: "Envoyer la vidéo", status: "NEEDS-ACTION" }]);
  });
});

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>News</title>
<item><title><![CDATA[First & best]]></title><link>https://n.io/1</link><pubDate>Sat, 10 Oct 2026 18:16:19 +0000</pubDate><dc:creator>ada</dc:creator>
<description><![CDATA[<p>Hello <b>world</b></p>]]></description><category>ai</category><category>news</category><guid>n-1</guid></item>
<item><title>Second</title><link>https://n.io/2</link><pubDate>Fri, 09 Oct 2026 08:00:00 +0000</pubDate></item></channel></rss>`;

const YOUTUBE = `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
<title>Channel</title><entry><id>yt:video:abc</id><yt:videoId>abc</yt:videoId><title>My video</title><link rel="alternate" href="https://www.youtube.com/watch?v=abc"/>
<author><name>Me</name></author><published>2026-10-09T23:00:24+00:00</published><updated>2026-10-10T05:34:58+00:00</updated>
<media:group><media:description>About it</media:description><media:community><media:starRating count="70" average="5.00" min="1" max="5"/><media:statistics views="2668"/></media:community></media:group></entry></feed>`;

describe("RSS and Atom feeds", () => {
  it("reads RSS items with dates, authors, categories and plain-text summaries", () => {
    assert.deepEqual(readFeed(RSS), [
      { title: "First & best", link: "https://n.io/1", published: "2026-10-10T18:16:19.000Z", author: "ada", summary: "Hello world", id: "n-1", categories: "ai, news", comments: null },
      { title: "Second", link: "https://n.io/2", published: "2026-10-09T08:00:00.000Z", author: null, summary: null, id: "https://n.io/2", categories: null, comments: null },
    ]);
  });

  it("reads YouTube channel feeds with views and ratings", () => {
    assert.deepEqual(readFeed(YOUTUBE), [
      {
        title: "My video", link: "https://www.youtube.com/watch?v=abc", published: "2026-10-09T23:00:24.000Z", updated: "2026-10-10T05:34:58.000Z", author: "Me",
        summary: "About it", id: "yt:video:abc", categories: null, video_id: "abc", views: 2668, rating: 5, ratings: 70,
      },
    ]);
  });

  it("is null for XML that is not a feed", () => {
    assert.equal(readFeed("<config><a>1</a></config>"), null);
  });
});

describe("Excel and iCalendar as SQL tables", () => {
  let home, engine;
  before(async () => {
    home = mkdtempSync(join(tmpdir(), "umcp-xlsx-"));
    process.env.UNWALLED_HOME = home;
    const { loadConfig } = await import("../../src/config.js");
    const { Engine } = await import("../../src/core.js");
    engine = new Engine(loadConfig());
  });
  after(async () => {
    await engine?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  it("queries workbook sheets and calendar events with SQL", async () => {
    const xlsx = join(home, "ventes.xlsx");
    copyFileSync(fixture("sample.xlsx"), xlsx);
    const recipe = await engine.importFile({ name: "ventes", path: xlsx });
    assert.deepEqual(recipe.tables.map((t) => t.name).sort(), ["Clients", "Ventes_2026"]);
    const sql = /** @type {any} */ (engine.tools.get("ventes__sql"));
    const total = await sql.run({ sql: 'SELECT sum("quantité" * prix) AS ca FROM Ventes_2026 WHERE "payé" = 1' });
    assert.equal(JSON.parse(total.text).rows[0].ca, 237.48);

    const ics = join(home, "agenda.ics");
    copyFileSync(fixture("sample.ics"), ics);
    await engine.importFile({ name: "agenda", path: ics });
    const next = await /** @type {any} */ (engine.tools.get("agenda__sql")).run({ sql: "SELECT summary, dtstart FROM events WHERE dtstart >= '2026-10-13' ORDER BY dtstart" });
    assert.deepEqual(JSON.parse(next.text).rows, [{ summary: "Journée entière", dtstart: "2026-10-15" }]);
  });

  it("imports feeds, skips other XML in folders and still recognises WSDL files", async () => {
    const feed = join(home, "news.xml");
    writeFileSync(feed, RSS);
    await engine.importFile({ name: "news", path: feed });
    const rows = await /** @type {any} */ (engine.tools.get("news__sql")).run({ sql: "SELECT title FROM news ORDER BY published" });
    assert.deepEqual(JSON.parse(rows.text).rows, [{ title: "Second" }, { title: "First & best" }]);

    const folder = join(home, "mixed");
    mkdirSync(folder);
    writeFileSync(join(folder, "settings.xml"), "<settings><a>1</a></settings>");
    writeFileSync(join(folder, "channel.atom"), YOUTUBE);
    const mixed = await engine.importFile({ name: "mixed", path: folder });
    assert.deepEqual(mixed.tables.map((t) => t.name), ["channel"]);

    const wsdl = join(home, "service.xml");
    writeFileSync(wsdl, `<?xml version="1.0"?><wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tns="urn:x" targetNamespace="urn:x" name="X">
<wsdl:message name="PingIn"/><wsdl:portType name="P"><wsdl:operation name="Ping"><wsdl:input message="tns:PingIn"/></wsdl:operation></wsdl:portType>
<wsdl:binding name="B" type="tns:P"><soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/><wsdl:operation name="Ping"><soap:operation soapAction="urn:x/Ping"/></wsdl:operation></wsdl:binding>
<wsdl:service name="S"><wsdl:port name="SP" binding="tns:B"><soap:address location="http://localhost:1/x"/></wsdl:port></wsdl:service></wsdl:definitions>`);
    assert.equal((await engine.importFile({ name: "svc", path: wsdl, baseUrl: "http://localhost:1/x" })).kind, "soap");
  });
});
