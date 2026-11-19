import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import axios from "axios";
import { OpenCloudSpaces, OpenCloudError } from "open-cloud-spaces";

function client() {
  return new OpenCloudSpaces({ base_url: "https://example.invalid", user: "admin", token: "test-token", space: "space$root" });
}

test("ESM and CommonJS consumers can construct the client", () => {
  const require = createRequire(import.meta.url);
  assert.ok(new (require("open-cloud-spaces").OpenCloudSpaces)({ base_url: "https://example.invalid", user: "admin", token: "test-token", space: "space" }).folder);
  assert.ok(client().file);
});

test("all nine API methods use the correct method, path, authentication and headers", async () => {
  const spaces = client();
  const calls = [];
  spaces.client.defaults.adapter = async (config) => {
    calls.push(config);
    const status = { propfind: 207, mkcol: 201, put: 201, get: 200, move: 201, delete: 204 }[config.method];
    return { config, status, statusText: String(status), headers: {}, data: config.method === "get" ? Buffer.from("hello") : "" };
  };
  const folder = "parent/नमस्ते #100%";
  const file = "hello #%.txt";
  const renamed = "new #%.txt";
  const root = "/dav/spaces/space%24root/parent/" + encodeURIComponent("नमस्ते #100%");
  const filePath = root + "/" + encodeURIComponent(file);
  await spaces.folder.exists(folder);
  await spaces.folder.create(folder);
  await spaces.folder.rename(folder, "new #folder");
  await spaces.folder.delete(folder);
  await spaces.file.exists(`${folder}/${file}`);
  await spaces.file.upload({ folderName: folder, fileName: file, fileContent: Buffer.from("hello") });
  assert.deepEqual(await spaces.file.read(`${folder}/${file}`), Buffer.from("hello"));
  await spaces.file.rename(`${folder}/${file}`, renamed);
  await spaces.file.delete(`${folder}/${file}`);
  assert.deepEqual(calls.map(({ method, url }) => [method, url]), [
    ["propfind", root], ["mkcol", root], ["move", root], ["delete", root],
    ["propfind", filePath], ["put", filePath], ["get", filePath], ["move", filePath], ["delete", filePath],
  ]);
  for (const config of calls) {
    assert.deepEqual(config.auth, { username: "admin", password: "test-token" });
    assert.equal(config.headers.get("Authorization"), undefined);
  }
  assert.equal(calls[0].headers.get("Depth"), "0");
  assert.equal(calls[4].headers.get("Depth"), "0");
  assert.equal(calls[2].headers.get("Destination"), "/dav/spaces/space%24root/new%20%23folder");
  assert.equal(calls[7].headers.get("Destination"), root + "/" + encodeURIComponent(renamed));
  assert.equal(calls[5].headers.get("Content-Type"), "application/octet-stream");
  assert.equal(calls[5].headers.get("Content-Length"), "5");
  assert.deepEqual(calls[5].data, Buffer.from("hello"));
});

test("file reads automatically request binary and return the original Buffer", async () => {
  const spaces = client();
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  spaces.client.defaults.adapter = async (config) => {
    assert.equal(config.responseType, "arraybuffer");
    return { config, status: 200, statusText: "OK", headers: {}, data: bytes };
  };
  const binary = await spaces.file.read("folder/binary.bin");
  assert.ok(Buffer.isBuffer(binary));
  assert.strictEqual(binary, bytes);
});

test("file reads preserve XML and JSON files without converting their contents", async () => {
  const spaces = client();
  for (const [contentType, content] of [["application/xml", "<root>hello</root>"], ["application/json", '{"ok":true}']]) {
    const bytes = Buffer.from(content);
    spaces.client.defaults.adapter = async (config) => ({ config, status: 200, statusText: "OK", headers: { "content-type": contentType }, data: bytes });
    const response = await spaces.file.read("folder/file");
    assert.strictEqual(response, bytes);
  }
});

test("missing resources and authentication errors propagate with status and body", async () => {
  const spaces = client();
  for (const status of [404, 401, 403, 500]) {
    spaces.client.defaults.adapter = async (config) => {
      const response = { config, status, statusText: String(status), headers: {}, data: "server error body" };
      throw new axios.AxiosError("Request failed", "ERR_BAD_RESPONSE", config, null, response);
    };
    for (const operation of [() => spaces.folder.exists("missing"), () => spaces.file.exists("missing/file")]) {
      const result = await operation();
      assert.equal(result.status, status);
      if (status === 404) {
        assert.equal(result.success, false);
        assert.equal(result.error.code, 'NOT_FOUND');
      } else {
        assert.equal(result.success, false);
        assert.equal(result.error.details.content, "server error body");
      }
    }
  }
});

test("folder traversal segments are rejected before sending a request", () => {
  assert.throws(() => client().folder.exists("folder/../other"), TypeError);
});

test("WebDAV XML becomes JSON with namespaces, attributes and repeated properties intact", async () => {
  const spaces = client();
  const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/a&amp;b</d:href><d:propstat><d:prop><d:displayname>00123</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop/><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response><d:response><d:href>/second</d:href></d:response></d:multistatus>`;
  spaces.client.defaults.adapter = async (config) => ({ config, status: 207, statusText: "Multi-Status", headers: { "content-type": "application/xml" }, data: xml });
  const response = await spaces.client.request({ method: "PROPFIND", url: "/metadata" });
  assert.equal(response.status, 207);
  const root = response.data["d:multistatus"];
  assert.equal(root["@_xmlns:d"], "DAV:");
  assert.equal(root["d:response"].length, 2);
  const first = root["d:response"][0];
  assert.equal(first["d:href"], "/a&b");
  assert.equal(first["d:propstat"].length, 2);
  assert.equal(first["d:propstat"][0]["d:prop"]["d:displayname"], "00123");
  assert.equal(first["d:propstat"][1]["d:status"], "HTTP/1.1 404 Not Found");
  assert.deepEqual(JSON.parse(JSON.stringify(response.data)), response.data);
});

test("XML errors are converted without changing their status, including binary error bodies", async () => {
  const spaces = client();
  for (const binary of [false, true]) {
    spaces.client.defaults.adapter = async (config) => {
      const xml = '<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><s:Message>Authentication error</s:Message></d:error>';
      const response = { config, status: 401, statusText: "Unauthorized", headers: { "content-type": "application/xml" }, data: binary ? Buffer.from(xml) : xml };
      throw new axios.AxiosError("Unauthorized", "ERR_BAD_REQUEST", config, null, response);
    };
    await assert.rejects(spaces.file.read("folder/file"), (error) => {
      assert.ok(error instanceof OpenCloudError);
      assert.equal(error.status, 401);
      assert.equal(error.result.error.details["d:error"]["s:Message"], "Authentication error");
      return true;
    });
  }
});

test("empty, JSON, text and malformed XML bodies all yield JSON-compatible objects", async () => {
  const spaces = client();
  for (const [data, expected] of [
    ["", {}], [null, {}], ['{"ok":true}', { ok: true }],
    ['[1,"two"]', [1, "two"]], ["true", { value: true }],
    ["plain text", { content: "plain text" }],
    ['<root code="007"><value>001</value></root>', { root: { value: "001", "@_code": "007" } }],
  ]) {
    spaces.client.defaults.adapter = async (config) => ({ config, status: 201, statusText: "Created", headers: {}, data });
    assert.deepEqual((await spaces.folder.create("folder")).data.body, expected);
  }
  for (const data of ["<root><broken></root>", '<!DOCTYPE root [<!ENTITY x "value">]><root>&x;</root>']) {
    spaces.client.defaults.adapter = async (config) => ({ config, status: 201, statusText: "Created", headers: { "content-type": "application/xml" }, data });
    const failure = await spaces.folder.create("folder");
    assert.equal(failure.success, false);
    const result = failure.error.details;
    assert.equal(result.format, "xml");
    assert.equal(result.content, data);
    assert.equal(typeof result.parseError, "string");
    assert.doesNotThrow(() => JSON.stringify(result));
  }
});

test("folder paths are not mistaken for files by exists() or read()", async () => {
  const spaces = client();
  const body = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/spaces/space%24root/hello/test</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
  spaces.client.defaults.adapter = async (config) =>
    config.method === "propfind"
      ? { config, status: 207, statusText: "Multi-Status", headers: { "content-type": "application/xml" }, data: Buffer.from(body) }
      : { config, status: 200, statusText: "OK", headers: { "content-type": "httpd/unix-directory" }, data: Buffer.from("listing") };

  const asFile = await spaces.file.exists("hello/test");
  assert.equal(asFile.success, false);
  assert.equal(asFile.error.code, "NOT_FOUND");
  assert.deepEqual(asFile.error.details, { expected: "file", actual: "folder" });

  const asFolder = await spaces.folder.exists("hello/test");
  assert.equal(asFolder.success, true);
  assert.equal(asFolder.data.exists, true);

  await assert.rejects(spaces.file.read("hello/test"), (error) => {
    assert.ok(error instanceof OpenCloudError);
    assert.equal(error.code, "RESOURCE_TYPE_MISMATCH");
    assert.deepEqual(error.result.error.details, { expected: "file", actual: "folder" });
    return true;
  });
});

test("file paths are not mistaken for folders by folder.exists()", async () => {
  const spaces = client();
  const body = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/spaces/space%24root/hello/test.txt</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
  spaces.client.defaults.adapter = async (config) => ({ config, status: 207, statusText: "Multi-Status", headers: { "content-type": "application/xml" }, data: Buffer.from(body) });
  const asFolder = await spaces.folder.exists("hello/test.txt");
  assert.equal(asFolder.success, false);
  assert.deepEqual(asFolder.error.details, { expected: "folder", actual: "file" });
  assert.equal((await spaces.file.exists("hello/test.txt")).data.exists, true);
});
