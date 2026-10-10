import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isWsdl, parseWsdl, soapEnvelope } from "../../src/discovery/soap.js";

const wsdl = (endpoint) => `<?xml version="1.0" encoding="utf-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:s="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:quotes" targetNamespace="urn:quotes" name="Quotes">
  <wsdl:types>
    <s:schema targetNamespace="urn:quotes" elementFormDefault="qualified">
      <s:element name="GetQuote"><s:complexType><s:sequence>
        <s:element name="symbol" type="s:string"/><s:element name="currencies" type="s:string" maxOccurs="unbounded"/>
      </s:sequence></s:complexType></s:element>
      <s:element name="GetQuoteResponse"><s:complexType><s:sequence><s:element name="price" type="s:decimal"/></s:sequence></s:complexType></s:element>
    </s:schema>
  </wsdl:types>
  <wsdl:message name="GetQuoteIn"><wsdl:part name="parameters" element="tns:GetQuote"/></wsdl:message>
  <wsdl:message name="GetQuoteOut"><wsdl:part name="parameters" element="tns:GetQuoteResponse"/></wsdl:message>
  <wsdl:portType name="QuotesPort">
    <wsdl:operation name="GetQuote"><wsdl:documentation>Latest price of a symbol.</wsdl:documentation>
      <wsdl:input message="tns:GetQuoteIn"/><wsdl:output message="tns:GetQuoteOut"/></wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="QuotesBinding" type="tns:QuotesPort">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
    <wsdl:operation name="GetQuote"><soap:operation soapAction="urn:quotes/GetQuote"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input><wsdl:output><soap:body use="literal"/></wsdl:output></wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="Quotes"><wsdl:port name="QuotesSoap" binding="tns:QuotesBinding"><soap:address location="${endpoint}"/></wsdl:port></wsdl:service>
</wsdl:definitions>`;

describe("WSDL", () => {
  it("is parsed into operations with typed parameters", () => {
    const text = wsdl("http://localhost/quotes.asmx");
    assert.equal(isWsdl(text), true);
    const parsed = parseWsdl(text, "http://localhost/quotes.asmx?wsdl");
    assert.equal(parsed.endpoint, "http://localhost/quotes.asmx");
    assert.equal(parsed.version, "1.1");
    const [op] = parsed.operations;
    assert.deepEqual({ name: op.name, soapAction: op.soapAction, element: op.element, namespace: op.namespace }, { name: "GetQuote", soapAction: "urn:quotes/GetQuote", element: "GetQuote", namespace: "urn:quotes" });
    assert.deepEqual(op.paramsSchema, { type: "object", properties: { symbol: { type: "string" }, currencies: { type: "array", items: { type: "string" } } } });
    assert.equal(op.documentation, "Latest price of a symbol.");
    assert.match(soapEnvelope(op, "1.1", { symbol: "A&B", currencies: ["EUR", "USD"] }), /<GetQuote xmlns="urn:quotes"><symbol>A&amp;B<\/symbol><currencies>EUR<\/currencies><currencies>USD<\/currencies><\/GetQuote>/);
  });
});

describe("SOAP tools", () => {
  let server, base, home, engine;
  const received = [];
  before(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/quotes.asmx" && url.search === "?wsdl") {
        res.writeHead(200, { "content-type": "text/xml" });
        return res.end(wsdl(`${base}/quotes.asmx`));
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ action: req.headers.soapaction, body });
      const symbol = /<symbol>([^<]*)<\/symbol>/.exec(body)?.[1];
      res.writeHead(symbol === "BTC" ? 200 : 500, { "content-type": "text/xml; charset=utf-8" });
      res.end(
        symbol === "BTC"
          ? '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetQuoteResponse xmlns="urn:quotes"><price>60000.5</price></GetQuoteResponse></soap:Body></soap:Envelope>'
          : '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Client</faultcode><faultstring>Unknown symbol</faultstring></soap:Fault></soap:Body></soap:Envelope>',
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
    home = mkdtempSync(join(tmpdir(), "umcp-soap-"));
    process.env.UNIVERSAL_MCP_HOME = home;
    const { loadConfig } = await import("../../src/config.js");
    const { Engine } = await import("../../src/core.js");
    engine = new Engine(loadConfig());
  });
  after(async () => {
    await engine?.close();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    rmSync(home, { recursive: true, force: true });
  });

  it("finds the WSDL from the endpoint, calls operations and reports faults", async () => {
    const recipe = await engine.discover({ name: "quotes", url: `${base}/quotes.asmx`, mode: "openapi" });
    assert.equal(recipe.kind, "soap");
    const tool = engine.tools.get("quotes__GetQuote");
    const ok = await tool.run({ params: { symbol: "BTC" }, pick: "GetQuoteResponse.price" });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(ok.text.split("\n")[1], '"60000.5"');
    assert.equal(received.at(-1).action, '"urn:quotes/GetQuote"');
    const fault = await tool.run({ params: { symbol: "NOPE" } });
    assert.equal(fault.isError, true);
    assert.match(fault.text, /Unknown symbol/);
  });
});
