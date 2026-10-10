// End-to-end: first OAuth sign-in (authorization code + PKCE) through a real browser, then API calls and automatic refresh.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const TIMEOUT = { timeout: 120_000 };
const base64url = (buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("oauth_login", TIMEOUT, () => {
  let server, base, home, engine;
  const state = { challenge: "", deny: false, validToken: "", issued: 0, refreshed: 0 };
  before(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/authorize") {
        const redirect = new URL(String(url.searchParams.get("redirect_uri")));
        assert.equal(redirect.hostname, "127.0.0.1");
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        assert.equal(url.searchParams.get("client_id"), "app-1");
        state.challenge = String(url.searchParams.get("code_challenge"));
        if (state.deny) redirect.search = new URLSearchParams({ error: "access_denied", error_description: "The user said no", state: String(url.searchParams.get("state")) }).toString();
        else redirect.search = new URLSearchParams({ code: "code-1", state: String(url.searchParams.get("state")) }).toString();
        return res.writeHead(302, { location: redirect.toString() }).end();
      }
      if (url.pathname === "/token") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        if (form.get("grant_type") === "authorization_code") {
          const verified = form.get("code") === "code-1" && base64url(createHash("sha256").update(String(form.get("code_verifier"))).digest()) === state.challenge;
          if (!verified) return res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid_grant"}');
          state.issued++;
          state.validToken = `access-${state.issued}`;
          return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: state.validToken, refresh_token: "refresh-1", token_type: "bearer", expires_in: 3600, scope: "read" }));
        }
        if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "refresh-1") {
          state.refreshed++;
          state.validToken = `access-refreshed-${state.refreshed}`;
          return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: state.validToken, token_type: "Bearer" }));
        }
        return res.writeHead(400).end();
      }
      if (url.pathname === "/api/me") {
        const ok = req.headers.authorization === `Bearer ${state.validToken}`;
        return res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end(ok ? '{"user":"ada"}' : '{"error":"unauthorized"}');
      }
      res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
    home = mkdtempSync(join(tmpdir(), "umcp-oauth-"));
    process.env.UNWALLED_HOME = home;
    const { loadConfig } = await import("../../src/config.js");
    const { Engine } = await import("../../src/core.js");
    engine = new Engine(loadConfig());
  });
  after(async () => {
    await engine?.close();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    rmSync(home, { recursive: true, force: true });
  });

  it("signs in, calls the API with the token and refreshes it when it is rejected", TIMEOUT, async () => {
    const spec = join(home, "api.json");
    writeFileSync(spec, JSON.stringify({ openapi: "3.0.0", info: { title: "Me", version: "1" }, servers: [{ url: base }], paths: { "/api/me": { get: { operationId: "me" } } } }));
    await engine.importFile({ name: "me", path: spec });
    const host = new URL(base).host;
    const result = await engine.oauthLogin({ name: "me", host, authorizeUrl: `${base}/authorize`, tokenUrl: `${base}/token`, clientId: "app-1", scopes: ["read"], visible: false, durationSeconds: 30 });
    assert.deepEqual(result, { host, refreshable: true, scope: "read", expiresIn: 3600 });
    const me = await /** @type {any} */ (engine.tools.get("me__me")).run({});
    assert.match(me.text, /HTTP 200[\s\S]*"ada"/);

    state.validToken = "rotated-by-the-server"; // the stored access token is no longer accepted
    const again = await /** @type {any} */ (engine.tools.get("me__me")).run({});
    assert.match(again.text, /HTTP 200[\s\S]*"ada"/, again.text);
    assert.equal(state.refreshed, 1, "the refresh token was used");
  });

  it("reports a refused consent", TIMEOUT, async () => {
    state.deny = true;
    await assert.rejects(
      engine.oauthLogin({ name: "me", host: new URL(base).host, authorizeUrl: `${base}/authorize`, tokenUrl: `${base}/token`, clientId: "app-1", visible: false, durationSeconds: 30 }),
      /access_denied: The user said no/,
    );
  });
});
