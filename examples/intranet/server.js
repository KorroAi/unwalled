// "Acme Back Office": a small stand-in for the internal tools companies run (no public API, no documentation,
// a login form and a session cookie). Used by the demo, the benchmark and the end-to-end examples.
// Run: node examples/intranet/server.js [port]  →  sign in as alice / demo
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const STATUSES = ["pending", "paid", "shipped", "delivered", "refunded"];
const CITIES = ["Lyon", "Lille", "Nantes", "Bordeaux", "Toulouse", "Nice", "Rennes", "Grenoble"];
const PRODUCTS = ["Desk lamp", "Office chair", "Standing desk", "Monitor arm", "Keyboard", "Headset", "Webcam", "Docking station"];

/** Deterministic data, so the demo and the benchmark always see the same records. */
function dataset() {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const customers = Array.from({ length: 40 }, (_, i) => ({
    id: 501 + i,
    company: `${["Nova", "Blue", "Iron", "Green", "Swift", "Bright", "Prime", "North"][i % 8]} ${["Logistics", "Foods", "Studio", "Labs", "Retail"][i % 5]}`,
    city: CITIES[Math.floor(next() * CITIES.length)],
    since: 2015 + Math.floor(next() * 10),
  }));
  const orders = Array.from({ length: 200 }, (_, i) => {
    const lines = Array.from({ length: 1 + Math.floor(next() * 3) }, () => ({ product: PRODUCTS[Math.floor(next() * PRODUCTS.length)], qty: 1 + Math.floor(next() * 4), unitPrice: 20 + Math.floor(next() * 380) }));
    return {
      id: 1001 + i,
      customerId: customers[Math.floor(next() * customers.length)].id,
      status: STATUSES[Math.floor(next() * STATUSES.length)],
      date: new Date(Date.UTC(2026, Math.floor(next() * 9), 1 + Math.floor(next() * 28))).toISOString().slice(0, 10),
      lines,
      total: lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0),
    };
  });
  return { customers, orders };
}

const LAYOUT = (title, body, script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="csrf-token" content="__CSRF__"><title>${title} · Acme Back Office</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;color:#1f2937}header{background:#1e3a5f;color:#fff;padding:12px 24px;display:flex;gap:24px;align-items:center}
header a{color:#cbd5e1;text-decoration:none}main{padding:24px;max-width:960px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e5e7eb;padding:6px 8px;text-align:left}
.badge{padding:2px 8px;border-radius:9px;background:#e0e7ff}footer{padding:24px;color:#6b7280;font-size:13px}
</style></head><body>
<header><strong>Acme Back Office</strong><nav><a href="/orders">Orders</a> · <a href="/customers">Customers</a> · <a href="/reports">Reports</a> · <a href="/help">Help</a></nav><span style="margin-left:auto">alice@acme.example · <a href="/logout">Sign out</a></span></header>
<main>${body}</main>
<footer>Acme Back Office v4.2 — internal use only — support: it-desk@acme.example — build 2026.10</footer>
${script ? `<script>${script}</script>` : ""}
</body></html>`;

const ORDER_PAGE = (id) =>
  LAYOUT(
    `Order ${id}`,
    `<h1>Order <span id="order-id">${id}</span></h1><p>Status: <span id="order-status" class="badge">loading…</span></p>
<p>Customer: <a id="customer"></a> · Date: <span id="date"></span> · Total: <strong id="total"></strong></p>
<table><thead><tr><th>Product</th><th>Qty</th><th>Unit price</th></tr></thead><tbody id="lines"></tbody></table>
<h2>Actions</h2><button id="refund">Refund order</button> <button id="resend">Resend invoice</button>
<h2>Notes</h2><ul id="notes"></ul><input id="note" aria-label="Note"> <button id="add-note">Add note</button>`,
    `const api = (path, options = {}) => fetch(path, { ...options, headers: { "x-requested-with": "acme-bo", ...(options.headers || {}) } }).then((r) => r.json());
api("/api/v2/orders/${id}").then(async (o) => {
  document.getElementById("order-status").textContent = o.status;
  document.getElementById("date").textContent = o.date;
  document.getElementById("total").textContent = o.total + " EUR";
  document.getElementById("lines").innerHTML = o.lines.map((l) => "<tr><td>" + l.product + "</td><td>" + l.qty + "</td><td>" + l.unitPrice + "</td></tr>").join("");
  const c = await api("/api/v2/customers/" + o.customerId);
  const link = document.getElementById("customer"); link.textContent = c.company + " (" + c.city + ")"; link.href = "/customers/" + c.id;
});
document.getElementById("refund").onclick = () => api("/api/v2/orders/${id}/refund", { method: "POST" }).then(() => location.reload());
// Notes are protected like a Rails form: the page's CSRF token goes in the body.
const showNotes = () => api("/api/v2/orders/${id}/notes").then((n) => { document.getElementById("notes").innerHTML = n.notes.map((t) => "<li>" + t + "</li>").join(""); });
showNotes();
document.getElementById("add-note").onclick = () => api("/api/v2/orders/${id}/notes", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ authenticity_token: document.querySelector('meta[name="csrf-token"]').content, text: document.getElementById("note").value }) }).then(showNotes);`,
  );

const ORDERS_PAGE = LAYOUT(
  "Orders",
  `<h1>Orders</h1><label>Status <select id="status"><option value="">all</option>${STATUSES.map((s) => `<option>${s}</option>`).join("")}</select></label>
<table><thead><tr><th>#</th><th>Date</th><th>Status</th><th>Total</th></tr></thead><tbody id="rows"></tbody></table>`,
  `const load = () => fetch("/api/v2/orders?status=" + document.getElementById("status").value + "&page=1&per_page=20", { headers: { "x-requested-with": "acme-bo" } })
  .then((r) => r.json()).then((d) => { document.getElementById("rows").innerHTML = d.orders.map((o) => "<tr><td><a href='/orders/" + o.id + "'>" + o.id + "</a></td><td>" + o.date + "</td><td>" + o.status + "</td><td>" + o.total + "</td></tr>").join(""); });
document.getElementById("status").onchange = load; load();`,
);

const LOGIN_PAGE = (error = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in · Acme Back Office</title></head>
<body style="font-family:system-ui;max-width:320px;margin:80px auto"><h1>Acme Back Office</h1>${error ? `<p role="alert">${error}</p>` : ""}
<form method="post" action="/login"><p><label>User <input id="user" name="user" autocomplete="username"></label></p>
<p><label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label></p><button type="submit">Sign in</button></form></body></html>`;

/** CSRF token of a session, as a Rails app puts it in its pages. @param {string} session */
const csrfFor = (session) => createHash("sha256").update(`csrf:${session}`).digest("hex").slice(0, 32);

/** @param {number} [port] */
export async function startIntranet(port = 0) {
  const { customers, orders } = dataset();
  const sessions = new Set();
  /** @type {Map<number, string[]>} */ const notes = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const session = /(?:^|;\s*)acme_session=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1];
    const signedIn = !!session && sessions.has(session);
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(type === "text/html" ? body.replace("__CSRF__", session ? csrfFor(session) : "") : body);
    };
    const json = (status, value) => send(status, "application/json", JSON.stringify(value));

    if (path === "/login" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      if (form.get("user") !== "alice" || form.get("password") !== "demo") return send(401, "text/html", LOGIN_PAGE("Wrong user or password."));
      const id = randomBytes(16).toString("hex");
      sessions.add(id);
      return send(303, "text/plain", "", { location: "/orders", "set-cookie": `acme_session=${id}; HttpOnly; Path=/; SameSite=Lax` });
    }
    if (path === "/login") return send(200, "text/html", LOGIN_PAGE());
    if (path === "/logout") {
      if (session) sessions.delete(session);
      return send(303, "text/plain", "", { location: "/login", "set-cookie": "acme_session=; Path=/; Max-Age=0" });
    }
    if (path.startsWith("/api/")) {
      if (!signedIn) return json(401, { error: "not signed in" });
      if (req.headers["x-requested-with"] !== "acme-bo") return json(400, { error: "missing x-requested-with header" });
      const notesOf = /^\/api\/v2\/orders\/(\d+)\/notes$/.exec(path);
      if (notesOf) {
        const list = notes.get(Number(notesOf[1])) ?? [];
        if (req.method === "POST") {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw || "{}");
          if (body.authenticity_token !== csrfFor(String(session))) return json(422, { error: "invalid authenticity token" });
          list.push(String(body.text ?? ""));
          notes.set(Number(notesOf[1]), list);
        }
        return json(200, { notes: list });
      }
      const order = /^\/api\/v2\/orders\/(\d+)(\/refund)?$/.exec(path);
      if (order) {
        const found = orders.find((o) => o.id === Number(order[1]));
        if (!found) return json(404, { error: "no such order" });
        if (order[2]) {
          if (req.method !== "POST") return json(405, { error: "use POST" });
          found.status = "refunded";
        }
        return json(200, found);
      }
      const customer = /^\/api\/v2\/customers\/(\d+)$/.exec(path);
      if (customer) {
        const found = customers.find((c) => c.id === Number(customer[1]));
        return found ? json(200, found) : json(404, { error: "no such customer" });
      }
      if (path === "/api/v2/orders") {
        const status = url.searchParams.get("status");
        const perPage = Math.min(Number(url.searchParams.get("per_page") ?? 20), 100);
        const page = Math.max(Number(url.searchParams.get("page") ?? 1), 1);
        const list = orders.filter((o) => !status || o.status === status);
        return json(200, { total: list.length, page, orders: list.slice((page - 1) * perPage, page * perPage).map(({ lines, ...o }) => o) });
      }
      return json(404, { error: "unknown endpoint" });
    }
    if (!signedIn) return send(303, "text/plain", "", { location: "/login" });
    const orderPage = /^\/orders\/(\d+)$/.exec(path);
    if (orderPage) return send(200, "text/html", ORDER_PAGE(orderPage[1]));
    if (path === "/" || path === "/orders") return send(200, "text/html", ORDERS_PAGE);
    return send(200, "text/html", LAYOUT("Not ready", "<h1>This page is not available in the demo.</h1>"));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${address.port}`, orders, customers, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url } = await startIntranet(Number(process.argv[2] ?? 8099));
  console.log(`Acme Back Office running at ${url} (sign in as alice / demo). Ctrl+C to stop.`);
}
