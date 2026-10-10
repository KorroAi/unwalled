// Keeps credentials alive: detects expired bearer JWTs and refreshes OAuth access tokens with a stored refresh token.
// (Browser recipes are additionally re-authenticated by reloading the site in their profile: see Engine.recoverAuth.)

/** Expiry (seconds since epoch) of a "Bearer <JWT>" header value, or null. @param {string | undefined} authorization */
export function jwtExpiry(authorization) {
  const token = /^Bearer\s+(eyJ[\w-]+\.([\w-]+)\.[\w-]*)$/i.exec(authorization ?? "")?.[2];
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/** True when the stored bearer JWT expires within `marginSeconds`. @param {string | undefined} authorization */
export function isExpired(authorization, marginSeconds = 30) {
  const exp = jwtExpiry(authorization);
  return exp !== null && exp - marginSeconds <= Date.now() / 1000;
}

/**
 * @typedef {object} OAuthRefresh
 * @property {string} token_url
 * @property {string} refresh_token
 * @property {string} [client_id]
 * @property {string} [client_secret]
 * @property {string} [scope]
 * @property {"form" | "json"} [encoding]
 */

/**
 * Exchanges a refresh token for a new access token (RFC 6749 section 6).
 * @param {OAuthRefresh} config @param {number} timeoutMs
 * @returns {Promise<{ accessToken: string, refreshToken?: string, tokenType: string }>}
 */
export async function refreshOAuth(config, timeoutMs) {
  const url = new URL(config.token_url);
  if (!/^https?:$/.test(url.protocol)) throw new Error("token_url must be http(s)");
  const fields = {
    grant_type: "refresh_token",
    refresh_token: config.refresh_token,
    ...(config.client_id ? { client_id: config.client_id } : {}),
    ...(config.client_secret ? { client_secret: config.client_secret } : {}),
    ...(config.scope ? { scope: config.scope } : {}),
  };
  const json = config.encoding === "json";
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": json ? "application/json" : "application/x-www-form-urlencoded" },
    body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  if (!response.ok || typeof body.access_token !== "string") throw new Error(`OAuth refresh failed: HTTP ${response.status} ${String(body.error ?? "").slice(0, 100)}`);
  return { accessToken: body.access_token, refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined, tokenType: body.token_type ?? "Bearer" };
}
