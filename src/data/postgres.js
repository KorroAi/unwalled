// Minimal PostgreSQL client (protocol v3, no dependency) for read-only queries: TLS (sslmode), SCRAM-SHA-256 / MD5 / cleartext
// authentication, extended query protocol with text parameters, every query inside a READ ONLY transaction with a timeout.
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

/** @param {string} url */
export function isPostgresUrl(url) {
  return /^postgres(ql)?:\/\//i.test(url);
}

/** Message: type byte + int32 length + body. @param {string} type @param {Buffer[]} parts */
function message(type, parts) {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(5);
  header.write(type, 0, "latin1");
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}
const cstring = (/** @type {string} */ s) => Buffer.from(`${s}\0`, "utf8");
const int16 = (/** @type {number} */ n) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
const int32 = (/** @type {number} */ n) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};

/** Text value -> JavaScript, by type OID. @param {string} text @param {number} oid */
function convert(text, oid) {
  switch (oid) {
    case 16: return text === "t";
    case 21: case 23: case 26: return Number(text);
    case 20: {
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : text;
    }
    case 700: case 701: return Number(text);
    case 1700: {
      // numeric: exact up to 15 significant digits, kept as text beyond (no silent rounding).
      const digits = text.replace(/[-.]/g, "").replace(/^0+/, "");
      return /^-?\d+(\.\d+)?$/.test(text) && digits.length <= 15 ? Number(text) : text;
    }
    case 114: case 3802: {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    default: return text;
  }
}

/** ErrorResponse fields -> Error. @param {Buffer} body */
function pgError(body) {
  /** @type {Record<string, string>} */ const fields = {};
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const code = String.fromCharCode(body[offset]);
    const end = body.indexOf(0, offset + 1);
    fields[code] = body.subarray(offset + 1, end).toString("utf8");
    offset = end + 1;
  }
  const error = new Error(`${fields.M ?? "PostgreSQL error"}${fields.D ? ` (${fields.D})` : ""}${fields.H ? ` Hint: ${fields.H}` : ""}`);
  /** @type {any} */ (error).code = fields.C;
  return error;
}

/**
 * One connection: authenticate, then run queries.
 * @param {string} url postgres://user:password@host:port/database?sslmode=disable|prefer|require|verify-full
 * @param {{ timeoutMs?: number }} [options]
 */
export async function connectPostgres(url, { timeoutMs = 15_000 } = {}) {
  const target = new URL(url);
  const user = decodeURIComponent(target.username || "postgres");
  const password = decodeURIComponent(target.password || "");
  const database = decodeURIComponent(target.pathname.replace(/^\//, "") || user);
  const port = Number(target.port || 5432);
  const sslmode = (target.searchParams.get("sslmode") ?? "prefer").toLowerCase();

  /** @type {import("node:net").Socket} */
  let socket = await new Promise((resolve, reject) => {
    const s = tcpConnect({ host: target.hostname, port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`Cannot reach ${target.hostname}:${port} within ${timeoutMs} ms`));
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Cannot reach ${target.hostname}:${port}: ${error.message}`));
    });
  });

  if (sslmode !== "disable") {
    socket.write(Buffer.concat([int32(8), int32(80877103)])); // SSLRequest
    const answer = await new Promise((resolve) => socket.once("data", (chunk) => resolve(String.fromCharCode(chunk[0]))));
    if (answer === "S") {
      socket = await new Promise((resolve, reject) => {
        const secure = tlsConnect({ socket, servername: /^[\d.]+$/.test(target.hostname) ? undefined : target.hostname, rejectUnauthorized: sslmode === "verify-full" || sslmode === "verify-ca" });
        secure.once("secureConnect", () => resolve(secure));
        secure.once("error", (error) => reject(new Error(`TLS with ${target.hostname} failed: ${error.message}`)));
      });
    } else if (sslmode === "require" || sslmode.startsWith("verify")) {
      socket.destroy();
      throw new Error(`${target.hostname} does not accept TLS (sslmode=${sslmode}).`);
    }
  }

  // ---------------------------------------------------------------- message reader
  let buffer = Buffer.alloc(0);
  /** @type {{ type: string, body: Buffer }[]} */ const queue = [];
  /** @type {(() => void) | null} */ let wake = null;
  /** @type {Error | null} */ let failure = null;
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5) {
      const length = buffer.readInt32BE(1);
      if (buffer.length < length + 1) break;
      queue.push({ type: String.fromCharCode(buffer[0]), body: buffer.subarray(5, length + 1) });
      buffer = buffer.subarray(length + 1);
    }
    wake?.();
  });
  socket.on("error", (error) => {
    failure = error;
    wake?.();
  });
  socket.on("close", () => {
    failure ??= new Error("connection closed by the server");
    wake?.();
  });
  /** @returns {Promise<{ type: string, body: Buffer }>} */
  const next = async () => {
    const deadline = Date.now() + timeoutMs;
    while (!queue.length) {
      if (failure) throw failure;
      if (Date.now() > deadline) throw new Error("PostgreSQL did not answer in time");
      await new Promise((resolve) => {
        wake = () => resolve(undefined);
        setTimeout(resolve, 200);
      });
      wake = null;
    }
    return /** @type {{ type: string, body: Buffer }} */ (queue.shift());
  };
  const send = (/** @type {Buffer} */ data) => socket.write(data);

  // ---------------------------------------------------------------- startup and authentication
  const params = Buffer.concat([cstring("user"), cstring(user), cstring("database"), cstring(database), cstring("application_name"), cstring("universal-mcp"), cstring("client_encoding"), cstring("UTF8"), Buffer.from([0])]);
  send(Buffer.concat([int32(params.length + 8), int32(196608), params]));
  /** @type {{ nonce: string, clientFirstBare: string, saltedPassword?: Buffer, authMessage?: string }} */ let scram = { nonce: "", clientFirstBare: "" };
  for (;;) {
    const { type, body } = await next();
    if (type === "E") {
      socket.destroy();
      throw pgError(body);
    }
    if (type === "Z") break;
    if (type !== "R") continue; // ParameterStatus, BackendKeyData, NoticeResponse
    const kind = body.readInt32BE(0);
    if (kind === 0) continue; // AuthenticationOk
    if (kind === 3) send(message("p", [cstring(password)]));
    else if (kind === 5) {
      const inner = createHash("md5").update(password + user).digest("hex");
      send(message("p", [cstring(`md5${createHash("md5").update(Buffer.concat([Buffer.from(inner), body.subarray(4, 8)])).digest("hex")}`)]));
    } else if (kind === 10) {
      const mechanisms = body.subarray(4).toString("utf8").split("\0").filter(Boolean);
      if (!mechanisms.includes("SCRAM-SHA-256")) throw new Error(`Unsupported SASL mechanisms: ${mechanisms.join(", ")}`);
      scram = { nonce: randomBytes(18).toString("base64"), clientFirstBare: "" };
      scram.clientFirstBare = `n=,r=${scram.nonce}`;
      const first = Buffer.from(`n,,${scram.clientFirstBare}`);
      send(message("p", [cstring("SCRAM-SHA-256"), int32(first.length), first]));
    } else if (kind === 11) {
      const serverFirst = body.subarray(4).toString("utf8");
      const attrs = Object.fromEntries(serverFirst.split(",").map((p) => [p[0], p.slice(2)]));
      if (!attrs.r?.startsWith(scram.nonce)) throw new Error("SCRAM: server nonce does not extend the client nonce");
      scram.saltedPassword = pbkdf2Sync(password.normalize("NFKC"), Buffer.from(attrs.s, "base64"), Number(attrs.i), 32, "sha256");
      const clientKey = createHmac("sha256", scram.saltedPassword).update("Client Key").digest();
      const storedKey = createHash("sha256").update(clientKey).digest();
      const clientFinalWithoutProof = `c=biws,r=${attrs.r}`;
      scram.authMessage = `${scram.clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
      const signature = createHmac("sha256", storedKey).update(scram.authMessage).digest();
      const proof = Buffer.from(clientKey.map((b, i) => b ^ signature[i])).toString("base64");
      send(message("p", [Buffer.from(`${clientFinalWithoutProof},p=${proof}`)]));
    } else if (kind === 12) {
      const verifier = Object.fromEntries(body.subarray(4).toString("utf8").split(",").map((p) => [p[0], p.slice(2)])).v;
      const serverKey = createHmac("sha256", /** @type {Buffer} */ (scram.saltedPassword)).update("Server Key").digest();
      const expected = createHmac("sha256", serverKey).update(/** @type {string} */ (scram.authMessage)).digest();
      if (!verifier || !timingSafeEqual(expected, Buffer.from(verifier, "base64"))) throw new Error("SCRAM: the server signature does not match (not the expected server)");
    } else throw new Error(`Unsupported PostgreSQL authentication method (${kind})`);
  }

  /** Runs one simple statement (no result rows expected). @param {string} sql */
  const simple = async (sql) => {
    send(message("Q", [cstring(sql)]));
    /** @type {Error | null} */ let error = null;
    for (;;) {
      const { type, body } = await next();
      if (type === "E") error = pgError(body);
      if (type === "Z") break;
    }
    if (error) throw error;
  };

  return {
    /**
     * Read-only query with text parameters ($1, $2...).
     * @param {string} sql @param {unknown[]} [values] @param {{ maxRows?: number, statementTimeoutMs?: number }} [options]
     * @returns {Promise<{ columns: string[], rows: Record<string, unknown>[], truncated: boolean }>}
     */
    async query(sql, values = [], { maxRows = 200, statementTimeoutMs = 30_000 } = {}) {
      const first = sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
      if (!/^(select|with|show|explain|values|table)\b/i.test(first)) throw new Error("Only read statements are allowed (SELECT, WITH, SHOW, EXPLAIN, VALUES, TABLE).");
      await simple(`BEGIN READ ONLY; SET LOCAL statement_timeout = ${Math.max(1000, Math.floor(statementTimeoutMs))}`);
      try {
        const encoded = values.map((v) => (v === null || v === undefined ? null : Buffer.from(typeof v === "object" ? JSON.stringify(v) : String(v), "utf8")));
        send(Buffer.concat([
          message("P", [cstring(""), cstring(sql), int16(0)]),
          message("B", [cstring(""), cstring(""), int16(0), int16(encoded.length), ...encoded.flatMap((v) => (v === null ? [int32(-1)] : [int32(v.length), v])), int16(0)]),
          message("D", [Buffer.from("P"), cstring("")]),
          message("E", [cstring(""), int32(maxRows + 1)]),
          message("S", []),
        ]));
        /** @type {{ name: string, oid: number }[]} */ let fields = [];
        /** @type {Record<string, unknown>[]} */ const rows = [];
        /** @type {Error | null} */ let error = null;
        let truncated = false;
        for (;;) {
          const { type, body } = await next();
          if (type === "E") error = pgError(body);
          else if (type === "T") {
            const count = body.readInt16BE(0);
            fields = [];
            let offset = 2;
            for (let i = 0; i < count; i++) {
              const end = body.indexOf(0, offset);
              const name = body.subarray(offset, end).toString("utf8");
              offset = end + 1;
              fields.push({ name, oid: body.readInt32BE(offset + 6) });
              offset += 18;
            }
          } else if (type === "D") {
            const count = body.readInt16BE(0);
            /** @type {Record<string, unknown>} */ const row = {};
            let offset = 2;
            for (let i = 0; i < count; i++) {
              const length = body.readInt32BE(offset);
              offset += 4;
              const field = fields[i] ?? { name: `column${i + 1}`, oid: 25 };
              if (length === -1) row[field.name] = null;
              else {
                row[field.name] = convert(body.subarray(offset, offset + length).toString("utf8"), field.oid);
                offset += length;
              }
            }
            if (rows.length < maxRows) rows.push(row);
            else truncated = true;
          } else if (type === "s") truncated = true; // PortalSuspended: more rows than requested
          else if (type === "Z") break;
        }
        if (error) throw error;
        return { columns: fields.map((f) => f.name), rows, truncated };
      } finally {
        await simple("ROLLBACK").catch(() => {});
      }
    },
    close() {
      try {
        send(message("X", []));
      } catch {}
      socket.end();
    },
  };
}

/** Tables and views of the non-system schemas, with columns and estimated row counts. @param {Awaited<ReturnType<typeof connectPostgres>>} pg */
export async function postgresTables(pg) {
  const { rows } = await pg.query(
    `SELECT c.table_schema AS schema, c.table_name AS name, c.column_name AS column, c.data_type AS type,
            COALESCE((SELECT reltuples::bigint FROM pg_class k JOIN pg_namespace n ON n.oid = k.relnamespace WHERE n.nspname = c.table_schema AND k.relname = c.table_name), 0) AS rows
       FROM information_schema.columns c
      WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema NOT LIKE 'pg_toast%'
      ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
    [],
    { maxRows: 5000 },
  );
  /** @type {Map<string, { name: string, columns: { name: string, type: string }[], rows: number }>} */ const tables = new Map();
  for (const row of rows) {
    const name = row.schema === "public" ? String(row.name) : `${row.schema}.${row.name}`;
    const table = tables.get(name) ?? { name, columns: [], rows: Math.max(Number(row.rows) || 0, 0) };
    table.columns.push({ name: String(row.column), type: String(row.type) });
    tables.set(name, table);
  }
  return [...tables.values()];
}
