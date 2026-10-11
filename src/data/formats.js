// Readers for data files that are not plain text tables: Excel workbooks (.xlsx) and iCalendar files (.ics).
import { inflateRawSync } from "node:zlib";
import { xmlToJson } from "../tools/formats.js";

// ---------------------------------------------------------------- ZIP (enough for .xlsx)

/** Largest decompressed entry read from an archive. */
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

/**
 * Entries of a ZIP archive, read through its central directory (stored or deflated entries).
 * @param {Buffer} zip @returns {Map<string, () => Buffer>}
 */
export function unzip(zip) {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Not a ZIP archive (no end of central directory).");
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  /** @type {Map<string, () => Buffer>} */ const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("Corrupt ZIP central directory.");
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.set(name, () => {
      const localName = zip.readUInt16LE(localOffset + 26);
      const localExtra = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localName + localExtra;
      const data = zip.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(data);
      // Bounded: a crafted archive ("zip bomb") must not exhaust memory.
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ---------------------------------------------------------------- XLSX

/** @param {string} text */
const xmlText = (text) =>
  text.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#\d+);/gi, (m, e) =>
    e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCodePoint(e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))),
  );

/** "BC12" -> 54 (0-based column index). @param {string} ref */
function columnIndex(ref) {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * Sheets of an .xlsx workbook as records (first non-empty row = column names). Dates stay Excel serial numbers.
 * @param {Buffer} file @returns {Record<string, Record<string, unknown>[]>} sheet name -> records
 */
export function readXlsx(file) {
  const entries = unzip(file);
  const read = (/** @type {string} */ name) => entries.get(name)?.().toString("utf8");
  const workbook = read("xl/workbook.xml");
  if (!workbook) throw new Error("Not an Excel workbook (xl/workbook.xml missing).");
  const rels = read("xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  for (const m of rels.matchAll(/<Relationship\b[^>]*\bTarget="([^"]+)"[^>]*\bId="([^"]+)"/g)) targets.set(m[2], m[1]);
  /** @type {string[]} */ const shared = [];
  const sharedXml = read("xl/sharedStrings.xml") ?? "";
  for (const si of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlText([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));

  /** @type {Record<string, Record<string, unknown>[]>} */ const result = {};
  for (const sheet of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = xmlText(/\bname="([^"]*)"/.exec(sheet[1])?.[1] ?? "Sheet");
    const relId = /\br:id="([^"]*)"/.exec(sheet[1])?.[1];
    const target = relId ? targets.get(relId) : undefined;
    if (!target) continue;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const xml = read(path);
    if (!xml) continue;
    /** @type {unknown[][]} */ const rows = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      /** @type {unknown[]} */ const cells = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1];
        const ref = /\br="([^"]+)"/.exec(attrs)?.[1];
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const raw = /<v>([\s\S]*?)<\/v>/.exec(cell[2] ?? "")?.[1];
        let value;
        if (type === "s") value = shared[Number(raw)] ?? "";
        else if (type === "inlineStr") value = xmlText([...(cell[2] ?? "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
        else if (type === "b") value = raw === "1";
        else if (type === "str" || type === "e") value = raw === undefined ? "" : xmlText(raw);
        else value = raw === undefined ? null : Number(raw);
        cells[ref ? columnIndex(ref) : cells.length] = value;
      }
      rows.push(cells);
    }
    const headerIndex = rows.findIndex((r) => r.some((v) => v !== null && v !== undefined && v !== ""));
    if (headerIndex < 0) continue;
    const header = rows[headerIndex].map((v, i) => (v === null || v === undefined || v === "" ? `column${i + 1}` : String(v)));
    const width = Math.max(header.length, ...rows.map((r) => r.length));
    for (let i = header.length; i < width; i++) header[i] = `column${i + 1}`;
    // Two columns with the same title ("Total", "Total") would overwrite each other: the second becomes "Total_2".
    for (let i = 0; i < header.length; i++) if (header.indexOf(header[i]) < i) header[i] = `${header[i]}_${i + 1}`;
    result[name] = rows
      .slice(headerIndex + 1)
      .filter((r) => r.some((v) => v !== null && v !== undefined && v !== ""))
      .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? null])));
  }
  return result;
}

// ---------------------------------------------------------------- RSS / Atom feeds

/** Text of an XML node converted by xmlToJson (string, {#text}, or CDATA already merged). @param {any} node */
const nodeText = (node) => (node == null ? null : typeof node === "string" ? node : typeof node === "object" ? (node["#text"] ?? null) : String(node));
/** @param {any} value @returns {any[]} */
const many = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
/** Plain text of an HTML snippet (feed descriptions are often HTML). @param {string | null} html */
const stripHtml = (html) => (html ? html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim() : null);
/** RFC 822 dates of RSS ("Sat, 10 Oct 2026 18:16:19 +0000") to ISO. @param {string | null} value */
const isoDate = (value) => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
};

/**
 * Items of an RSS 2.0 / RSS 1.0 / Atom feed (YouTube channel feeds included: video id, views, rating).
 * @param {Record<string, any> | string} xml feed text, or a document converted by xmlToJson
 * @returns {Record<string, unknown>[] | null} null when the document is not a feed
 */
export function readFeed(xml) {
  if (typeof xml === "string") {
    const parsed = xmlToJson(xml);
    if (!parsed) return null;
    xml = parsed;
  }
  const strip = (/** @type {any} */ node) =>
    Array.isArray(node) ? node.map(strip) : node && typeof node === "object" ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k.startsWith("@") ? k : k.replace(/^[\w.-]+:/, ""), strip(v)])) : node;
  if (xml.rss?.channel || xml["rdf:RDF"]) {
    const channel = xml.rss?.channel ?? xml["rdf:RDF"];
    const items = many(channel.item ?? xml["rdf:RDF"]?.item);
    return items.map((raw) => {
      const item = strip(raw);
      return {
        title: nodeText(item.title), link: nodeText(item.link), published: isoDate(nodeText(item.pubDate) ?? nodeText(item.date)),
        author: nodeText(item.creator) ?? nodeText(item.author), summary: stripHtml(nodeText(item.description)),
        id: nodeText(item.guid) ?? nodeText(item.link), categories: many(item.category).map(nodeText).filter(Boolean).join(", ") || null,
        comments: nodeText(item.comments),
      };
    });
  }
  if (xml.feed) {
    return many(xml.feed.entry).map((raw) => {
      const entry = strip(raw);
      const links = many(entry.link);
      const link = links.find((l) => !l?.["@rel"] || l["@rel"] === "alternate")?.["@href"] ?? links[0]?.["@href"] ?? null;
      const group = entry.group ?? {};
      const stats = group.community?.statistics;
      const rating = group.community?.starRating;
      return {
        title: nodeText(entry.title), link, published: isoDate(nodeText(entry.published)), updated: isoDate(nodeText(entry.updated)),
        author: nodeText(many(entry.author)[0]?.name), summary: stripHtml(nodeText(entry.summary) ?? nodeText(entry.content) ?? nodeText(group.description)),
        id: nodeText(entry.id), categories: many(entry.category).map((c) => c?.["@term"]).filter(Boolean).join(", ") || null,
        ...(entry.videoId ? { video_id: nodeText(entry.videoId), views: stats?.["@views"] ? Number(stats["@views"]) : null, rating: rating?.["@average"] ? Number(rating["@average"]) : null, ratings: rating?.["@count"] ? Number(rating["@count"]) : null } : {}),
      };
    });
  }
  return null;
}

// ---------------------------------------------------------------- iCalendar

/** "20261010T090000Z" / "20261010" -> ISO string. @param {string} value */
function icsDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return value;
  return m[4] ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? "Z" : ""}` : `${m[1]}-${m[2]}-${m[3]}`;
}

/** @param {string} value */
const icsText = (value) => value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

/**
 * Events (VEVENT) and to-dos (VTODO) of an iCalendar file. Recurrence rules are kept as text, not expanded.
 * @param {string} text @returns {Record<string, Record<string, unknown>[]>}
 */
export function readIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/); // unfold continuation lines
  /** @type {Record<string, Record<string, unknown>[]>} */ const result = { events: [], todos: [] };
  /** @type {Record<string, unknown> | null} */ let current = null;
  let kind = "";
  let nested = 0; // components inside an event (VALARM...) have their own DESCRIPTION, SUMMARY...: they are skipped
  for (const line of lines) {
    if (current && /^BEGIN:/i.test(line) && !/^BEGIN:(VEVENT|VTODO)$/i.test(line)) {
      nested++;
      continue;
    }
    if (nested) {
      if (/^END:/i.test(line)) nested--;
      continue;
    }
    if (/^BEGIN:(VEVENT|VTODO)$/i.test(line)) {
      kind = line.slice(6).toUpperCase();
      current = {};
      continue;
    }
    if (/^END:(VEVENT|VTODO)$/i.test(line) && current) {
      (kind === "VEVENT" ? result.events : result.todos).push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const [property, ...params] = line.slice(0, colon).split(";");
    const value = line.slice(colon + 1);
    const key = property.toLowerCase().replace(/-/g, "_");
    const tz = params.find((p) => /^TZID=/i.test(p))?.slice(5);
    if (["dtstart", "dtend", "due", "created", "last_modified", "dtstamp"].includes(key)) {
      current[key] = icsDate(value);
      if (tz && key === "dtstart") current.timezone = tz;
    } else if (["summary", "description", "location", "status", "uid", "rrule", "url", "categories", "organizer", "priority", "class", "transp"].includes(key)) {
      current[key] = key === "organizer" ? value.replace(/^mailto:/i, "") : icsText(value);
    } else if (key === "attendee") {
      current.attendees = [current.attendees, value.replace(/^mailto:/i, "")].filter(Boolean).join(", ");
    }
  }
  if (!result.todos.length) delete result.todos;
  return result;
}
