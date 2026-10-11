// Structured content of a server-rendered HTML page: its tables as rows of named cells, its "label: value" fields,
// links and readable text. Server-rendered tools (Django or Rails admin, PHP back offices, wikis) send their data
// inside the HTML instead of through an API: this turns such a page into JSON an agent can pick from.
import { htmlToText } from "./http.js";

const MAX_TABLES = 10;
const MAX_ROWS = 200;
const MAX_LINKS = 40;
const MAX_TEXT = 6000;

/** @param {string} html */
function cellText(html) {
  return html
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {string} tableHtml */
function parseTable(tableHtml) {
  const rows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => ({
    header: /<th\b/i.test(match[1]) && !/<td\b/i.test(match[1]),
    cells: [...match[1].matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((cell) => cellText(cell[2])),
  }));
  const data = rows.filter((row) => row.cells.length);
  if (!data.length) return null;
  const headerRow = data[0].header ? data[0].cells : null;
  // Two-column tables without a header row are lists of "label: value" fields.
  if (!headerRow && data.every((row) => row.cells.length === 2)) return { fields: Object.fromEntries(data.map((row) => [row.cells[0].replace(/:$/, ""), row.cells[1]])) };
  const columns = (headerRow ?? data[0].cells.map((_, i) => `column${i + 1}`)).map((name, i) => name || `column${i + 1}`);
  const unique = columns.map((name, i) => (columns.indexOf(name) === i ? name : `${name}_${i + 1}`));
  const body = (headerRow ? data.slice(1) : data).filter((row) => !row.header);
  return {
    columns: unique,
    rows: body.slice(0, MAX_ROWS).map((row) => Object.fromEntries(unique.map((name, i) => [name, row.cells[i] ?? ""]))),
    ...(body.length > MAX_ROWS ? { totalRows: body.length } : {}),
  };
}

/**
 * @param {string} html @param {string} pageUrl
 * @returns {{ title: string, url: string, fields?: Record<string, string>, tables?: any[], links?: { text: string, href: string }[], text: string }}
 */
export function extractPage(html, pageUrl) {
  const clean = html.replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const title = cellText(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(clean)?.[1] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(clean)?.[1] ?? "");

  /** @type {Record<string, string>} */ const fields = {};
  for (const [, list] of clean.matchAll(/<dl\b[^>]*>([\s\S]*?)<\/dl>/gi))
    for (const [, term, value] of list.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) fields[cellText(term).replace(/:$/, "")] = cellText(value);

  const tables = [];
  for (const [table] of clean.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    if (tables.length >= MAX_TABLES) break;
    const parsed = parseTable(table);
    if (!parsed) continue;
    if ("fields" in parsed) Object.assign(fields, parsed.fields);
    else tables.push(parsed);
  }

  // "Label: value" lines (a common way to show a record) when the page has no explicit field list.
  const text = htmlToText(clean).replace(/^# .*\n/, "");
  if (!Object.keys(fields).length)
    for (const line of text.split("\n")) {
      for (const part of line.split(/ · | \| /)) {
        const match = /^\s*([A-Z][\w ()/.-]{0,40}?):\s+(\S.{0,200})$/.exec(part);
        if (match && Object.keys(fields).length < 50) fields[match[1].trim()] = match[2].trim();
      }
    }

  const origin = new URL(pageUrl).origin;
  const links = [];
  const seen = new Set();
  for (const [, href, label] of clean.matchAll(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= MAX_LINKS) break;
    let absolute;
    try {
      absolute = new URL(href.replace(/&amp;/g, "&"), pageUrl);
    } catch {
      continue;
    }
    const textLabel = cellText(label);
    if (absolute.origin !== origin || !textLabel || seen.has(absolute.href) || /logout|log-out|sign-?out|delete|remove/i.test(absolute.pathname)) continue;
    seen.add(absolute.href);
    links.push({ text: textLabel.slice(0, 80), href: absolute.pathname + absolute.search });
  }

  return {
    title,
    url: pageUrl,
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(tables.length ? { tables } : {}),
    ...(links.length ? { links } : {}),
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
  };
}
