// Schema-less decoding of protobuf payloads (and gRPC-web framing) into readable JSON keyed by field number.
// Without the .proto file, names and exact types are unknown: length-delimited fields are shown as a nested message
// when they parse as one, otherwise as text (when printable) or base64.

const MAX_DEPTH = 12;
const SCHEMALESS = "decoded without the .proto schema: keys are field numbers and types are guessed (varint shown as unsigned, bytes as text when printable)";
const MAX_FIELDS = 5000;

/** @param {Buffer} buf @param {number} offset @returns {[bigint, number] | null} value and new offset */
function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  for (let i = offset; i < buf.length && i < offset + 10; i++) {
    const byte = buf[i];
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [result, i + 1];
    shift += 7n;
  }
  return null;
}

/** @param {bigint} value */
const toNumber = (value) => (value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString());

/** @param {Buffer} bytes */
function isPrintable(bytes) {
  if (!bytes.length) return true;
  const text = bytes.toString("utf8");
  if (text.includes("�")) return false;
  let control = 0;
  for (const char of text) if (char < " " && !"\n\r\t".includes(char)) control++;
  return control === 0;
}

/**
 * @param {Buffer} buf
 * @returns {Record<string, unknown> | null} null when the bytes are not a well-formed message
 */
export function decodeMessage(buf, depth = 0, budget = { fields: 0 }) {
  if (depth > MAX_DEPTH) return null;
  /** @type {Record<string, unknown[]>} */ const fields = {};
  let offset = 0;
  while (offset < buf.length) {
    if (++budget.fields > MAX_FIELDS) return null;
    const key = readVarint(buf, offset);
    if (!key) return null;
    const [tag, next] = key;
    const field = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (field < 1 || field > 536_870_911) return null;
    offset = next;
    /** @type {unknown} */ let value;
    if (wireType === 0) {
      const varint = readVarint(buf, offset);
      if (!varint) return null;
      value = toNumber(varint[0]);
      offset = varint[1];
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) return null;
      const double = buf.readDoubleLE(offset);
      value = Number.isFinite(double) && Math.abs(double) > 1e-300 && Math.abs(double) < 1e300 ? double : toNumber(buf.readBigUInt64LE(offset));
      offset += 8;
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) return null;
      const float = buf.readFloatLE(offset);
      value = Number.isFinite(float) && Math.abs(float) > 1e-30 && Math.abs(float) < 1e30 && Math.round(float * 1e4) / 1e4 !== 0 ? Math.round(float * 1e6) / 1e6 : buf.readUInt32LE(offset);
      offset += 4;
    } else if (wireType === 2) {
      const length = readVarint(buf, offset);
      if (!length) return null;
      const size = Number(length[0]);
      offset = length[1];
      if (offset + size > buf.length) return null;
      const bytes = buf.subarray(offset, offset + size);
      offset += size;
      const nested = size ? decodeMessage(bytes, depth + 1, budget) : null;
      // Short printable byte runs are far more likely to be text than a nested message.
      if (isPrintable(bytes) && (!nested || size < 4 || /^[\x20-\x7e\s]+$/.test(bytes.toString("utf8")))) value = bytes.toString("utf8");
      else value = nested ?? `base64:${bytes.toString("base64")}`;
    } else return null; // groups (3, 4) are obsolete; other values mean this is not protobuf
    (fields[field] ??= []).push(value);
  }
  return Object.fromEntries(Object.entries(fields).map(([field, values]) => [field, values.length === 1 ? values[0] : values]));
}

/**
 * Splits a gRPC-web body into its data messages and trailers.
 * @param {Buffer} body @param {string} contentType
 */
export function decodeGrpcWeb(body, contentType) {
  const bytes = /grpc-web-text/i.test(contentType) ? Buffer.from(body.toString("latin1").replace(/\s+/g, ""), "base64") : body;
  const messages = [];
  /** @type {Record<string, string>} */ const trailers = {};
  let offset = 0;
  while (offset + 5 <= bytes.length) {
    const flag = bytes[offset];
    const length = bytes.readUInt32BE(offset + 1);
    const frame = bytes.subarray(offset + 5, offset + 5 + length);
    offset += 5 + length;
    if (flag & 0x80) {
      for (const line of frame.toString("utf8").split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon > 0) trailers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
    } else messages.push(decodeMessage(frame) ?? `base64:${frame.toString("base64")}`);
  }
  return { messages, trailers };
}

/**
 * Readable text for a binary protobuf / gRPC-web response, or undefined when the content type is not one of them.
 * @param {Buffer} body @param {string} contentType
 */
export function describeProtobuf(body, contentType) {
  if (/grpc-web/i.test(contentType) || /application\/grpc/i.test(contentType)) {
    const { messages, trailers } = decodeGrpcWeb(body, contentType);
    return JSON.stringify({ grpc: { messages, ...(Object.keys(trailers).length ? { trailers } : {}) }, note: SCHEMALESS });
  }
  if (/protobuf|x-protobuf|vnd\.google\.protobuf/i.test(contentType)) {
    const message = decodeMessage(body);
    return message ? JSON.stringify({ protobuf: message, note: SCHEMALESS }) : undefined;
  }
  return undefined;
}
