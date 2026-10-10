import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatResponse } from "../../src/tools/http.js";
import { decodeGrpcWeb, decodeMessage } from "../../src/tools/protobuf.js";

/** @param {number | bigint} value */
function varint(value) {
  let v = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    bytes.push(byte);
  } while (v);
  return Buffer.from(bytes);
}
const key = (field, wire) => varint((field << 3) | wire);
const str = (field, value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return Buffer.concat([key(field, 2), varint(bytes.length), bytes]);
};
const num = (field, value) => Buffer.concat([key(field, 0), varint(value)]);
const fixed32 = (field, value) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(value);
  return Buffer.concat([key(field, 5), b]);
};
const fixed64 = (field, value) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(value);
  return Buffer.concat([key(field, 1), b]);
};

const MESSAGE = Buffer.concat([
  str(1, "hello world"),
  num(2, 150),
  str(3, Buffer.concat([num(1, 42), str(2, "inner text")])),
  num(4, 1),
  num(4, 2),
  fixed32(5, 1.5),
  fixed64(6, 2.25),
  num(7, 2n ** 60n),
]);
const EXPECTED = { 1: "hello world", 2: 150, 3: { 1: 42, 2: "inner text" }, 4: [1, 2], 5: 1.5, 6: 2.25, 7: "1152921504606846976" };

/** @param {Buffer} message */
function grpcFrames(message) {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(message.length, 1);
  const trailer = Buffer.from("grpc-status:0\r\ngrpc-message:OK\r\n");
  const trailerHeader = Buffer.from([0x80, 0, 0, 0, 0]);
  trailerHeader.writeUInt32BE(trailer.length, 1);
  return Buffer.concat([header, message, trailerHeader, trailer]);
}

describe("protobuf decoding", () => {
  it("decodes a message without schema", () => {
    assert.deepEqual(decodeMessage(MESSAGE), EXPECTED);
  });

  it("rejects bytes that are not protobuf", () => {
    assert.equal(decodeMessage(Buffer.from([0x0a, 0x50, 0x01])), null); // length beyond the end
    assert.equal(decodeMessage(Buffer.from([0x07])), null); // field 0
  });

  it("splits gRPC-web frames and trailers, binary and text", () => {
    const body = grpcFrames(MESSAGE);
    assert.deepEqual(decodeGrpcWeb(body, "application/grpc-web+proto"), { messages: [EXPECTED], trailers: { "grpc-status": "0", "grpc-message": "OK" } });
    assert.deepEqual(decodeGrpcWeb(Buffer.from(body.toString("base64")), "application/grpc-web-text").messages, [EXPECTED]);
  });

  it("shows decoded bodies in tool results, with pick", () => {
    const result = { status: 200, statusText: "OK", contentType: "application/grpc-web+proto", body: grpcFrames(MESSAGE), finalUrl: "https://x.io/svc.Prices/Get" };
    const text = formatResponse(result, { maxChars: 10_000 }).text;
    assert.match(text, /"grpc":\{"messages":\[\{"1":"hello world"/);
    assert.equal(formatResponse(result, { pick: "grpc.messages[0].3.2", maxChars: 10_000 }).text.split("\n")[1], '"inner text"');
    const raw = formatResponse({ ...result, contentType: "application/x-protobuf", body: MESSAGE }, { maxChars: 10_000 }).text;
    assert.match(raw, /"protobuf":\{"1":"hello world","2":150/);
    assert.match(raw, /"note":"decoded without the .proto schema/);
    const binary = formatResponse({ ...result, contentType: "image/png", body: Buffer.from([1, 2, 3]) }, { maxChars: 10_000 }).text;
    assert.match(binary, /binary body: 3 bytes/);
  });
});
