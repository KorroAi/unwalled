import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pick } from "../../src/tools/pick.js";
import { describeShape, inferSchema } from "../../src/tools/schema.js";

describe("inferSchema", () => {
  it("merges object samples and marks common keys as required", () => {
    const schema = inferSchema([{ a: 1, b: "x" }, { a: 2.5, c: null }]);
    assert.deepEqual(schema, { type: "object", properties: { a: { type: "number" }, b: { type: "string" }, c: { type: "null" } }, required: ["a"] });
  });

  it("describes arrays and unions", () => {
    assert.deepEqual(inferSchema([[1, 2], [3]]), { type: "array", items: { type: "integer" } });
    assert.deepEqual(inferSchema(["x", 1]), { type: ["string", "integer"] });
    assert.deepEqual(inferSchema([]), {});
  });

  it("produces a compact shape", () => {
    const shape = describeShape(inferSchema([{ items: [{ id: 1, name: "a" }], total: 1 }]));
    assert.equal(shape, "{ items: { id: integer, name: string }[], total: integer }");
  });
});

describe("pick", () => {
  const data = { data: { items: [{ id: 1, name: "a" }, { id: 2, name: "b" }], total: 2 }, meta: { page: 1 } };

  it("selects nested values, indexes and wildcards", () => {
    assert.equal(pick(data, "data.total"), 2);
    assert.equal(pick(data, "data.items[1].name"), "b");
    assert.deepEqual(pick(data, "data.items[*].id"), [1, 2]);
    assert.deepEqual(pick(data, "data.items.*.name"), ["a", "b"]);
  });

  it("selects several paths at once", () => {
    assert.deepEqual(pick(data, "data.total, meta.page"), { "data.total": 2, "meta.page": 1 });
  });

  it("slices, filters and counts lists", () => {
    const shop = {
      items: [
        { id: 1, name: "Blue lamp", price: 12, status: "open", tags: ["a"], seller: { country: "FR" } },
        { id: 2, name: "Red chair", price: 40, status: "sold", tags: [] , seller: { country: "DE" } },
        { id: 3, name: "Lamp shade", price: 8, status: "open", seller: { country: "FR" } },
      ],
    };
    assert.deepEqual(pick(shop, "items[0:2].id"), [1, 2]);
    assert.deepEqual(pick(shop, "items[-1:].id"), [3]);
    assert.deepEqual(pick(shop, "items[?price>10].id"), [1, 2]);
    assert.deepEqual(pick(shop, "items[?price<=12][?status=open].name"), ["Blue lamp", "Lamp shade"]);
    assert.deepEqual(pick(shop, "items[?name~lamp].id"), [1, 3]);
    assert.deepEqual(pick(shop, "items[?seller.country!=FR].id"), [2]);
    assert.deepEqual(pick(shop, "items[?tags].id"), [1, 2]);
    assert.equal(pick(shop, "items.#"), 3);
    assert.deepEqual(pick(shop, "items[?price>10].id, items.#"), { "items[?price>10].id": [1, 2], "items.#": 3 });
  });

  it("returns undefined when nothing matches and rejects bad paths", () => {
    assert.equal(pick(data, "nope.x"), undefined);
    assert.throws(() => pick(data, "a..b"), /Invalid pick path/);
  });
});
