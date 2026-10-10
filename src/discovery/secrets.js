// Secret detection and redaction. A value is treated as secret when its name says so (header, query parameter,
// body field) or when the value itself looks like a credential (JWT, provider key formats, private keys, long random strings).
// Recipes are meant to be shared: everything written into them goes through these functions.

export const REDACTED = "REDACTED";

// Header names whose values are credentials. Anything mentioning a key, token, session, signature... qualifies.
export const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie)$|key|token|secret|session|auth|signature|passw|csrf|xsrf|credential|jwt|bearer/i;

// Query parameters and body fields whose values must never be written into a shareable recipe.
export const SENSITIVE_FIELD =
  /^(key|sig|sid|auth|otp|pwd|pin|pass|passcode|cvv|cvc|csc|ssn|iban|code_verifier)$|token|secret|passw|signature|session|api[_-]?key|apikey|credential|jwt|private[_-]?key|privatekey|access[_-]?key|client[_-]?key|card[_-]?(number|num|no)|cardnumber|security[_-]?code|refresh/i;

// Names that carry opaque but non-secret values (pagination cursors...): never moved to the secret store.
const OPAQUE_NON_SECRET = /^(cursor|after|before|next|prev|previous|page|page_?token|continuation|offset|etag|hash|sha|checksum|id|ids)$/i;

/** Credential formats recognisable from the value alone. */
const CREDENTIAL_PATTERNS = [
  /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g, // JSON Web Token
  /\b[sr]k_(?:live|test)_\w{8,}/g, // Stripe secret / restricted keys
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_\w{20,}/g,
  /\bglpat-[\w-]{20,}/g, // GitLab
  /\bxox[abprs]-[\w-]{10,}/g, // Slack
  /\bAIza[\w-]{30,}/g, // Google API key
  /\bsk-(?:ant-|proj-)?[\w-]{20,}/g, // OpenAI / Anthropic style keys
  /\bhf_[A-Za-z0-9]{20,}/g, // Hugging Face
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bSG\.[\w-]{16,}\.[\w-]{16,}/g, // SendGrid
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:Bearer|Basic|Token)\s+(?=[\w.~+/=-]*\d)[\w.~+/=-]{8,}/gi, // auth scheme followed by a token (not "Basic authentication")
];

/** @param {string} text */
function entropy(text) {
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Long random-looking token: mixed case and digits, high entropy (API keys, session ids). @param {string} value */
function looksRandom(value) {
  return value.length >= 24 && value.length <= 4096 && /^[\w.~+/=-]+$/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && entropy(value) >= 4;
}

/** @param {string} digits */
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** Payment card number (13-19 digits passing the Luhn check, optional spaces or dashes). @param {string} value */
function looksLikeCard(value) {
  const digits = value.replace(/[ -]/g, "");
  return /^\d{13,19}$/.test(digits) && /^[\d -]+$/.test(value) && luhn(digits);
}

/** True when the value is a credential that a recipe must not contain and that calls should replay. @param {unknown} value */
export function looksLikeSecret(value) {
  if (typeof value !== "string" || value.length < 8) return false;
  if (CREDENTIAL_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(value))) return true;
  return looksRandom(value);
}

/** True when the value must be hidden from a recipe (credentials, card numbers, long hex keys), even if it is not replayed. @param {unknown} value */
export function looksSensitive(value) {
  if (typeof value !== "string") return false;
  return looksLikeSecret(value) || looksLikeCard(value) || /^[0-9a-f]{32,}$/i.test(value);
}

/** @param {string} name @param {string} value whether a query parameter goes to the secret store (and is injected at call time) */
export function isSecretParam(name, value) {
  return SENSITIVE_FIELD.test(name) || (!OPAQUE_NON_SECRET.test(name) && looksLikeSecret(value));
}

/** @param {string} name @param {string} value */
export function isSecretHeader(name, value) {
  return SENSITIVE_HEADER.test(name) || looksLikeSecret(value);
}

/** Replaces credential-looking substrings inside free text. @param {string} text */
export function scrubText(text) {
  if (typeof text !== "string" || text.length < 8) return text;
  let out = text;
  for (const pattern of CREDENTIAL_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** Copy of a JSON value with sensitive fields and sensitive-looking values replaced by "REDACTED". @param {unknown} value @returns {unknown} */
export function redact(value, depth = 0, sensitiveParent = false) {
  if (depth > 20) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, sensitiveParent));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, depth + 1, sensitiveParent || SENSITIVE_FIELD.test(key))]));
  }
  if (sensitiveParent && value !== null && value !== undefined && typeof value !== "boolean") return REDACTED;
  if (typeof value === "string") return looksSensitive(value) ? REDACTED : scrubText(value);
  return value;
}

/** URL safe to show: no user:password, no fragment, sensitive query values and secret-looking path segments hidden. @param {string} address */
export function redactUrl(address) {
  const url = new URL(address);
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const [key, value] of [...url.searchParams]) if (SENSITIVE_FIELD.test(key) || looksSensitive(value)) url.searchParams.set(key, REDACTED);
  url.pathname = url.pathname
    .split("/")
    .map((segment) => (looksSensitive(safeDecode(segment)) ? REDACTED : segment))
    .join("/");
  return url.toString();
}

/** Redacts a text body: form-encoded "name=value" pairs by name and value, other text by credential patterns. @param {string} text */
export function redactText(text) {
  if (/^[^\s=&]+=[^&]*(&[^\s=&]+=[^&]*)*$/.test(text)) {
    const params = new URLSearchParams(text);
    for (const [key, value] of [...params]) if (SENSITIVE_FIELD.test(key) || looksSensitive(value)) params.set(key, REDACTED);
    return params.toString();
  }
  return scrubText(text);
}

/** Redacts string literals passed to sensitive arguments (or looking like secrets) in a GraphQL document. @param {string | null} query */
export function redactGraphqlQuery(query) {
  if (typeof query !== "string") return query;
  return query.replace(/([A-Za-z_]\w*)(\s*:\s*)"((?:[^"\\]|\\.)*)"/g, (match, name, separator, value) =>
    SENSITIVE_FIELD.test(name) || looksSensitive(value) ? `${name}${separator}"${REDACTED}"` : match,
  );
}

/** @param {string} segment */
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Last line of defence before a recipe is written: removes every known secret value (from the secret store)
 * and every credential-looking substring from all strings of the recipe.
 * @template T @param {T} recipe @param {Iterable<string>} knownSecrets @returns {T}
 */
export function scrubRecipe(recipe, knownSecrets) {
  const needles = [...new Set([...knownSecrets].filter((s) => typeof s === "string" && s.length >= 6))].sort((a, b) => b.length - a.length);
  // Values like "Bearer xyz" are also stored as their bare token.
  for (const value of [...needles]) {
    const bare = /^(?:Bearer|Basic|Token)\s+(.+)$/i.exec(value)?.[1];
    if (bare && bare.length >= 6) needles.push(bare);
  }
  /** @param {unknown} node @returns {unknown} */
  const walk = (node, depth = 0) => {
    if (depth > 40) return node;
    if (typeof node === "string") {
      let out = node;
      for (const needle of needles) if (out.includes(needle)) out = out.split(needle).join(REDACTED);
      return scrubText(out);
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value, depth + 1)]));
    return node;
  };
  return /** @type {T} */ (walk(recipe));
}

/** Every string value stored in a secrets map (host -> name -> value). @param {Record<string, Record<string, any>>} secrets */
export function secretValues(secrets) {
  const values = [];
  for (const entries of Object.values(secrets ?? {})) {
    for (const value of Object.values(entries ?? {})) {
      if (typeof value === "string") {
        values.push(value);
        // Cookie headers: each cookie value is a secret on its own.
        for (const part of value.split(/;\s*/)) {
          const cookieValue = part.split("=").slice(1).join("=");
          if (cookieValue.length >= 6) values.push(cookieValue);
        }
      } else if (value && typeof value === "object") values.push(...Object.values(value).filter((v) => typeof v === "string"));
    }
  }
  return values;
}
