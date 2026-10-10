// Parses cURL commands ("Copy as cURL" from browser devtools, API docs, Postman/Insomnia code export) into observations.
// Supports bash quoting ('...', "...", $'...', backslash line continuations) and Windows cmd exports (^ escapes).

/**
 * Splits a shell command line into arguments.
 * @param {string} command @returns {string[]}
 */
export function shellSplit(command) {
  let text = command.trim();
  // Windows "Copy as cURL (cmd)": ^ escapes the next character, "^\n" continues the line.
  if (/\^\s*\n|\^"/.test(text)) text = text.replace(/\^\r?\n/g, " ").replace(/\^(.)/g, "$1");
  text = text.replace(/\\\r?\n/g, " ");
  const args = [];
  let current = "";
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (/\s/.test(char)) {
      if (has) args.push(current);
      current = "";
      has = false;
      continue;
    }
    has = true;
    if (char === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) throw new Error("Unclosed single quote in the cURL command");
      current += text.slice(i + 1, end);
      i = end;
    } else if (char === "$" && text[i + 1] === "'") {
      let j = i + 2;
      for (; j < text.length && text[j] !== "'"; j++) {
        if (text[j] === "\\" && j + 1 < text.length) {
          const next = text[++j];
          const escapes = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };
          if (next === "x") {
            current += String.fromCharCode(Number.parseInt(text.slice(j + 1, j + 3), 16));
            j += 2;
          } else if (next === "u") {
            current += String.fromCharCode(Number.parseInt(text.slice(j + 1, j + 5), 16));
            j += 4;
          } else current += escapes[next] ?? `\\${next}`;
        } else current += text[j];
      }
      if (j >= text.length) throw new Error("Unclosed $'...' quote in the cURL command");
      i = j;
    } else if (char === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\" && ['"', "\\", "$", "`"].includes(text[j + 1])) j++;
        current += text[j];
      }
      if (j >= text.length) throw new Error("Unclosed double quote in the cURL command");
      i = j;
    } else if (char === "\\" && i + 1 < text.length) current += text[++i];
    else current += char;
  }
  if (has) args.push(current);
  return args;
}

const VALUE_FLAGS = new Set([
  "-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json",
  "-b", "--cookie", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "--url", "-F", "--form", "--form-string", "-o", "--output",
  "-m", "--max-time", "--connect-timeout", "-x", "--proxy", "--retry", "-w", "--write-out", "-T", "--upload-file", "--oauth2-bearer", "-c", "--cookie-jar",
]);

/**
 * @param {string} command one cURL command
 * @returns {{ observation: import("./infer.js").Observation, warnings: string[] }}
 */
export function parseCurl(command) {
  const args = shellSplit(command);
  if (!args.length || !/^curl(\.exe)?$/i.test(args[0].split(/[\\/]/).at(-1) ?? "")) throw new Error('A cURL command must start with "curl".');
  /** @type {Record<string, string>} */ const headers = {};
  const data = [];
  const warnings = [];
  let method;
  let url;
  let get = false;
  let json = false;
  for (let i = 1; i < args.length; i++) {
    let flag = args[i];
    let value;
    if (flag.startsWith("--") && flag.includes("=")) [flag, value] = [flag.slice(0, flag.indexOf("=")), flag.slice(flag.indexOf("=") + 1)];
    else if (/^-[A-Za-z]./.test(flag) && VALUE_FLAGS.has(flag.slice(0, 2))) [flag, value] = [flag.slice(0, 2), flag.slice(2)];
    if (VALUE_FLAGS.has(flag) && value === undefined) value = args[++i] ?? "";
    switch (flag) {
      case "-X":
      case "--request":
        method = String(value).toUpperCase();
        break;
      case "-H":
      case "--header": {
        const colon = String(value).indexOf(":");
        if (colon > 0) {
          const name = String(value).slice(0, colon).trim().toLowerCase();
          const headerValue = String(value).slice(colon + 1).trim();
          if (headerValue) headers[name] = headerValue;
        }
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii":
        if (String(value).startsWith("@") && flag !== "--data-raw") warnings.push(`Body read from a file (${value}) is not imported.`);
        else data.push(String(value));
        break;
      case "--data-urlencode": {
        const text = String(value);
        const eq = text.indexOf("=");
        data.push(eq > 0 ? `${text.slice(0, eq)}=${encodeURIComponent(text.slice(eq + 1))}` : encodeURIComponent(text));
        break;
      }
      case "--json":
        data.push(String(value));
        json = true;
        break;
      case "-b":
      case "--cookie":
        if (String(value).includes("=")) headers.cookie = headers.cookie ? `${headers.cookie}; ${value}` : String(value);
        break;
      case "-u":
      case "--user":
        headers.authorization = `Basic ${Buffer.from(String(value)).toString("base64")}`;
        break;
      case "--oauth2-bearer":
        headers.authorization = `Bearer ${value}`;
        break;
      case "-A":
      case "--user-agent":
        headers["user-agent"] = String(value);
        break;
      case "-e":
      case "--referer":
        headers.referer = String(value);
        break;
      case "--url":
        url = String(value);
        break;
      case "-G":
      case "--get":
        get = true;
        break;
      case "-F":
      case "--form":
      case "--form-string":
      case "-T":
      case "--upload-file":
        warnings.push(`${flag} (file upload / multipart) is not imported.`);
        break;
      default:
        if (!flag.startsWith("-") && url === undefined) url = flag;
    }
  }
  if (!url) throw new Error("No URL found in the cURL command.");
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const parsed = new URL(url);
  let body = data.length ? data.join("&") : null;
  if (get && body) {
    for (const [key, value] of new URLSearchParams(body)) parsed.searchParams.append(key, value);
    body = null;
  }
  if (json) {
    headers["content-type"] ??= "application/json";
    headers.accept ??= "application/json";
  } else if (body && !headers["content-type"]) headers["content-type"] = /^\s*[[{]/.test(body) ? "application/json" : "application/x-www-form-urlencoded";
  return {
    observation: { method: method ?? (body ? "POST" : "GET"), url: parsed.toString(), status: 200, requestHeaders: headers, requestBody: body, responseJson: undefined },
    warnings,
  };
}

/**
 * Splits pasted text into separate cURL commands (each starting with "curl" at the beginning of a line).
 * @param {string | string[]} input
 */
export function splitCurlCommands(input) {
  const texts = Array.isArray(input) ? input : [input];
  return texts.flatMap((text) => String(text).split(/\r?\n(?=\s*curl(?:\.exe)?\s)/i)).map((c) => c.trim()).filter(Boolean);
}
