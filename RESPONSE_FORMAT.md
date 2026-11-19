# Response conversion and edge cases

Every JSON API method returns the same TypeScript discriminated union:

```ts
// success
{ success: true, status: 201, data: { /* typed operation data */ },
  error: null, warnings: [], requestId: null }

// failure
{ success: false, status: 401, data: null,
  error: { code: "UNAUTHORIZED", message: "...", retryable: false, details: {} },
  warnings: [], requestId: null }
```

Check `success` before reading `data` or `error`. Status is the actual outer HTTP
status, or `null` if no response arrived. Request IDs come from `X-Request-ID` or
`OC-Request-ID`; no request/configuration/authentication objects are returned.
No automatic retries are performed. `retryable` is only a hint: mutations may
have completed before a connection failed, so reconcile their state first.

| Method | Successful data |
| --- | --- |
| `folder.exists`, `file.exists` | `{ exists, resource }`; absence or the other resource kind returns `{ exists: false, resource: null }` successfully |
| `file.stat` | File `ResourceMetadata` directly in `data`; absence returns a `NOT_FOUND` failure |
| `folder.create`, `folder.rename`, `folder.delete` | `{ name, path, type: "folder", previousPath, body }` |
| `file.upload`, `file.rename`, `file.delete` | `{ name, path, type: "file", previousPath, body }` |
| `file.read` | Original Node.js Buffer directly (the deliberate exception) |
| `file.read` with `{ withMetadata: true }` | `{ bytes, resource }`, metadata taken from response headers |

`file.upload()` accepts optional booleans `overwrite` (default `true`) and
`ensureDestination` (default `false`). With `overwrite: false`, a conditional PUT
prevents replacing an existing target; HTTP 412 becomes `FILE_ALREADY_EXISTS`
while preserving the status, request ID, and server error details. Other methods
retain the generic `PRECONDITION_FAILED` code for HTTP 412.

With `ensureDestination: true`, missing destination folders and their parents are
created before uploading. Existing folders are reused. A non-folder in the path
returns `RESOURCE_TYPE_MISMATCH`; folder lookup or creation failures are returned
without attempting the upload. Folders created before a later failure remain.

`path` is the URL-encoded path relative to the space root, with no leading or
trailing slash (for example `Reports/hello.txt`). The space root is `""`.
The dynamic `/dav/spaces/<space-id>` prefix is never included in public path fields. `previousPath` is set only on rename. `body`
preserves converted server data, including unknown fields, and is normally `{}`
for successful mutations. A `204` deletion still returns meaningful operation
information. Renames report the destination in `path` and source in `previousPath`.

`resource` exposes `name`, `path`, `type`, `id`, `size`, `etag`, `lastModified`,
and `contentType`. Raw WebDAV properties are omitted. Missing values are `null`; `type` may be
`"unknown"`. `size` is a safe non-negative byte count or `null`. Namespaces are
resolved by URI rather than by a hardcoded prefix. Unknown properties do not add
fields to the public resource object. The resource path uses the same relative format as mutation paths, independent
of the server href or space ID. ETags and modification dates retain server formatting.

For `file.read(path, { withMetadata: true })`, `resource` is download metadata
with `name`, `path`, `extension`, `mimeType`, `charset`, `id`, `size`, `etag`, and
`lastModified`. The name and extension come from the requested path. Extension
is lowercase and includes the dot (for example `.txt`), or is `null` when there
is no extension. `size` is always the actual downloaded byte length. MIME type
and charset come from `Content-Type`; unavailable header values are `null`.
This metadata is returned with the bytes without an extra request.

A normal HTTP `404` from `exists()` returns `success: true`, `status: 404`,
`data: { exists: false, resource: null }`. Permission/authentication/server errors
are failure results rather than being mistaken for absence. A `404` from delete
is a failure result (`NOT_FOUND`). Inside `207`, a resource-level `404` also
means absence; unavailable individual properties become `warnings` instead.
Property-only failures cannot reliably establish existence and return a failure.
An unknown, ambiguous, conflicting, or incomplete existence response returns
`INVALID_RESPONSE`. Nullable sizes/types that could not be determined include
explicit metadata warnings. A mutation's `207` is inspected separately: any
reported failed child operation produces `PARTIAL_FAILURE`, retaining the outer
HTTP status and full converted details. Do not retry an entire partially completed
operation without first checking its state.

`file.exists()` on a known folder and `folder.exists()` on a known file also
return successful negative checks with `resource: null`. Unknown resource types
remain present with a warning. Check both `success` and `data.exists` before
using existence metadata.

`file.stat()` reads metadata through PROPFIND without downloading content and
returns it directly in `data`. A missing file returns a `NOT_FOUND` failure;
a folder target returns `RESOURCE_TYPE_MISMATCH`. As with `exists()`, the outer
HTTP status, request ID, and property warnings are preserved, including `207`
when absence is reported by a resource-level `404` inside multi-status.
`file.read()` (including metadata mode) rejects with `OpenCloudError` and code
`NOT_FOUND` for missing files. `file.delete()` and `folder.delete()` return a
`NOT_FOUND` failure when the server reports absence.

HTTP and network failures resolve to failure results for JSON methods. Failed
`file.read()` calls reject with exported `OpenCloudError`: use `error.result`
for the same JSON failure shape, or `error.status`/`error.code` for quick checks.
Successful reads return the exact bytes for every file type and size, with no
options needed. A read whose target turns out to be a collection rejects with
`RESOURCE_TYPE_MISMATCH` rather than returning the directory listing bytes. Invalid arguments and unexpected programming errors still throw;
they are not disguised as network failures.

This replaces the former mixed Axios-response/data-only return contracts. XML
conversion itself still runs centrally before projection, and its behavior is
summarized below. The table describes the converted server body (available as
mutation `data.body`, readable resource metadata, or failure `error.details`).

| Input/scenario | Result |
| --- | --- |
| JSON object/array | Parsed object/array; unknown fields retained |
| JSON primitive, including literal `null`, `false`, or `0` | `{ value: ... }` |
| No body, zero bytes, whitespace-only body | `{}` |
| Plain text | `{ content: "..." }` |
| Well-formed XML | Parsed object; prefixes and attributes retained |
| Malformed/truncated XML, multiple roots, duplicate attributes | Raw body with `format: "xml"` and `parseError` |
| Malformed JSON object/array or JSON-labelled body | Raw body with `format: "json"` and `parseError` |
| Recognizable HTML gateway response | `{ content: "...", format: "html" }` |
| Buffered API body | Decoded before format detection |
| Undecodable bytes or unsupported charset | Exact bytes retained as base64 with `encoding`, `format`, and `parseError` |
| Transport failure, timeout or cancellation | Original error; no response body is invented |
| Successful file read, even XML/JSON/malformed/empty files | Original Buffer |
| Failed file read | Error body normalized like other API errors |

A raw-body fallback has this shape:

```js
{
  content: "original server body",
  format: "xml", // or json, text, unknown, binary
  parseError: "reason conversion could not safely finish"
}
```

A parser failure never changes the HTTP status. A successful HTTP response with
an unsafe/malformed body now produces `success: false`, `error.code:
"INVALID_RESPONSE"`, and the fallback body in `error.details`. Conversion issues
are tracked out of band, so ordinary application JSON fields called `parseError`,
`content`, or `format` do not collide with internal diagnostics. The original
body is retained without truncation.

## XML structure and server changes

- Namespace prefixes and declarations remain intact. `d:id` and `oc:id` are
  separate keys. Changing a server prefix changes the key; do not assume every
  server always uses `d:`. No schema version or business meaning is inferred.
- WebDAV elements whose local names are `response` or `propstat` are always
  arrays, including a single occurrence. Attributes with those names stay scalar.
  Missing elements are not invented. Other elements become arrays when repeated;
  consumers must account for absent, single and repeated values.
- Unknown roots, tags, attributes and added fields are retained. XML scalar
  values stay strings, preserving leading zeros, large IDs and text like `true`.
  Empty elements become empty strings (or objects when they have attributes).
- Attributes use `@_name`. Text alongside attributes uses `#text`.
- Mixed element/text content uses `{ xml: [...] }`, an ordered representation,
  so text before and after child elements is not combined out of order.
  `xml:space="preserve"` also selects this representation when necessary.
  XML comments and processing instructions are ignored. This converter is not an
  XML round-trip serializer: declaration syntax and CDATA boundaries are not kept.
- CDATA content remains literal. Standard XML entities and decimal/hex numeric
  references are decoded. Unknown named references remain literal; the converter
  does not resolve external resources. Actual DTD/custom-entity declarations are
  rejected with raw-body fallback, while declaration-like text inside a comment
  or CDATA is harmless.
- `207 Multi-Status` may contain individual property/resource errors. Those
  statuses remain in JSON. They do not automatically fail the outer request; successful properties become
  readable metadata and unavailable properties become typed warnings.
  For example, a folder can exist while `oc:has-preview` reports `404`.
- UTF-8/BOM, UTF-16 byte order/BOM, HTTP charsets and XML encoding declarations
  are supported by Node's TextDecoder. A BOM or recognizable UTF-16 byte pattern
  takes precedence, then the HTTP charset, then an XML declaration, then UTF-8. Unsupported/invalid encodings
  retain the original bytes as base64 rather than replacing characters silently.
- Valid JSON/XML bodies are recognized even when common Content-Type labels are
  missing or inaccurate. Known HTML documents are retained as HTML envelopes.

## JSON behavior and conversion limits

API bodies are received as bytes so Axios does not first coerce JSON null or
round an integer before validation. Finite safe numbers use JavaScript number
semantics; integer values outside the safe range and non-finite values trigger
raw-body fallback. Decimal arithmetic still follows IEEE-754. Duplicate JSON
object keys follow JSON.parse behavior: the last value wins. XML duplicate
attributes are invalid and produce fallback.

Structured conversion is bounded to 8 MiB of input, 128 nesting levels, and
100,000 XML elements/JSON values. Entity decoding is bounded to 100,000 expansions
and 8 MiB of expansion. Exceeding a limit returns raw content with `parseError`;
large buffered metadata bodies are retained as base64. These are conversion
limits, not network download or total-memory limits. Successful file downloads
bypass them completely.

Already-parsed ordinary objects/arrays are safely copied without executing
getters or `toJSON`. Circular objects, accessors, BigInt, non-finite numbers and
unsupported object instances produce a JSON diagnostic instead of throwing.
Such programmatic inputs have no original wire body to retain. Literal JSON
keys such as `__proto__` are preserved as own data properties without modifying
prototypes. XML names rejected by the XML parser produce raw-body fallback.
A fresh parser/decoder is used for each response to avoid cross-request state.

```js
const result = await spaces.folder.exists("folder");
if (!result.success) {
  console.error(result.error.code, result.error.message);
} else if (result.data.exists) {
  console.log(result.data.resource?.name, result.data.resource?.size);
}
const bytes = await spaces.file.read("folder/image.png");

// Include file metadata with the downloaded content.
const download = await spaces.file.read("Reports/hello.txt", {
  withMetadata: true,
});
console.log(download.bytes.toString("utf8"));
console.log(download.resource.name);      // "hello.txt"
console.log(download.resource.extension); // ".txt"
console.log(download.resource.mimeType);  // e.g. "text/plain"
console.log(download.resource.size);      // File size in bytes
```

## Verification and practical limits

`npm run check` covers the conversion matrix, namespaces, repeated/unknown
fields, entities/CDATA/mixed text, malformed bodies, encodings, limits, unsafe
values, HTTP-error preservation, binary bypass, ESM/CommonJS consumers,
concurrent calls and 300 deterministic malformed-body variations.
`npm run test:integration` verifies the actual OpenCloud server with ordinary and
special-character names. Its test resources remain preserved for inspection.

These checks cover documented behavior and regressions; they cannot guarantee
compatibility with every future server schema or every possible malformed input.
Callers must still handle optional/changing fields, property-level failures,
`INVALID_RESPONSE`, warnings, and failure results. The converted object is not a schema
validation result.
