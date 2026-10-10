// Minimal MySQL / MariaDB client (no dependency) for read-only queries: TLS, caching_sha2_password (fast path, full
// authentication over TLS or with the server's RSA key) and mysql_native_password, text protocol, READ ONLY transactions.
import { constants, createHash, publicEncrypt } from "node:crypto";
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

/**
 * Only reading statements reach the server: in MySQL, DDL statements commit implicitly and would escape a READ ONLY transaction.
 * @param {string} sql
 */
export function assertReadStatement(sql) {
  const first = sql.replace(/^(\s|--[^\n]*\n|#[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  if (!/^(select|with|show|explain|describe|desc|values|table)\b/i.test(first)) throw new Error("Only read statements are allowed (SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, VALUES, TABLE).");
}

/** @param {string} url */
export function isMysqlUrl(url) {
  return /^(mysql|mariadb):\/\//i.test(url);
}

const CLIENT = {
  LONG_PASSWORD: 0x1, CONNECT_WITH_DB: 0x8, PROTOCOL_41: 0x200, SSL: 0x800, TRANSACTIONS: 0x2000, SECURE_CONNECTION: 0x8000,
  MULTI_RESULTS: 0x20000, PLUGIN_AUTH: 0x80000, PLUGIN_AUTH_LENENC_DATA: 0x200000,
};

const sha1 = (/** @type {Buffer | string} */ data) => createHash("sha1").update(data).digest();
const sha256 = (/** @type {Buffer | string} */ data) => createHash("sha256").update(data).digest();
const xor = (/** @type {Buffer} */ a, /** @type {Buffer} */ b) => Buffer.from(a.map((byte, i) => byte ^ b[i % b.length]));

/** Authentication data for a plugin. @param {string} plugin @param {string} password @param {Buffer} nonce */
function scramble(plugin, password, nonce) {
  if (!password) return Buffer.alloc(0);
  if (plugin === "mysql_native_password") return xor(sha1(password), sha1(Buffer.concat([nonce, sha1(sha1(password))])));
  if (plugin === "caching_sha2_password") return xor(sha256(password), sha256(Buffer.concat([sha256(sha256(password)), nonce])));
  if (plugin === "mysql_clear_password") return Buffer.from(`${password}\0`);
  throw new Error(`Unsupported MySQL authentication plugin "${plugin}"`);
}

/** Length-encoded integer. @param {Buffer} buf @param {number} offset @returns {[number | null, number]} */
function readLenenc(buf, offset) {
  const first = buf[offset];
  if (first < 0xfb) return [first, offset + 1];
  if (first === 0xfb) return [null, offset + 1];
  if (first === 0xfc) return [buf.readUInt16LE(offset + 1), offset + 3];
  if (first === 0xfd) return [buf.readUIntLE(offset + 1, 3), offset + 4];
  return [Number(buf.readBigUInt64LE(offset + 1)), offset + 9];
}

/** @param {Buffer} body */
function mysqlError(body) {
  const code = body.readUInt16LE(1);
  const message = body.subarray(body[3] === 0x23 ? 9 : 3).toString("utf8");
  const error = new Error(`${message} (MySQL error ${code})`);
  /** @type {any} */ (error).code = code;
  return error;
}

/** Text value -> JavaScript, by column type. @param {string} text @param {{ type: number, length: number }} column */
function convert(text, column) {
  switch (column.type) {
    case 1: return column.length === 1 ? text === "1" : Number(text); // TINYINT(1) is BOOLEAN
    case 2: case 3: case 9: case 13: case 4: case 5: return Number(text);
    case 8: {
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : text;
    }
    case 0: case 246: {
      const digits = text.replace(/[-.]/g, "").replace(/^0+/, "");
      return digits.length <= 15 ? Number(text) : text;
    }
    case 245: {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    default: return text;
  }
}

/** SQL literal for a parameter (strings quoted and escaped). @param {unknown} value */
function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Parameters must be finite numbers");
    return String(value);
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/\0/g, "\\0").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\x1a/g, "\\Z")}'`;
}

/** Replaces ? placeholders outside strings, identifiers and comments. @param {string} sql @param {unknown[]} values */
export function bindParameters(sql, values) {
  let out = "";
  let index = 0;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (char === "'" || char === '"' || char === "`") {
      let j = i + 1;
      while (j < sql.length && sql[j] !== char) j += sql[j] === "\\" && char !== "`" ? 2 : 1;
      out += sql.slice(i, j + 1);
      i = j;
    } else if (char === "-" && sql[i + 1] === "-" || char === "#") {
      const end = sql.indexOf("\n", i);
      out += sql.slice(i, end === -1 ? sql.length : end);
      i = end === -1 ? sql.length : end - 1;
    } else if (char === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      out += sql.slice(i, end === -1 ? sql.length : end + 2);
      i = end === -1 ? sql.length : end + 1;
    } else if (char === "?") {
      if (index >= values.length) throw new Error(`Missing value for parameter ${index + 1}`);
      out += literal(values[index++]);
    } else out += char;
  }
  if (index < values.length) throw new Error(`${values.length} parameters given, ${index} placeholders in the query`);
  return out;
}

/**
 * @param {string} url mysql://user:password@host:port/database?ssl=prefer|require|disable|verify (mariadb:// too)
 * @param {{ timeoutMs?: number }} [options]
 */
export async function connectMysql(url, { timeoutMs = 15_000 } = {}) {
  const target = new URL(url);
  const user = decodeURIComponent(target.username || "root");
  const password = decodeURIComponent(target.password || "");
  const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
  const port = Number(target.port || 3306);
  const ssl = (target.searchParams.get("ssl") ?? target.searchParams.get("sslmode") ?? "prefer").toLowerCase();

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

  // ---------------------------------------------------------------- packets (3-byte length + sequence id)
  let buffer = Buffer.alloc(0);
  /** @type {Buffer[]} */ const queue = [];
  /** @type {(() => void) | null} */ let wake = null;
  /** @type {Error | null} */ let failure = null;
  let sequence = 0;
  const onData = (/** @type {Buffer} */ chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUIntLE(0, 3);
      if (buffer.length < length + 4) break;
      sequence = (buffer[3] + 1) & 0xff;
      queue.push(buffer.subarray(4, length + 4));
      buffer = buffer.subarray(length + 4);
    }
    wake?.();
  };
  const listen = (/** @type {import("node:net").Socket} */ s) => {
    s.on("data", onData);
    s.on("error", (error) => {
      failure = error;
      wake?.();
    });
    s.on("close", () => {
      failure ??= new Error("connection closed by the server");
      wake?.();
    });
  };
  listen(socket);
  /** @returns {Promise<Buffer>} */
  const next = async () => {
    const deadline = Date.now() + timeoutMs;
    while (!queue.length) {
      if (failure) throw failure;
      if (Date.now() > deadline) throw new Error("MySQL did not answer in time");
      await new Promise((resolve) => {
        wake = () => resolve(undefined);
        setTimeout(resolve, 200);
      });
      wake = null;
    }
    return /** @type {Buffer} */ (queue.shift());
  };
  const send = (/** @type {Buffer} */ payload) => {
    const header = Buffer.alloc(4);
    header.writeUIntLE(payload.length, 0, 3);
    header[3] = sequence;
    sequence = (sequence + 1) & 0xff;
    socket.write(Buffer.concat([header, payload]));
  };

  // ---------------------------------------------------------------- handshake
  const hello = await next();
  if (hello[0] === 0xff) throw mysqlError(hello);
  let offset = 1;
  const versionEnd = hello.indexOf(0, offset);
  const serverVersion = hello.subarray(offset, versionEnd).toString("latin1");
  offset = versionEnd + 1 + 4; // connection id
  let nonce = hello.subarray(offset, offset + 8);
  offset += 9;
  let capabilities = hello.readUInt16LE(offset);
  offset += 2 + 1 + 2;
  capabilities |= hello.readUInt16LE(offset) << 16;
  offset += 2;
  const nonceLength = hello[offset];
  offset += 11;
  if (capabilities & CLIENT.SECURE_CONNECTION) {
    const part2 = Math.max(13, nonceLength - 8);
    nonce = Buffer.concat([nonce, hello.subarray(offset, offset + part2 - 1)]);
    offset += part2;
  }
  let plugin = capabilities & CLIENT.PLUGIN_AUTH ? hello.subarray(offset, hello.indexOf(0, offset)).toString("latin1") : "mysql_native_password";

  let flags = CLIENT.LONG_PASSWORD | CLIENT.PROTOCOL_41 | CLIENT.SECURE_CONNECTION | CLIENT.TRANSACTIONS | CLIENT.MULTI_RESULTS | CLIENT.PLUGIN_AUTH | CLIENT.PLUGIN_AUTH_LENENC_DATA;
  if (database) flags |= CLIENT.CONNECT_WITH_DB;
  const fixed = (/** @type {number} */ withFlags) => {
    const b = Buffer.alloc(32);
    b.writeUInt32LE(withFlags >>> 0, 0);
    b.writeUInt32LE(16 * 1024 * 1024, 4);
    b[8] = 255; // utf8mb4
    return b;
  };
  let secure = false;
  if (ssl !== "disable" && capabilities & CLIENT.SSL) {
    flags |= CLIENT.SSL;
    send(fixed(flags)); // SSLRequest
    socket.removeListener("data", onData);
    socket = await new Promise((resolve, reject) => {
      const tls = tlsConnect({ socket, servername: /^[\d.]+$/.test(target.hostname) ? undefined : target.hostname, rejectUnauthorized: ssl === "verify" || ssl === "verify-full" || ssl === "verify_identity" });
      tls.once("secureConnect", () => resolve(tls));
      tls.once("error", (error) => reject(new Error(`TLS with ${target.hostname} failed: ${error.message}`)));
    });
    listen(socket);
    secure = true;
  } else if (ssl === "require" || ssl.startsWith("verify")) {
    socket.destroy();
    throw new Error(`${target.hostname} does not offer TLS (ssl=${ssl}).`);
  }

  const auth = scramble(plugin, password, nonce);
  send(Buffer.concat([fixed(flags), Buffer.from(`${user}\0`), Buffer.from([auth.length]), auth, ...(database ? [Buffer.from(`${database}\0`)] : []), Buffer.from(`${plugin}\0`)]));

  for (;;) {
    const packet = await next();
    if (packet[0] === 0x00) break; // OK
    if (packet[0] === 0xff) {
      socket.destroy();
      throw mysqlError(packet);
    }
    if (packet[0] === 0xfe) {
      // AuthSwitchRequest: another plugin with a fresh nonce
      const nameEnd = packet.indexOf(0, 1);
      plugin = packet.subarray(1, nameEnd).toString("latin1");
      nonce = packet.subarray(nameEnd + 1, packet.length - (packet[packet.length - 1] === 0 ? 1 : 0));
      send(scramble(plugin, password, nonce));
    } else if (packet[0] === 0x01) {
      // AuthMoreData (caching_sha2_password): 3 = fast path accepted, 4 = full authentication needed
      if (packet[1] === 0x03) continue;
      if (packet[1] === 0x04) {
        if (secure) send(Buffer.from(`${password}\0`));
        else send(Buffer.from([0x02])); // ask for the server's RSA public key
      } else {
        const key = packet.subarray(1).toString("latin1");
        const encrypted = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING }, xor(Buffer.from(`${password}\0`), nonce));
        send(encrypted);
      }
    } else throw new Error(`Unexpected MySQL authentication packet 0x${packet[0].toString(16)}`);
  }

  /** Runs one statement; returns its rows (if any). @param {string} sql @param {number} maxRows */
  const run = async (sql, maxRows = Infinity) => {
    sequence = 0;
    send(Buffer.concat([Buffer.from([0x03]), Buffer.from(sql, "utf8")]));
    const first = await next();
    if (first[0] === 0xff) throw mysqlError(first);
    if (first[0] === 0x00) return { columns: [], rows: [], truncated: false };
    const [count] = readLenenc(first, 0);
    /** @type {{ name: string, type: number, length: number }[]} */ const columns = [];
    for (let i = 0; i < Number(count); i++) {
      const def = await next();
      let at = 0;
      /** @type {string[]} */ const strings = [];
      for (let s = 0; s < 6; s++) {
        const [length, after] = readLenenc(def, at);
        strings.push(def.subarray(after, after + Number(length)).toString("utf8"));
        at = after + Number(length);
      }
      at += 1 + 2; // length of fixed fields, charset
      const length = def.readUInt32LE(at);
      const type = def[at + 4];
      columns.push({ name: strings[4], type, length });
    }
    const eof = await next(); // EOF after column definitions
    if (eof[0] === 0xff) throw mysqlError(eof);
    /** @type {Record<string, unknown>[]} */ const rows = [];
    let truncated = false;
    for (;;) {
      const row = await next();
      if (row[0] === 0xff) throw mysqlError(row);
      if (row[0] === 0xfe && row.length < 9) break;
      if (rows.length >= maxRows) {
        truncated = true;
        continue;
      }
      /** @type {Record<string, unknown>} */ const record = {};
      let at = 0;
      for (const column of columns) {
        const [length, after] = readLenenc(row, at);
        if (length === null) {
          record[column.name] = null;
          at = after;
        } else {
          record[column.name] = convert(row.subarray(after, after + length).toString("utf8"), column);
          at = after + length;
        }
      }
      rows.push(record);
    }
    return { columns: columns.map((c) => c.name), rows, truncated };
  };

  const mariadb = /mariadb/i.test(serverVersion);
  return {
    serverVersion,
    /**
     * Read-only query; "?" placeholders take values from `values`.
     * @param {string} sql @param {unknown[]} [values] @param {{ maxRows?: number, statementTimeoutMs?: number }} [options]
     */
    async query(sql, values = [], { maxRows = 200, statementTimeoutMs = 30_000 } = {}) {
      assertReadStatement(sql);
      const statement = values.length ? bindParameters(sql, values) : sql;
      const ms = Math.max(1000, Math.floor(statementTimeoutMs));
      await run(mariadb ? `SET SESSION max_statement_time = ${ms / 1000}` : `SET SESSION MAX_EXECUTION_TIME = ${ms}`);
      // The whole session is read-only too: a statement that commits implicitly cannot write either.
      await run("SET SESSION TRANSACTION READ ONLY");
      await run("START TRANSACTION READ ONLY");
      try {
        return await run(statement, maxRows);
      } finally {
        await run("ROLLBACK").catch(() => {});
      }
    },
    close() {
      try {
        sequence = 0;
        send(Buffer.from([0x01])); // COM_QUIT
      } catch {}
      socket.end();
    },
  };
}

/** Tables and views of the connection's database, with columns and estimated row counts. @param {Awaited<ReturnType<typeof connectMysql>>} db */
export async function mysqlTables(db) {
  const { rows } = await db.query(
    `SELECT c.TABLE_NAME AS name, c.COLUMN_NAME AS col, c.DATA_TYPE AS type, COALESCE(t.TABLE_ROWS, 0) AS estimate
       FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = DATABASE() ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
    [],
    { maxRows: 5000 },
  );
  /** @type {Map<string, { name: string, columns: { name: string, type: string }[], rows: number }>} */ const tables = new Map();
  for (const row of rows) {
    const table = tables.get(String(row.name)) ?? { name: String(row.name), columns: [], rows: Number(row.estimate) || 0 };
    table.columns.push({ name: String(row.col), type: String(row.type) });
    tables.set(table.name, table);
  }
  return [...tables.values()];
}
