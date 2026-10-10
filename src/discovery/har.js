// Reads a HAR file (browser devtools export, mitmproxy, Charles, Proxyman...) into observations.
// Useful for traffic the browser capture cannot reach, such as mobile or desktop apps behind a proxy.
import { parseJsonLoose } from "../tools/formats.js";
import { isTracker, registrableDomain } from "./infer.js";

/** @param {{ name: string, value: string }[] | undefined} list */
function headersObject(list) {
  /** @type {Record<string, string>} */ const headers = {};
  for (const { name, value } of list ?? []) {
    if (name && !name.startsWith(":")) headers[name.toLowerCase()] = value;
  }
  return headers;
}

/**
 * Request body of a HAR entry. Some tools export form bodies as "params" without "text": they are rebuilt
 * (form-encoded, or multipart with file names only).
 * @param {any} postData @returns {{ text: string | null, contentType: string | undefined }}
 */
function postBody(postData) {
  if (!postData) return { text: null, contentType: undefined };
  const mime = postData.mimeType;
  if (typeof postData.text === "string" && postData.text !== "") return { text: postData.text, contentType: mime };
  const params = Array.isArray(postData.params) ? postData.params.filter((p) => p && typeof p.name === "string") : [];
  if (!params.length) return { text: typeof postData.text === "string" ? postData.text : null, contentType: mime };
  if (/multipart\/form-data/i.test(mime ?? "")) {
    const boundary = "unwalled-har";
    const parts = params.map((p) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.fileName ? `; filename="${p.fileName}"` : ""}\r\n\r\n${p.fileName ? "" : (p.value ?? "")}\r\n`,
    );
    return { text: `${parts.join("")}--${boundary}--\r\n`, contentType: `multipart/form-data; boundary=${boundary}` };
  }
  return { text: new URLSearchParams(params.map((p) => [p.name, p.value ?? ""])).toString(), contentType: mime ?? "application/x-www-form-urlencoded" };
}

/**
 * @param {string} text HAR JSON
 * @param {{ hosts?: string[] }} [options] restrict to these hosts (and their subdomains)
 */
export function observationsFromHar(text, { hosts = [] } = {}) {
  let har;
  try {
    har = JSON.parse(text);
  } catch (error) {
    throw new Error(`Not a valid HAR file (JSON parse error: ${error.message})`);
  }
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw new Error("Not a valid HAR file: log.entries is missing");
  const wanted = hosts.map((h) => h.toLowerCase());

  /** @type {import("./infer.js").Observation[]} */ const observations = [];
  const pageUrls = [];
  for (const page of har.log.pages ?? []) if (/^https?:\/\//.test(page?.title ?? "")) pageUrls.push(page.title);

  for (const entry of entries) {
    const request = entry?.request;
    const response = entry?.response;
    if (!request?.url || !response) continue;
    let url;
    try {
      url = new URL(request.url);
    } catch {
      continue;
    }
    if (entry._resourceType === "document") pageUrls.push(request.url);
    if (entry._resourceType && !["xhr", "fetch"].includes(entry._resourceType)) continue;
    if (isTracker(url.hostname)) continue;
    if (wanted.length && !wanted.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) continue;

    const content = response.content ?? {};
    const mimeType = content.mimeType ?? "";
    const isJson = /json/i.test(mimeType);
    // JSON served as text/plain or text/javascript, or behind a ")]}'" prefix, counts as JSON too.
    const maybeJson = isJson || mimeType === "" || /^text\/(plain|javascript)|^application\/(javascript|x-javascript)/i.test(mimeType);
    if (!maybeJson && (request.method === "GET" || response.status >= 400)) continue;
    let responseJson;
    if (maybeJson && typeof content.text === "string") {
      const raw = content.encoding === "base64" ? Buffer.from(content.text, "base64").toString("utf8") : content.text;
      responseJson = parseJsonLoose(raw);
    }
    if (!isJson && responseJson === undefined && (request.method === "GET" || response.status >= 400)) continue;
    const body = postBody(request.postData);
    observations.push({
      method: request.method,
      url: request.url,
      status: response.status,
      requestHeaders: { ...headersObject(request.headers), ...(body.contentType ? { "content-type": body.contentType } : {}) },
      requestBody: body.text,
      responseJson,
    });
  }

  // Base URL: origin of the most frequent API host.
  const counts = new Map();
  for (const obs of observations) {
    const origin = new URL(obs.url).origin;
    counts.set(origin, (counts.get(origin) ?? 0) + 1);
  }
  const baseUrl = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const domains = [...new Set(observations.map((o) => registrableDomain(new URL(o.url).hostname)))];
  return { observations, pageUrls, baseUrl, domains };
}
