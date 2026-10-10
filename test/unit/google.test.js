import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoveryToOpenApi, isGoogleDiscovery } from "../../src/discovery/google.js";
import { normalizeOpenApi } from "../../src/discovery/openapi.js";

const DOC = {
  kind: "discovery#restDescription",
  title: "Example Data API",
  rootUrl: "https://example.googleapis.com/",
  servicePath: "",
  schemas: {
    Video: { id: "Video", type: "object", properties: { id: { type: "string" }, snippet: { $ref: "Snippet" }, extra: { type: "any" } } },
    Snippet: { id: "Snippet", type: "object", properties: { title: { type: "string" } } },
  },
  resources: {
    videos: {
      methods: {
        list: {
          id: "example.videos.list", path: "example/v1/videos", httpMethod: "GET", description: "Lists videos.\nMore text.",
          parameters: {
            part: { type: "string", location: "query", required: true, repeated: true },
            order: { type: "string", location: "query", enum: ["date", "rating"], enumDescriptions: ["Newest first", "Best first"] },
          },
          response: { $ref: "Video" },
        },
        update: { id: "example.videos.update", path: "example/v1/videos", httpMethod: "PUT", request: { $ref: "Video" }, parameters: {} },
      },
      resources: {
        ratings: { methods: { get: { id: "example.videos.ratings.get", path: "example/v1/{+name}", httpMethod: "GET", parameters: { name: { type: "string", location: "path", required: true } } } } },
      },
    },
  },
};

describe("Google Discovery documents", () => {
  it("are recognised and converted to OpenAPI operations", () => {
    assert.equal(isGoogleDiscovery(DOC), true);
    assert.equal(isGoogleDiscovery({ openapi: "3.0.0", paths: {} }), false);
    const spec = discoveryToOpenApi(DOC);
    const { baseUrl, title, operations } = normalizeOpenApi(spec, "https://www.googleapis.com/discovery/v1/apis/example/v1/rest");
    assert.equal(baseUrl, "https://example.googleapis.com");
    assert.equal(title, "Example Data API");
    assert.deepEqual(operations.map((o) => `${o.method} ${o.path} ${o.id}`), [
      "GET /example/v1/videos example_videos_list",
      "PUT /example/v1/videos example_videos_update",
      "GET /example/v1/{name} example_videos_ratings_get",
    ]);
    const list = operations[0];
    assert.deepEqual(list.params.find((p) => p.name === "part"), { name: "part", in: "query", required: true, schema: { type: "array", items: { type: "string" } }, description: "" });
    assert.match(/** @type {any} */ (list.params.find((p) => p.name === "order")).schema.description, /date: Newest first/);
    assert.equal(/** @type {any} */ (operations[1]).body.schema.properties.snippet.properties.title.type, "string");
    assert.deepEqual(operations[2].params.map((p) => [p.name, p.in, p.required]), [["name", "path", true]]);
  });
});
