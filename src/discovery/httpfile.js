// Parses ".http" / ".rest" request files (VS Code REST Client, JetBrains HTTP Client) into observations.
// Requests are separated by "###"; "@name = value" defines variables used as {{name}}.

const METHOD_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(?:\s+HTTP\/[\d.]+)?\s*$/i;

/**
 * @param {string} text file content
 * @param {Record<string, string>} [variables] values overriding the file's own "@name = value" definitions
 * @returns {{ observations: import("./infer.js").Observation[], warnings: string[] }}
 */
export function parseHttpFile(text, variables = {}) {
  /** @type {Record<string, string>} */ const vars = {};
  const warnings = [];
  const observations = [];
  const substitute = (/** @type {string} */ value) =>
    value.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (match, name) => {
      if (name.startsWith("$")) return match; // dynamic variables ($guid, $timestamp...) are left as they are
      return variables[name] ?? vars[name] ?? match;
    });
  for (const block of text.replace(/\r\n/g, "\n").split(/^###.*$/m)) {
    const lines = block.split("\n");
    let index = 0;
    // Leading comments and variable definitions.
    for (; index < lines.length; index++) {
      const line = lines[index].trim();
      const definition = /^@([\w.-]+)\s*=\s*(.*)$/.exec(line);
      if (definition) vars[definition[1]] = substitute(definition[2].trim());
      else if (line && !line.startsWith("#") && !line.startsWith("//")) break;
    }
    if (index >= lines.length) continue;
    const request = METHOD_LINE.exec(lines[index].trim()) ?? (/^(https?:\/\/|\{\{)/i.test(lines[index].trim()) ? [null, "GET", lines[index].trim()] : null);
    if (!request) {
      warnings.push(`Skipped a block starting with "${lines[index].trim().slice(0, 60)}"`);
      continue;
    }
    index++;
    // Query continuation lines ("  ?a=1", "  &b=2").
    let url = String(request[2]);
    for (; index < lines.length && /^\s+[?&]/.test(lines[index]); index++) url += lines[index].trim();
    /** @type {Record<string, string>} */ const headers = {};
    for (; index < lines.length && lines[index].trim() !== ""; index++) {
      const line = lines[index].trim();
      if (line.startsWith("#") || line.startsWith("//")) continue;
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = substitute(line.slice(colon + 1).trim());
    }
    const bodyLines = lines.slice(index + 1);
    // Response handler scripts ("> {% ... %}") and output redirections ("<> file") are not part of the body.
    const end = bodyLines.findIndex((line) => /^\s*(>\s*\{%|<>\s|>>)/.test(line));
    let body = (end === -1 ? bodyLines : bodyLines.slice(0, end)).join("\n").trim();
    if (body.startsWith("< ")) {
      warnings.push(`Body read from a file (${body.slice(2).split("\n")[0]}) is not imported.`);
      body = "";
    }
    const address = substitute(url);
    if (/\{\{/.test(address)) {
      warnings.push(`Unresolved variable in ${address}: pass "variables".`);
      continue;
    }
    let parsed;
    try {
      parsed = new URL(/^https?:\/\//i.test(address) ? address : `http://${address}`);
    } catch {
      warnings.push(`Invalid URL ${address}`);
      continue;
    }
    if (headers.authorization && /^basic\s+[^:\s]+:\S+$/i.test(headers.authorization) && !/^basic\s+[A-Za-z0-9+/=]+$/i.test(headers.authorization)) {
      // REST Client accepts "Basic user:password" and encodes it itself.
      headers.authorization = `Basic ${Buffer.from(headers.authorization.replace(/^basic\s+/i, "")).toString("base64")}`;
    }
    observations.push({
      method: String(request[1]).toUpperCase(), url: parsed.toString(), status: 200, requestHeaders: headers,
      requestBody: body ? substitute(body) : null, responseJson: undefined,
    });
  }
  return { observations, warnings };
}
