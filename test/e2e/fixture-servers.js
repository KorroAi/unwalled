// Local servers used by the end-to-end tests:
// - a "shop" single-page app whose data comes from REST + GraphQL calls, with cookie and bearer-token auth;
// - a "pets" API that publishes an OpenAPI description and requires an API key for writes.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture shop</title></head>
<body>
<input id="q"><button id="go">Search</button><button id="login">Log in</button>
<pre id="out"></pre>
<script>
const out = (value) => (document.getElementById("out").textContent += JSON.stringify(value) + "\\n");
const get = (url, options) => fetch(url, options).then((r) => r.json()).then(out);
get("/api/products?page=1&limit=5");
const match = location.pathname.match(/^\\/product\\/([^/]+)/);
if (match) { get("/api/products/" + match[1]); get("/api/products/" + match[1] + "/reviews"); }
get("/graphql", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ operationName: "GetCart", query: "query GetCart($id: ID!) { cart(id: $id) { id total } }", variables: { id: "c1" } }) });
document.getElementById("go").onclick = () => get("/api/search?q=" + encodeURIComponent(document.getElementById("q").value));
const loadAccount = (token) => { get("/api/me"); get("/api/orders", { headers: { authorization: "Bearer " + token } }); };
document.getElementById("login").onclick = async () => {
  const response = await fetch("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "demo" }) });
  const { token } = await response.json();
  localStorage.setItem("token", token);
  loadAccount(token);
};
const saved = localStorage.getItem("token");
if (saved) loadAccount(saved);
</script>
</body></html>`;

/** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** @param {import("node:http").IncomingMessage} req */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

const TOKEN = "tok-123";
const SESSION = "sid=abc";

/** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
async function shop(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (req.method === "GET" && (path === "/" || path.startsWith("/product/") || path === "/search")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }
  if (req.method === "POST" && path === "/auth/login") {
    await readBody(req);
    return json(res, 200, { token: TOKEN }, { "set-cookie": `${SESSION}; HttpOnly; Path=/; SameSite=Lax` });
  }
  if (path === "/api/me") {
    return (req.headers.cookie ?? "").includes(SESSION) ? json(res, 200, { user: "demo", plan: "pro" }) : json(res, 401, { error: "not logged in" });
  }
  if (path === "/api/orders") {
    return req.headers.authorization === `Bearer ${TOKEN}` ? json(res, 200, { orders: [{ id: "o1", total: 12.5 }] }) : json(res, 401, { error: "missing token" });
  }
  if (path === "/api/products") {
    const page = Number(url.searchParams.get("page") ?? 1);
    return json(res, 200, { page, items: [{ id: "blue-lamp", name: "Blue lamp" }, { id: "red-chair", name: "Red chair" }] });
  }
  const product = path.match(/^\/api\/products\/([^/]+)(\/reviews)?$/);
  if (product) {
    const id = decodeURIComponent(product[1]);
    return product[2] ? json(res, 200, [{ product: id, stars: 5 }]) : json(res, 200, { id, name: `Product ${id}`, price: 42 });
  }
  if (path === "/api/search") return json(res, 200, { query: url.searchParams.get("q"), results: [{ id: "blue-lamp" }] });
  if (req.method === "POST" && path === "/graphql") {
    const body = await readBody(req);
    if (body.operationName === "GetCart") return json(res, 200, { data: { cart: { id: body.variables?.id, total: 3 } } });
    if (typeof body.query === "string" && body.query.includes("__typename")) return json(res, 200, { data: { __typename: "Query" } });
    return json(res, 400, { errors: [{ message: "unknown operation" }] });
  }
  json(res, 404, { error: "not found" });
}

/** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
async function pets(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/openapi.yaml") {
    res.writeHead(200, { "content-type": "application/yaml" });
    return res.end(readFileSync(new URL("../fixtures/petstore.yaml", import.meta.url)));
  }
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
  const [shopServer, petsServer] = await Promise.all([listen(shop), listen(pets)]);
  return {
    shopUrl: shopServer.url,
    petsUrl: petsServer.url,
    close: () => Promise.all([shopServer.close(), petsServer.close()]),
  };
}
