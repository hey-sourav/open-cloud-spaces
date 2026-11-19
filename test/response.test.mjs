import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import axios from "axios";
import { OpenCloudSpaces } from "open-cloud-spaces";

function client() {
  return new OpenCloudSpaces({ base_url: "https://example.invalid", user: "admin", token: "test", space: "space" });
}

async function body(data, contentType = "") {
  const spaces = client();
  spaces.client.defaults.adapter = async (config) => ({ config, status: 207, statusText: "Multi-Status", headers: { "Content-Type": contentType }, data });
  const response = await spaces.client.request({ method: "PROPFIND", url: "/metadata" });
  assert.equal(response.status, 207);
  assert.equal(typeof response.data, "object");
  assert.notEqual(response.data, null);
  assert.ok(!Buffer.isBuffer(response.data));
  assert.doesNotThrow(() => JSON.stringify(response.data));
  return response.data;
}

const jsonCases = [
  ["empty string", "", {}],
  ["empty buffer", Buffer.alloc(0), {}],
  ["absent body", undefined, {}],
  ["whitespace", " \r\n\t", {}],
  ["JSON null", Buffer.from("null"), { value: null }],
  ["false", Buffer.from("false"), { value: false }],
  ["zero", Buffer.from("0"), { value: 0 }],
  ["negative number", "-12.5", { value: -12.5 }],
  ["quoted string", '" hello "', { value: " hello " }],
  ["empty JSON object", "{}", {}],
  ["empty JSON array", "[]", []],
  ["nested JSON", '{"newField":{"items":[null,false,0,"001"]}}', { newField: { items: [null, false, 0, "001"] } }],
  ["UTF-8 BOM", Buffer.concat([Buffer.from([239,187,191]), Buffer.from('{"ok":true}')]), { ok: true }],
  ["already parsed object", { ok: true }, { ok: true }],
  ["already parsed primitives", false, { value: false }],
  ["XML-labelled JSON", Buffer.from('{"ok":true}'), { ok: true }, "application/xml"],
  ["plain text", Buffer.from("not a schema"), { content: "not a schema" }],
  ["custom JSON media type", '{"ok":true}', { ok: true }, "application/problem+json; charset=utf-8"],
];
for (const [name, input, expected, type = ""] of jsonCases) {
  test(`response format: ${name}`, async () => assert.deepEqual(await body(input, type), expected));
}

const xmlCases = [
  ["single WebDAV entry", '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat/></d:response></d:multistatus>', (v) => assert.equal(v["d:multistatus"]["d:response"][0]["d:propstat"].length, 1)],
  ["changed namespace prefix", '<X:multistatus xmlns:X="DAV:"><X:response/></X:multistatus>', (v) => assert.equal(v["X:multistatus"]["X:response"].length, 1)],
  ["default namespace", '<multistatus xmlns="DAV:"><response/></multistatus>', (v) => assert.equal(v.multistatus.response.length, 1)],
  ["empty collection", '<d:multistatus xmlns:d="DAV:"/>', (v) => assert.equal(v["d:multistatus"]["@_xmlns:d"], "DAV:")],
  ["unknown added elements", '<new-root><unexpected attr="001"><flag>false</flag></unexpected></new-root>', (v) => assert.deepEqual(v["new-root"].unexpected, { flag: "false", "@_attr": "001" })],
  ["same local name different namespaces", '<root xmlns:a="a" xmlns:b="b"><a:id>1</a:id><b:id>2</b:id></root>', (v) => assert.equal(v.root["a:id"] + v.root["b:id"], "12")],
  ["attribute named response", '<root response="value"><response/></root>', (v) => assert.equal(v.root["@_response"], "value")],
  ["repeated arbitrary tags", '<root><item>one</item><item>two</item></root>', (v) => assert.deepEqual(v.root.item, ["one", "two"])],
  ["large identifiers and booleans", '<root id="001"><n>90071992547409930000</n><b>true</b></root>', (v) => assert.deepEqual(v.root, { n: "90071992547409930000", b: "true", "@_id": "001" })],
  ["leading comment and Unicode names", '<!-- header --><étiquette réponse="oui">héllo</étiquette>', (v) => assert.equal(v["étiquette"]["#text"], "héllo")],
  ["processing instructions", '<?xml version="1.0"?><?server test?><root>ok</root>', (v) => assert.deepEqual(v, { root: "ok" })],
  ["CDATA with declaration text", '<root><![CDATA[<!DOCTYPE harmless>]]></root>', (v) => assert.equal(v.root, "<!DOCTYPE harmless>")],
  ["CDATA preserves literal entities", '<root><![CDATA[&amp; &#65;]]></root>', (v) => assert.equal(v.root, "&amp; &#65;")],
  ["comments containing declaration text", '<!-- <!DOCTYPE harmless> --><root/>', (v) => assert.deepEqual(v, { root: "" })],
  ["standard and numeric entities", '<root>&amp;&#65;&#x1F600;</root>', (v) => assert.equal(v.root, "&A😀")],
  ["unknown entity remains literal", '<root>&unknown;</root>', (v) => assert.equal(v.root, "&unknown;")],
  ["XML with JSON content type", '<root>ok</root>', (v) => assert.deepEqual(v, { root: "ok" }), "application/json"],
  ["XML with incorrect HTML content type", '<root>ok</root>', (v) => assert.deepEqual(v, { root: "ok" }), "text/html"],
  ["quoted greater-than sign", '<root value="a>b"><child>ok</child></root>', (v) => assert.equal(v.root["@_value"], "a>b")],
  ["mixed content keeps ordering", '<root>before<child>x</child>after<![CDATA[<tag>]]></root>', (v) => assert.deepEqual(v.xml[0].root, [{ "#text": "before" }, { child: [{ "#text": "x" }] }, { "#text": "after" }, { "#text": "<tag>" }])],
  ["xml:space preserves interleaved whitespace", '<root xml:space="preserve"><a/> <b/></root>', (v) => assert.deepEqual(v.xml[0].root, [{ a: [] }, { "#text": " " }, { b: [] }])],
  ["JSON brackets inside XML are not JSON nesting", '<root>' + '['.repeat(200) + '</root>', (v) => assert.equal(v.root, '['.repeat(200))],
  ["attribute text cannot enable xml:space", '<root hint="xml:space=\'preserve\'"><a/> <b/></root>', (v) => { assert.equal(v.xml, undefined); assert.equal(v.root["@_hint"], "xml:space='preserve'"); }],
];
for (const [name, input, check, type = "application/xml"] of xmlCases) {
  test(`XML structure: ${name}`, async () => check(await body(Buffer.from(input), type)));
}

const badXml = [
  '<root><broken></root>', '<root/><other/>', '<root a="1" a="2"/>',
  '<root>', '<!-- unfinished', '<root><![CDATA[unfinished</root>',
  '<root>bad ]]> text</root>', '<root value="a<b"/>',
  '<root><!-- bad -- comment --></root>',
  '<!DOCTYPE root SYSTEM "file:///etc/passwd"><root/>',
  '<!DOCTYPE root [<!ENTITY nested "value">]><root>&nested;</root>',
  '<root><__proto__><polluted>true</polluted></__proto__></root>',
  '<root>&#0;</root>',
];
for (const input of badXml) {
  test(`invalid XML retains raw body: ${input.slice(0, 45)}`, async () => {
    const value = await body(Buffer.from(input), "application/xml");
    assert.equal(value.format, "xml");
    assert.equal(value.content, input);
    assert.equal(typeof value.parseError, "string");
    assert.equal({}.polluted, undefined);
  });
}

for (const [name, input, type] of [
  ["truncated JSON", '{"items":[1,', "application/json"],
  ["JSON syntax in missing content type", '{"broken":', ""],
  ["unsafe JSON integer", '{"id":9007199254740993}', "application/json"],
  ["non-finite JSON number", '{"value":1e400}', "application/json"],
  ["deep JSON", '['.repeat(129) + '0' + ']'.repeat(129), "application/json"],
  ["deep XML", '<node>'.repeat(129) + '</node>'.repeat(129), "application/xml"],
  ["too many XML nodes", '<root>' + '<item/>'.repeat(100001) + '</root>', "application/xml"],
  ["too many JSON nodes", JSON.stringify(Array(100001).fill(0)), "application/json"],
]) {
  test(`bounded fallback: ${name}`, async () => {
    const value = await body(input, type);
    assert.equal(value.content, input);
    assert.equal(typeof value.parseError, "string");
  });
}

test("oversized bodies preserve data without structured parsing", async () => {
  const input = '<root>' + 'x'.repeat(8 * 1024 * 1024) + '</root>';
  const value = await body(input, "application/xml");
  assert.equal(value.content, input);
  assert.match(value.parseError, /8 MiB/);
  const bytes = Buffer.from(input);
  const buffered = await body(bytes, "application/xml");
  assert.equal(buffered.encoding, "base64");
  assert.deepEqual(Buffer.from(buffered.content, "base64"), bytes);
});

test("UTF-16 BOM, XML declarations, typed-array slices and header charsets decode correctly", async () => {
  const xml = '<root>नमस्ते</root>';
  const utf8 = Buffer.concat([Buffer.from([239,187,191]), Buffer.from(xml)]);
  assert.equal((await body(utf8, 'application/xml; charset=windows-1252')).root, 'नमस्ते');
  const bytes = Buffer.concat([Buffer.from([255,254]), Buffer.from(xml, 'utf16le')]);
  assert.equal((await body(bytes, 'application/xml')).root, 'नमस्ते');
  const bigEndian = Buffer.from(bytes).swap16();
  assert.equal((await body(bigEndian, 'application/xml')).root, 'नमस्ते');
  const latin = Buffer.from('<root>café</root>', 'latin1');
  assert.equal((await body(latin, 'application/xml; charset="windows-1252"')).root, 'café');
  const declared = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><root>café</root>', 'latin1');
  assert.equal((await body(declared, 'application/xml')).root, 'café');
  const surrounded = Buffer.from('xx{"ok":true}yy');
  const slice = new Uint8Array(surrounded.buffer, surrounded.byteOffset + 2, surrounded.length - 4);
  assert.deepEqual(await body(slice), { ok: true });
  assert.deepEqual(await body(Uint8Array.from(Buffer.from('{"ok":true}')).buffer), { ok: true });
});

test("undecodable non-file bytes and unknown charsets retain exact bytes as base64", async () => {
  for (const [input, type] of [[Buffer.from([255, 254, 255]), 'application/xml'], [Buffer.from('hello'), 'text/plain; charset=made-up']]) {
    const result = await body(input, type);
    assert.equal(result.encoding, 'base64');
    assert.deepEqual(Buffer.from(result.content, 'base64'), input);
    assert.equal(typeof result.parseError, 'string');
  }
});

test("HTML gateway errors are JSON envelopes rather than broken XML conversions", async () => {
  const html = '<!DOCTYPE html><html><body>Bad Gateway<br></body></html>';
  assert.deepEqual(await body(html, 'text/html'), { content: html, format: 'html' });
});

test("object inputs cannot execute getters or break JSON serialization", async () => {
  let invoked = false;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { invoked = true; throw new Error('do not call'); } });
  const circular = {}; circular.self = circular;
  for (const input of [getter, circular, { value: 1n }, { value: Infinity }, new Date(), new Array(100001)]) {
    const result = await body(input);
    assert.equal(typeof result.parseError, 'string');
  }
  assert.equal(invoked, false);
  const dangerous = await body('{"__proto__":{"polluted":true},"constructor":"data"}');
  assert.equal(Object.hasOwn(dangerous, '__proto__'), true);
  assert.equal(dangerous.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);
});

test("HTTP error identity, status, headers and request survive malformed error bodies", async () => {
  for (const input of ['<broken>', Buffer.from('<broken>'), Buffer.from([255])]) {
    const spaces = client();
    let original;
    spaces.client.defaults.adapter = async (config) => {
      const response = { config, status: 503, statusText: 'Unavailable', headers: { 'Content-Type': 'application/xml', 'retry-after': '30' }, data: input };
      original = new axios.AxiosError('Unavailable', 'ERR_BAD_RESPONSE', config, { marker: true }, response);
      throw original;
    };
    await assert.rejects(spaces.client.request({ method: 'GET', url: '/download' }), (error) => {
      assert.strictEqual(error, original);
      assert.equal(error.response.status, 503);
      assert.equal(error.response.headers['retry-after'], '30');
      assert.equal(error.request.marker, true);
      assert.equal(typeof error.response.data.parseError, 'string');
      return true;
    });
  }
});

test("network errors, timeouts and cancellations remain the original errors", async () => {
  for (const error of [new axios.AxiosError('Network error', 'ECONNREFUSED'), new axios.AxiosError('Timeout', 'ECONNABORTED'), new axios.CanceledError('Canceled')]) {
    const spaces = client();
    spaces.client.defaults.adapter = async () => { throw error; };
    await assert.rejects(spaces.client.request({ method: 'PROPFIND', url: '/metadata' }), (received) => received === error && received.response === undefined);
  }
});

test("file reads bypass normalization regardless of bytes, size or media type", async () => {
  for (const input of [Buffer.alloc(0), Buffer.from([255,0,254]), Buffer.from('<broken>'), Buffer.from('null'), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
    const spaces = client();
    spaces.client.defaults.adapter = async (config) => ({ config, status: 200, headers: { 'content-type': 'application/xml' }, data: input });
    assert.strictEqual(await spaces.file.read('folder/file'), input);
  }
});

test("concurrent responses do not share parser state", async () => {
  const values = await Promise.all(Array.from({ length: 40 }, (_, index) => body(`<root><id>${index}</id></root>`, 'application/xml')));
  assert.deepEqual(values.map((v) => v.root.id), Array.from({ length: 40 }, (_, i) => String(i)));
});

test("deterministic malformed-body variations never throw or return non-JSON data", async () => {
  let seed = 713;
  const alphabet = '<>/!?[]{}"\'&:;= abc012\n';
  for (let index = 0; index < 300; index++) {
    let text = '';
    for (let length = 0; length < 100; length++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += alphabet[seed % alphabet.length];
    }
    await body(text, index % 2 ? 'application/xml' : 'application/json');
  }
});

test("CommonJS builds perform validation and numeric entity decoding", async () => {
  const require = createRequire(import.meta.url);
  const spaces = new (require('open-cloud-spaces').OpenCloudSpaces)({ base_url: 'https://example.invalid', user: 'a', token: 't', space: 's' });
  spaces.client.defaults.adapter = async (config) => ({ config, status: 207, headers: {}, data: Buffer.from('<root>&#65;&#x1F600;</root>') });
  assert.deepEqual((await spaces.client.request({ method: 'PROPFIND', url: '/metadata' })).data, { root: 'A😀' });
});
