import assert from 'node:assert/strict';
import { test } from 'node:test';
import axios from 'axios';
import { OpenCloudSpaces, OpenCloudError } from 'open-cloud-spaces';

function client() { return new OpenCloudSpaces({ base_url: 'https://example.invalid', user: 'private-user', token: 'private-token', space: 'space' }); }
function mock(spaces, status, body = '', headers = {}) {
  spaces.client.defaults.adapter = async (config) => {
    const response = { config, status, statusText: String(status), headers, data: Buffer.from(body) };
    if (status >= 400) throw new axios.AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, { secret: true }, response);
    return response;
  };
}
function multistatus(entries, prefix = 'd') { return `<${prefix}:multistatus xmlns:${prefix}="DAV:" xmlns:oc="http://owncloud.org/ns">${entries}</${prefix}:multistatus>`; }
function entry(path, { prefix = 'd', name = 'Report', folder = false, extra = '', extraGroups = '' } = {}) {
  return `<${prefix}:response><${prefix}:href>${path}</${prefix}:href><${prefix}:propstat><${prefix}:prop><${prefix}:displayname>${name}</${prefix}:displayname><${prefix}:resourcetype>${folder ? `<${prefix}:collection/>` : ''}</${prefix}:resourcetype><${prefix}:getcontentlength>51</${prefix}:getcontentlength><${prefix}:getetag>"etag"</${prefix}:getetag><${prefix}:getlastmodified>Thu, 19 Nov 2026 00:00:00 GMT</${prefix}:getlastmodified><${prefix}:getcontenttype>text/plain</${prefix}:getcontenttype><oc:id>00123</oc:id>${extra}</${prefix}:prop><${prefix}:status>HTTP/1.1 200 OK</${prefix}:status></${prefix}:propstat>${extraGroups}</${prefix}:response>`;
}

const operations = [
  ['folder.create', (s) => s.folder.create('Reports'), 'folder', 'Reports', null],
  ['folder.rename', (s) => s.folder.rename('Reports', 'Renamed'), 'folder', 'Renamed', 'Reports'],
  ['folder.delete', (s) => s.folder.delete('Reports'), 'folder', 'Reports', null],
  ['file.upload', (s) => s.file.upload({ destination: 'Reports', fileName: 'hello.txt', buffer: Buffer.from('hello') }), 'file', 'Reports/hello.txt', null],
  ['file.rename', (s) => s.file.rename('Reports/hello.txt', 'new.txt'), 'file', 'Reports/new.txt', 'Reports/hello.txt'],
  ['file.delete', (s) => s.file.delete('Reports/hello.txt'), 'file', 'Reports/hello.txt', null],
];
for (const [name, operation, type, path, previousPath] of operations) {
  test(`result contract: ${name}`, async () => {
    const spaces = client(); mock(spaces, name.includes('delete') ? 204 : 201, '', { 'X-Request-ID': 'request-123' });
    const result = await operation(spaces);
    assert.deepEqual(Object.keys(result).sort(), ['success', 'status', 'data', 'error', 'warnings', 'requestId'].sort());
    assert.equal(result.success, true);
    assert.equal(result.error, null);
    assert.equal(result.data.type, type);
    assert.equal(result.data.path, path);
    assert.equal(result.data.name, path.split('/').at(-1));
    assert.equal(result.data.previousPath, previousPath);
    assert.deepEqual(result.data.body, {});
    assert.equal(result.requestId, 'request-123');
    assert.deepEqual(result.warnings, []);
    assert.ok(!JSON.stringify(result).includes('private-token'));
    assert.ok(!JSON.stringify(result).includes('private-user'));
  });
}

for (const prefix of ['d', 'D', 'custom']) {
  test(`namespace-independent resource metadata: ${prefix}`, async () => {
    const spaces = client();
    mock(spaces, 207, multistatus(entry('/dav/spaces/space/Reports', { prefix, folder: true, extra: '<oc:custom>keep</oc:custom>' }), prefix));
    const result = await spaces.folder.exists('Reports');
    assert.equal(result.success, true);
    assert.equal(result.data.exists, true);
    const info = result.data.resource;
    assert.equal(info.type, 'folder');
    assert.equal(info.name, 'Report');
    assert.equal(info.id, '00123');
    assert.equal(info.size, 51);
    assert.equal(info.etag, '"etag"');
    assert.equal(info.contentType, 'text/plain');
    assert.equal(Object.hasOwn(info, 'properties'), false);
    assert.ok(info.lastModified);
  });
}

test('default DAV namespace and nullable metadata fields have stable results', async () => {
  const spaces = client();
  mock(spaces, 207, '<multistatus xmlns="DAV:"><response><href>/folder</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>');
  const result = await spaces.folder.exists('folder');
  assert.equal(result.success, true);
  assert.equal(result.data.resource.type, 'folder');
  assert.equal(result.data.resource.name, 'folder');
  for (const key of ['id', 'size', 'etag', 'lastModified', 'contentType']) assert.equal(result.data.resource[key], null);
});

test('optional property failures appear as warnings rather than missing resources', async () => {
  const spaces = client();
  const extraGroups = '<d:propstat><d:prop><oc:has-preview/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>';
  mock(spaces, 207, multistatus(entry('/folder', { folder: true, extraGroups })));
  const result = await spaces.folder.exists('folder');
  assert.equal(result.success, true);
  assert.equal(result.data.exists, true);
  assert.deepEqual(result.warnings, [{ code: 'PROPERTY_UNAVAILABLE', message: 'A WebDAV property could not be retrieved.', status: 404, property: 'oc:has-preview' }]);
});

test('missing paths fail with NOT_FOUND for both exists methods', async () => {
  const spaces = client(); mock(spaces, 404, '<d:error xmlns:d="DAV:"><message>Not found</message></d:error>', { 'oc-request-id': 'not-found-1' });
  for (const result of [await spaces.folder.exists('missing'), await spaces.file.exists('folder/missing')]) {
    assert.equal(result.success, false);
    assert.equal(result.status, 404);
    assert.equal(result.data, null);
    assert.equal(result.error.code, 'NOT_FOUND');
    assert.equal(result.error.retryable, false);
    assert.equal(result.requestId, 'not-found-1');
  }
});

test('207 resource-level failures remain distinguishable from property-level warnings', async () => {
  const spaces = client();
  for (const code of [404, 403]) {
    mock(spaces, 207, multistatus(`<d:response><d:href>/folder</d:href><d:status>HTTP/1.1 ${code} Error</d:status></d:response>`));
    const result = await spaces.folder.exists('folder');
    assert.equal(result.status, 207);
    if (code === 404) { assert.equal(result.success, false); assert.equal(result.error.code, 'NOT_FOUND'); assert.equal(result.data, null); }
    else { assert.equal(result.success, false); assert.equal(result.error.code, 'FORBIDDEN'); assert.equal(result.error.details.status, 403); }
  }
});

test('unrecognized, ambiguous and incomplete existence bodies fail explicitly', async () => {
  const spaces = client();
  for (const body of ['{}', '<other/>', '<d:multistatus xmlns:d="DAV:"/>', multistatus('<d:response/>'), multistatus(entry('/other') + entry('/also-other')), multistatus('<d:response><d:propstat><d:prop/><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>')]) {
    mock(spaces, 207, body);
    const result = await spaces.folder.exists('folder');
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INVALID_RESPONSE');
    assert.equal(result.data, null);
  }
});

test('multiple WebDAV entries select the requested href rather than the first item', async () => {
  const spaces = client();
  mock(spaces, 207, multistatus(entry('/other', { name: 'Other', folder: true }) + entry('/dav/spaces/space/Reports%20%231', { name: 'Correct', folder: true })));
  const result = await spaces.folder.exists('Reports #1');
  assert.equal(result.success, true);
  assert.equal(result.data.resource.name, 'Correct');
});

for (const [status, code, retryable] of [[401, 'UNAUTHORIZED', false], [403, 'FORBIDDEN', false], [404, 'NOT_FOUND', false], [409, 'CONFLICT', false], [412, 'PRECONDITION_FAILED', false], [423, 'LOCKED', false], [429, 'RATE_LIMITED', true], [503, 'SERVER_ERROR', true]]) {
  test(`HTTP ${status} returns a safe typed failure`, async () => {
    const spaces = client(); mock(spaces, status, '<d:error xmlns:d="DAV:"><message>Server detail</message></d:error>');
    const result = await spaces.folder.create('folder');
    assert.equal(result.success, false);
    assert.equal(result.data, null);
    assert.equal(result.status, status);
    assert.equal(result.error.code, code);
    assert.equal(result.error.retryable, retryable);
    assert.equal(result.error.message, 'Server detail');
    assert.ok(result.error.details['d:error']);
    assert.ok(!JSON.stringify(result).includes('private-token'));
    assert.ok(!JSON.stringify(result).includes('secret'));
  });
}

test('malformed successful metadata returns INVALID_RESPONSE, retaining the server body', async () => {
  const spaces = client(); mock(spaces, 201, '<broken>');
  const result = await spaces.folder.create('folder');
  assert.equal(result.success, false);
  assert.equal(result.status, 201);
  assert.equal(result.error.code, 'INVALID_RESPONSE');
  assert.equal(result.error.details.content, '<broken>');
});

test('application JSON diagnostic-like fields do not collide with parser diagnostics', async () => {
  const spaces = client();
  const payload = { parseError: 'application field', content: 'application content', format: 'xml' };
  mock(spaces, 201, JSON.stringify(payload));
  const result = await spaces.folder.create('folder');
  assert.equal(result.success, true);
  assert.deepEqual(result.data.body, payload);
});

test('transport errors become results without retries or request configuration', async () => {
  for (const [transportCode, code, retryable] of [['ECONNREFUSED', 'NETWORK_ERROR', true], ['ECONNABORTED', 'TIMEOUT', true], ['ERR_CANCELED', 'CANCELED', false]]) {
    const spaces = client(); let calls = 0;
    spaces.client.defaults.adapter = async (config) => { calls++; throw new axios.AxiosError('contains private-token', transportCode, config); };
    const result = await spaces.folder.create('folder');
    assert.equal(result.success, false);
    assert.equal(result.status, null);
    assert.equal(result.error.code, code);
    assert.equal(result.error.retryable, retryable);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(result).includes('private-token'));
  }
});

test('file reads still return raw bytes and expose typed JSON errors on failure', async () => {
  const spaces = client();
  mock(spaces, 200, '<root>original bytes</root>');
  assert.deepEqual(await spaces.file.read('folder/file.xml'), Buffer.from('<root>original bytes</root>'));
  mock(spaces, 404, '<d:error xmlns:d="DAV:"><message>Missing</message></d:error>');
  await assert.rejects(spaces.file.read('folder/missing'), (error) => {
    assert.ok(error instanceof OpenCloudError);
    assert.equal(error.status, 404);
    assert.equal(error.code, 'NOT_FOUND');
    assert.equal(error.result.error.message, 'Missing');
    assert.deepEqual(JSON.parse(JSON.stringify(error)), error.result);
    assert.ok(!JSON.stringify(error).includes('private-token'));
    return true;
  });
});

test('duplicate matching resources are rejected instead of silently choosing one', async () => {
  const spaces = client();
  mock(spaces, 207, multistatus(entry('/dav/spaces/space/folder') + entry('/dav/spaces/space/folder')));
  const result = await spaces.folder.exists('folder');
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'INVALID_RESPONSE');
});

test('unsafe sizes and absent types are nullable and explicitly warned', async () => {
  const spaces = client();
  mock(spaces, 207, '<multistatus xmlns="DAV:"><response><propstat><prop><getcontentlength>90071992547409930000</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>');
  const result = await spaces.folder.exists('folder');
  assert.equal(result.success, true);
  assert.equal(result.data.resource.size, null);
  assert.equal(result.data.resource.type, 'unknown');
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['MISSING_RESOURCE_TYPE', 'INVALID_PROPERTY_VALUE']);
});

test('conflicting properties and invalid property payloads fail explicitly', async () => {
  const spaces = client();
  for (const groups of [
    '<d:propstat><d:prop><d:displayname>A</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:displayname>B</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>',
    '<d:propstat><d:prop>unexpected text</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>',
    '<d:propstat><d:prop/><d:status>HTTP/1.1 999 Invalid</d:status></d:propstat>',
  ]) {
    mock(spaces, 207, multistatus(`<d:response>${groups}</d:response>`));
    const result = await spaces.folder.exists('folder');
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INVALID_RESPONSE');
  }
});

test('mutation 207 responses do not hide failed child operations', async () => {
  const spaces = client();
  for (const [body, success, code] of [
    [multistatus('<d:response><d:href>/child</d:href><d:status>HTTP/1.1 423 Locked</d:status></d:response>'), false, 'PARTIAL_FAILURE'],
    [multistatus('<d:response><d:href>/child</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response>'), true, null],
    [multistatus('<d:response><d:href>/child</d:href></d:response>'), false, 'INVALID_RESPONSE'],
  ]) {
    mock(spaces, 207, body);
    const result = await spaces.folder.rename('folder', 'renamed');
    assert.equal(result.status, 207);
    assert.equal(result.success, success);
    assert.equal(result.error?.code ?? null, code);
  }
});

test('public paths are relative to dynamic spaces while request URLs remain complete', async () => {
  const spaces = new OpenCloudSpaces({ base_url: 'https://example.invalid', user: 'u', token: 't', space: 'dynamic$space' });
  const seen = [];
  spaces.client.defaults.adapter = async (config) => {
    seen.push(config);
    const data = config.method === 'propfind'
      ? Buffer.from(multistatus(entry('https://other-host.invalid/dav/spaces/different%24id/Reports%20%231/hello%25.txt')))
      : Buffer.alloc(0);
    return { config, status: config.method === 'propfind' ? 207 : 201, headers: {}, data };
  };
  const created = await spaces.folder.create('/Reports #1/');
  assert.equal(created.data.path, 'Reports%20%231');
  const renamed = await spaces.file.rename('Reports #1/hello%.txt', 'new #.txt');
  assert.equal(renamed.data.path, 'Reports%20%231/new%20%23.txt');
  assert.equal(renamed.data.previousPath, 'Reports%20%231/hello%25.txt');
  const found = await spaces.file.exists('Reports #1/hello%.txt');
  assert.equal(found.success, true);
  assert.equal(found.data.resource.path, 'Reports%20%231/hello%25.txt');
  assert.equal(seen[0].url, '/dav/spaces/dynamic%24space/Reports%20%231');
  assert.equal(seen[1].headers.get('Destination'), '/dav/spaces/dynamic%24space/Reports%20%231/new%20%23.txt');
});

test('space root metadata has an empty relative path', async () => {
  const spaces = client(); mock(spaces, 207, multistatus(entry('/dav/spaces/space/', { folder: true })));
  assert.equal((await spaces.folder.exists('')).data.resource.path, '');
});
