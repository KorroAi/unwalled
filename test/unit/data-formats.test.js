import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readIcs, readXlsx } from "../../src/data/formats.js";

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

describe("Excel and iCalendar as SQL tables", () => {
  let home, engine;
  before(async () => {
    home = mkdtempSync(join(tmpdir(), "umcp-xlsx-"));
    process.env.UNIVERSAL_MCP_HOME = home;
    const { loadConfig } = await import("../../src/config.js");
    const { Engine } = await import("../../src/core.js");
    engine = new Engine(loadConfig());
  });
  after(async () => {
    await engine?.close();
    rmSync(home, { recursive: true, force: true });
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
});
