// Local servers used by the end-to-end tests:
// - a "shop" single-page app whose data comes from REST + GraphQL calls, with cookie and rotating bearer-token auth,
//   a double-submit CSRF endpoint, a bot-protected endpoint, uploads, downloads, a server-rendered page and an API that can drift;
// - a "pets" API that publishes an OpenAPI description, requires an API key for writes and has an OAuth-protected route.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const page = (v2) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture shop</title></head>
<body>
<nav><a href="/product/red-chair">Red chair</a> <a href="/about">About</a> <a href="/logout">Log out</a></nav>
<input id="q" aria-label="Search text"><button id="go">Search</button><button id="login">Log in</button>
<button id="add">Add to cart</button><button id="wipe">Delete all</button>
<pre id="out"></pre>
<script>
const out = (value) => (document.getElementById("out").textContent += JSON.stringify(value) + "\\n");
const get = (url, options) => fetch(url, options).then((r) => r.json()).then(out);
get("${v2 ? "/api/v2/products" : "/api/products"}?page=1&limit=5");
get("/api/protected");
fetch("/api/plain").then((r) => r.text()).then(out);
fetch("/api/prefixed").then((r) => r.text()).then(out);
const match = location.pathname.match(/^\\/product\\/([^/]+)/);
if (match) { get("/api/products/" + match[1]); get("/api/products/" + match[1] + "/reviews"); }
get("/graphql", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ operationName: "GetCart", query: "query GetCart($id: ID!) { cart(id: $id) { id total } }", variables: { id: "c1" } }) });
document.getElementById("go").onclick = () => get("/api/search?q=" + encodeURIComponent(document.getElementById("q").value));
const loadAccount = (token) => { get("/api/me"); get("/api/orders", { headers: { authorization: "Bearer " + token } }); };
document.getElementById("login").onclick = async () => {
  const response = await fetch("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "demo" }) });
  const { token } = await response.json();
  localStorage.setItem("loggedIn", "1");
  loadAccount(token);
};
if (localStorage.getItem("loggedIn")) fetch("/auth/refresh", { method: "POST" }).then((r) => r.json()).then(({ token }) => token && loadAccount(token));
document.getElementById("add").onclick = () => {
  const xsrf = decodeURIComponent((document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || "");
  get("/api/cart", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": xsrf }, body: JSON.stringify({ product: "blue-lamp", qty: 1 }) });
};
document.getElementById("wipe").onclick = () => fetch("/api/products", { method: "DELETE" });
</script>
</body></html>`;

const ABOUT = `<!doctype html><html><head><meta charset="utf-8"><title>About</title></head><body>
<h1>About us</h1><a href="/">Home</a>
<script>fetch("/api/team").then((r) => r.json());</script></body></html>`;

const SSR = `<!doctype html><html><head><title>Catalogue</title><style>h1{color:red}</style></head><body>
<h1>Catalogue</h1><table><tr><th>Product</th><th>Price</th></tr><tr><td>Blue lamp</td><td>42 &euro;</td></tr></table>
<form action="/ssr/search"><input name="q" aria-label="Find"><button>Find</button></form></body></html>`;

/** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** @param {import("node:http").IncomingMessage} req */
async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** @param {import("node:http").IncomingMessage} req */
async function readBody(req) {
  const text = (await readRaw(req)).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/** @param {import("node:http").IncomingMessage} req @param {string} name */
const cookie = (req, name) => decodeURIComponent(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? "")?.[1] ?? "");

const SESSION = "sid=abc";

function makeShop() {
  const state = { tokenVersion: 1, drift: false, stats: { logoutHits: 0, deleteHits: 0, protectedRefused: 0 } };
  const token = () => `tok-${state.tokenVersion}`;
  /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
  return async function shop(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const html = (body) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": `XSRF-TOKEN=${randomBytes(8).toString("hex")}; Path=/; SameSite=Lax` });
      res.end(body);
    };
    if (req.method === "GET" && (path === "/" || path.startsWith("/product/") || path === "/search")) return html(page(state.drift));
    if (path === "/about") return html(ABOUT);
    if (path === "/ssr") return html(SSR);
    if (path === "/logout") {
      state.stats.logoutHits++;
      return html("<html><body>bye</body></html>");
    }
    // Test controls
    if (path === "/__stats") return json(res, 200, state.stats);
    if (path === "/__rotate") {
      state.tokenVersion++;
      return json(res, 200, { token: token() });
    }
    if (path === "/__drift") {
      state.drift = true;
      return json(res, 200, { drift: true });
    }

    if (req.method === "POST" && path === "/auth/login") {
      await readBody(req);
      return json(res, 200, { token: token() }, { "set-cookie": `${SESSION}; HttpOnly; Path=/; SameSite=Lax` });
    }
    if (req.method === "POST" && path === "/auth/refresh") {
      return (req.headers.cookie ?? "").includes(SESSION) ? json(res, 200, { token: token() }) : json(res, 401, { error: "no session" });
    }
    if (path === "/api/me") {
      return (req.headers.cookie ?? "").includes(SESSION) ? json(res, 200, { user: "demo", plan: "pro" }) : json(res, 401, { error: "not logged in" });
    }
    if (path === "/api/orders") {
      return req.headers.authorization === `Bearer ${token()}` ? json(res, 200, { orders: [{ id: "o1", total: 12.5 }] }) : json(res, 401, { error: "missing or expired token" });
    }
    if (path === "/api/protected") {
      // Fake bot protection: only a real browser page sends sec-fetch-site.
      if (!req.headers["sec-fetch-site"]) {
        state.stats.protectedRefused++;
        res.writeHead(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
        return res.end("<html><title>Just a moment...</title></html>");
      }
      return json(res, 200, { protected: "ok" });
    }
    if (path === "/api/cart" && req.method === "POST") {
      const body = await readBody(req);
      const sent = String(req.headers["x-csrf-token"] ?? "");
      return sent && sent === cookie(req, "XSRF-TOKEN") ? json(res, 200, { added: body.product ?? null }) : json(res, 403, { error: "bad csrf token" });
    }
    if (path === "/api/products" && req.method === "DELETE") {
      state.stats.deleteHits++;
      return json(res, 200, { deleted: "all" });
    }
    if (path === "/api/products" || (path === "/api/v2/products" && state.drift)) {
      if (path === "/api/products" && state.drift) return json(res, 404, { error: "moved to /api/v2/products" });
      const pageNumber = Number(url.searchParams.get("page") ?? 1);
      const items = [{ id: "blue-lamp", name: "Blue lamp" }, { id: "red-chair", name: "Red chair" }];
      return json(res, 200, state.drift ? { pageNumber, products: items } : { page: pageNumber, items });
    }
    const product = path.match(/^\/api\/products\/([^/]+)(\/reviews)?$/);
    if (product) {
      const id = decodeURIComponent(product[1]);
      return product[2] ? json(res, 200, [{ product: id, stars: 5 }]) : json(res, 200, { id, name: `Product ${id}`, price: 42 });
    }
    if (path === "/api/plain") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(JSON.stringify({ kind: "plain", items: [1, 2] }));
    }
    if (path === "/api/prefixed") {
      res.writeHead(200, { "content-type": "application/javascript" });
      return res.end(")]}'\n" + JSON.stringify({ kind: "prefixed", ok: true }));
    }
    if (path === "/assets/logo.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));
    }
    if (path === "/api/search") return json(res, 200, { query: url.searchParams.get("q"), results: [{ id: "blue-lamp" }] });
    if (path === "/api/team") return json(res, 200, [{ name: "Ada" }]);
    if (path === "/api/upload" && req.method === "POST") {
      const raw = (await readRaw(req)).toString("latin1");
      return json(res, 200, {
        multipart: /multipart\/form-data/.test(req.headers["content-type"] ?? ""),
        file: /filename="([^"]+)"/.exec(raw)?.[1] ?? null,
        note: /name="note"\r\n\r\n([^\r]*)/.exec(raw)?.[1] ?? null,
        hasContent: raw.includes("hello upload"),
      });
    }
    if (path === "/files/report.bin") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    }
    if (req.method === "POST" && path === "/graphql") {
      const body = await readBody(req);
      if (body.operationName === "GetCart") return json(res, 200, { data: { cart: { id: body.variables?.id, total: 3 } } });
      if (typeof body.query === "string" && body.query.includes("__typename")) return json(res, 200, { data: { __typename: "Query" } });
      return json(res, 400, { errors: [{ message: "unknown operation" }] });
    }
    json(res, 404, { error: "not found" });
  };
}

/** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
async function pets(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/openapi.yaml") {
    res.writeHead(200, { "content-type": "application/yaml" });
    return res.end(readFileSync(new URL("../fixtures/petstore.yaml", import.meta.url)));
  }
  if (url.pathname === "/oauth/token" && req.method === "POST") {
    const form = new URLSearchParams((await readRaw(req)).toString("utf8"));
    if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "r1") return json(res, 200, { access_token: "acc-2", token_type: "bearer", refresh_token: "r2" });
    return json(res, 400, { error: "invalid_grant" });
  }
  if (url.pathname === "/v1/slow") {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return json(res, 200, { slow: true });
  }
  if (url.pathname === "/v1/echo-headers") return json(res, 200, { lang: req.headers["x-lang"] ?? null });
  if (url.pathname === "/v1/secure") return req.headers.authorization === "Bearer acc-2" ? json(res, 200, { secure: true }) : json(res, 401, { error: "expired" });
  if (url.pathname === "/v1/pets" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? 10);
    return json(res, 200, [{ id: "1", name: "Rex" }, { id: "2", name: "Tom" }].slice(0, limit));
  }
  if (url.pathname === "/v1/pets" && req.method === "POST") {
    if (req.headers["x-api-key"] !== "k1") return json(res, 401, { error: "api key required" });
    const body = await readBody(req);
    return json(res, 201, { id: "3", ...body });
  }
  const pet = url.pathname.match(/^\/v1\/pets\/([^/]+)$/);
  if (pet) return json(res, 200, { id: pet[1], name: `Pet ${pet[1]}` });
  json(res, 404, { error: "not found" });
}

/** @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<unknown>} handler @returns {Promise<{ url: string, close: () => Promise<void> }>} */
function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((error) => json(res, 500, { error: String(error) }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = /** @type {import("node:net").AddressInfo} */ (server.address());
      resolve({ url: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); }) });
    });
  });
}

export async function startFixtureServers() {
  const [shopServer, petsServer] = await Promise.all([listen(makeShop()), listen(pets)]);
  return {
    shopUrl: shopServer.url,
    petsUrl: petsServer.url,
    close: () => Promise.all([shopServer.close(), petsServer.close()]),
  };
}
