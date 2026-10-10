// First OAuth sign-in (authorization code + PKCE, RFC 6749 / RFC 7636, loopback redirect as in RFC 8252):
// the provider's consent page opens in a visible window, a local listener receives the code, and the tokens are kept
// so that auth.js can refresh them later.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

/** Well-known providers: endpoints and the parameters they need to return a refresh token. */
export const OAUTH_PROVIDERS = {
  google: { authorize_url: "https://accounts.google.com/o/oauth2/v2/auth", token_url: "https://oauth2.googleapis.com/token", extra: { access_type: "offline", prompt: "consent" } },
  github: { authorize_url: "https://github.com/login/oauth/authorize", token_url: "https://github.com/login/oauth/access_token", extra: {} },
  microsoft: { authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token", extra: {} },
  spotify: { authorize_url: "https://accounts.spotify.com/authorize", token_url: "https://accounts.spotify.com/api/token", extra: {} },
};

/** @param {Buffer} bytes */
const base64url = (bytes) => bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * @typedef {object} OAuthLoginOptions
 * @property {string} authorizeUrl
 * @property {string} tokenUrl
 * @property {string} clientId
 * @property {string} [clientSecret] confidential clients only (some providers, e.g. Google "desktop" clients, issue one anyway)
 * @property {string[]} [scopes]
 * @property {Record<string, string>} [extra] extra authorization parameters (e.g. access_type=offline)
 * @property {number} [redirectPort] fixed loopback port when the provider requires a registered redirect URI (default: any free port)
 * @property {(url: string) => Promise<void>} openUrl opens the consent page for the user
 * @property {number} timeoutMs how long the user has to consent
 */

/**
 * @param {OAuthLoginOptions} options
 * @returns {Promise<{ accessToken: string, refreshToken?: string, tokenType: string, expiresIn?: number, scope?: string, redirectUri: string }>}
 */
export async function authorizationCodeLogin({ authorizeUrl, tokenUrl, clientId, clientSecret, scopes = [], extra = {}, redirectPort = 0, openUrl, timeoutMs }) {
  for (const [label, value] of [["authorize_url", authorizeUrl], ["token_url", tokenUrl]]) {
    if (!/^https?:\/\//i.test(value)) throw new Error(`${label} must be an http(s) URL`);
  }
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  /** @type {(value: { code: string } | { error: string }) => void} */ let deliver = () => {};
  const received = new Promise((resolve) => (deliver = resolve));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") return res.writeHead(404).end();
    const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
    res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    res.end(ok ? "<p>Signed in. You can close this window.</p>" : "<p>Sign-in failed. You can close this window.</p>");
    if (url.searchParams.get("state") !== state) deliver({ error: "state mismatch (the answer did not come from this sign-in)" });
    else if (!ok) deliver({ error: `${url.searchParams.get("error") ?? "no code"}${url.searchParams.get("error_description") ? `: ${url.searchParams.get("error_description")}` : ""}` });
    else deliver({ code: String(url.searchParams.get("code")) });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(redirectPort, "127.0.0.1", () => resolve(undefined));
  });
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    const authorize = new URL(authorizeUrl);
    const params = { response_type: "code", client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: "S256", ...(scopes.length ? { scope: scopes.join(" ") } : {}), ...extra };
    for (const [key, value] of Object.entries(params)) authorize.searchParams.set(key, value);
    /** @type {NodeJS.Timeout | undefined} */ let timer;
    const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve({ error: `no answer within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs)));
    const opened = openUrl(authorize.toString()).catch((error) => ({ error: `could not open the consent page: ${error.message}` }));
    const answer = /** @type {{ code?: string, error?: string }} */ (await Promise.race([received, timeout, opened.then((r) => (r && "error" in r ? r : new Promise(() => {})))]));
    clearTimeout(timer);
    if (!answer.code) throw new Error(`OAuth sign-in failed: ${answer.error}`);

    const fields = { grant_type: "authorization_code", code: answer.code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, ...(clientSecret ? { client_secret: clientSecret } : {}) };
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    /** @type {any} */ let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = Object.fromEntries(new URLSearchParams(text)); // some providers answer form-encoded
    }
    if (!response.ok || typeof body.access_token !== "string") throw new Error(`OAuth token exchange failed: HTTP ${response.status} ${String(body.error_description ?? body.error ?? "").slice(0, 200)}`);
    return {
      accessToken: body.access_token, refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
      tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer", expiresIn: body.expires_in ? Number(body.expires_in) : undefined,
      scope: typeof body.scope === "string" ? body.scope : undefined, redirectUri,
    };
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}
