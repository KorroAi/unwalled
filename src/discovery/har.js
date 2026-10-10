// Reads a HAR file (browser devtools export, mitmproxy, Charles, Proxyman...) into observations.
// Useful for traffic the browser capture cannot reach, such as mobile or desktop apps behind a proxy.
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
    const isJson = /json/i.test(content.mimeType ?? "");
    if (!isJson && (request.method === "GET" || response.status >= 400)) continue;
    let responseJson;
    if (isJson && typeof content.text === "string") {
      try {
        const raw = content.encoding === "base64" ? Buffer.from(content.text, "base64").toString("utf8") : content.text;
        responseJson = JSON.parse(raw);
      } catch {}
    }
    observations.push({
      method: request.method,
      url: request.url,
      status: response.status,
      requestHeaders: { ...headersObject(request.headers), ...(request.postData?.mimeType ? { "content-type": request.postData.mimeType } : {}) },
      requestBody: typeof request.postData?.text === "string" ? request.postData.text : null,
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
