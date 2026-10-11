import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isODataMetadata, odataToOpenApi } from "../../src/discovery/odata.js";
import { normalizeOpenApi } from "../../src/discovery/openapi.js";

const METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Shop" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key><PropertyRef Name="ID"/></Key>
        <Property Name="ID" Type="Edm.Int32" Nullable="false"/>
        <Property Name="Name" Type="Edm.String"/>
        <Property Name="Price" Type="Edm.Decimal"/>
      </EntityType>
      <EntityType Name="Customer">
        <Key><PropertyRef Name="Code"/></Key>
        <Property Name="Code" Type="Edm.String" Nullable="false"/>
        <Property Name="Tags" Type="Collection(Edm.String)"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Products" EntityType="Shop.Product"/>
        <EntitySet Name="Customers" EntityType="Shop.Customer"/>
        <FunctionImport Name="TopProducts" Function="Shop.TopProducts"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe("OData $metadata", () => {
  it("is recognised and turned into CRUD operations with quoted string keys", () => {
    assert.equal(isODataMetadata(METADATA), true);
    assert.equal(isODataMetadata('{"openapi":"3.0.0"}'), false);
    const spec = odataToOpenApi(METADATA, "https://shop.example.com/odata/");
    const { baseUrl, operations } = normalizeOpenApi(spec, "https://shop.example.com/odata/$metadata", { maxTools: 100 });
    assert.equal(baseUrl, "https://shop.example.com/odata");
    assert.deepEqual(operations.map((o) => `${o.method} ${o.path}`), [
      "GET /Products", "POST /Products", "GET /Products({ID})", "PATCH /Products({ID})", "DELETE /Products({ID})",
      "GET /Customers", "POST /Customers", "GET /Customers('{Code}')", "PATCH /Customers('{Code}')", "DELETE /Customers('{Code}')",
      "GET /TopProducts",
    ]);
    const list = /** @type {any} */ (operations.find((o) => o.id === "list_products"));
    assert.ok(list.params.some((p) => p.name === "$filter") && list.params.some((p) => p.name === "$count"));
    assert.equal(/** @type {any} */ (operations.find((o) => o.id === "create_customers")).body.schema.properties.Tags.type, "array");
  });

  it("writes 64-bit keys bare, v2 GUID keys as guid'...', and gives actions a body", () => {
    const v2 = `<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"><edmx:DataServices><Schema Namespace="S">
      <EntityType Name="Order"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.Int64"/></EntityType>
      <EntityType Name="Doc"><Key><PropertyRef Name="Uid"/></Key><Property Name="Uid" Type="Edm.Guid"/></EntityType>
      <EntityContainer Name="C"><EntitySet Name="Orders" EntityType="S.Order"/><EntitySet Name="Docs" EntityType="S.Doc"/>
      <FunctionImport Name="Approve" m:HttpMethod="POST" xmlns:m="x"><Parameter Name="Id" Type="Edm.Int64"/></FunctionImport></EntityContainer>
    </Schema></edmx:DataServices></edmx:Edmx>`;
    const spec = odataToOpenApi(v2, "https://erp.test/odata");
    assert.ok(spec.paths["/Orders({Id})"], Object.keys(spec.paths).join(", "));
    assert.ok(spec.paths["/Docs(guid'{Uid}')"]);
    assert.deepEqual(Object.keys(spec.paths["/Approve"].post.requestBody.content["application/json"].schema.properties), ["Id"]);
  });
});
