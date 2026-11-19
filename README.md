# Open Cloud Spaces

A JavaScript and TypeScript client for the OpenCloud Spaces WebDAV API.

- **Predictable results.** Every method except `file.read()` resolves to the same
  `{ success, status, data, error, warnings, requestId }` shape — no thrown
  exceptions for ordinary HTTP or network failures.
- **No WebDAV XML in your code.** Responses are converted centrally, so you never
  parse `d:multistatus` or juggle namespace prefixes.
- **Safe by construction.** Results never leak Axios request objects, credentials,
  or raw error internals.
- **Typed.** Ships ESM and CommonJS builds with full type declarations for both.

Requires **Node.js 22 or newer**.

## Table of contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Paths](#paths)
- [The result contract](#the-result-contract)
- [API reference](#api-reference)
  - [Folder methods](#folder-methods)
  - [File methods](#file-methods)
- [Error codes](#error-codes)
- [Warnings](#warnings)
- [Recipes](#recipes)
- [TypeScript](#typescript)
- [Security notes](#security-notes)
- [Development](#development)
- [License](#license)

## Installation

```sh
npm install open-cloud-spaces
```

```ts
// ESM
import { OpenCloudSpaces, OpenCloudError } from "open-cloud-spaces";
```

```js
// CommonJS
const { OpenCloudSpaces, OpenCloudError } = require("open-cloud-spaces");
```

## Quick start

```ts
import { OpenCloudSpaces, OpenCloudError } from "open-cloud-spaces";

const spaces = new OpenCloudSpaces({
  base_url: "https://cloud.example.com",
  user: process.env.OPENCLOUD_USER!,
  token: process.env.OPENCLOUD_TOKEN!,
  space: process.env.OPENCLOUD_SPACE!,
});

// 1. Create a folder.
const created = await spaces.folder.create("Reports");
if (!created.success)
  throw new Error(`${created.error.code}: ${created.error.message}`);

// 2. Upload a file into it.
await spaces.file.upload({
  folderName: "Reports",
  fileName: "hello.txt",
  fileContent: Buffer.from("Hello, OpenCloud!"),
});

// 3. Check that it is there, and read its metadata.
const found = await spaces.file.exists("Reports/hello.txt");
if (found.success) {
  console.log(found.data.resource?.size, found.data.resource?.contentType);
}

// 4. Download the bytes. This is the one method that throws.
try {
  const bytes = await spaces.file.read("Reports/hello.txt");
  console.log(bytes.toString("utf8"));
} catch (error) {
  if (!(error instanceof OpenCloudError)) throw error;
  console.error(error.code, error.status, error.result.error.message);
}
```

## Configuration

The constructor takes a single object. All four fields are required.

```ts
const spaces = new OpenCloudSpaces({
  base_url: "https://cloud.example.com",
  user: "admin",
  token: "an-opencloud-app-token",
  space: "a5e65938-…$c8857d73-…",
});
```

| Field      | Type     | Description                                           |
| ---------- | -------- | ----------------------------------------------------- |
| `base_url` | `string` | Server origin. The DAV prefix is added for you.       |
| `user`     | `string` | Username, sent via HTTP Basic auth.                   |
| `token`    | `string` | OpenCloud app token, used as the password.            |
| `space`    | `string` | Target space ID. Encoded automatically, `$` included. |

Keep credentials in environment variables or a secret manager — never commit them.

The instance exposes exactly two namespaces:

```ts
spaces.folder; // folder operations
spaces.file; // file operations
```

## Paths

Pass **one full path relative to the space root** for every method except
`file.upload()`.

```ts
await spaces.file.exists("Reports/2026/summary.pdf"); // ✅
await spaces.folder.exists("Reports/2026"); // ✅
await spaces.folder.exists(""); // ✅ the space root
```

`file.upload()` is the single exception, because the file does not exist yet and
the folder and filename are distinct inputs:

```ts
await spaces.file.upload({
  folderName: "Reports/2026",
  fileName: "summary.pdf",
  fileContent: buffer,
});
```

Rename takes the **full current path** and the **new name only** — a rename does
not move a resource to a different parent:

```ts
await spaces.file.rename("Reports/old.txt", "new.txt"); // → Reports/new.txt
await spaces.folder.rename("Reports/2025", "Archive"); // → Reports/Archive
```

Rules the client enforces for you:

- Every segment is URL-encoded, so spaces, `#`, `%`, and non-ASCII names are safe.
- Leading and trailing slashes are ignored.
- `.` and `..` segments throw a `TypeError` **before** any request is sent.
- Returned `path` values are encoded and relative to the space root — no DAV
  prefix, no space ID — so they are safe to store and reuse.

## The result contract

Every method except `file.read()` resolves to an `OpenCloudResult<T>`:

```ts
{
  success: boolean;
  status: number | null;   // HTTP status; null when no response arrived
  data: T | null;          // non-null only when success is true
  error: { code, message, retryable, details } | null;
  warnings: Array<{ code, message, status, property }>;
  requestId: string | null; // from x-request-id / oc-request-id
}
```

`success` is a TypeScript discriminant — check it first and the compiler narrows
`data` and `error` for you:

```ts
const result = await spaces.folder.exists("Reports");
if (result.success) {
  result.data.resource; // ✅ data is non-null here
} else {
  result.error.code; // ✅ error is non-null here
}
```

**`success` reflects the operation's outcome, not merely a completed request.**
An existence check on a missing path is a `NOT_FOUND` _failure_, not a success
carrying `exists: false`.

`file.read()` is the deliberate exception: it returns a `Buffer` directly and
rejects with `OpenCloudError` on failure. That error carries the identical
failure object on `error.result`, plus `error.code` and `error.status` shortcuts.

## API reference

### Folder methods

#### `folder.exists(path): Promise<OpenCloudResult<ExistsData>>`

Succeeds only when a **folder** exists at `path`.

```ts
const result = await spaces.folder.exists("Reports");
if (result.success) {
  console.log(result.data.exists); // true
  console.log(result.data.resource?.type); // "folder"
}
```

Fails with `NOT_FOUND` when nothing is there, **and also when a file occupies the
path** — a WebDAV path alone cannot distinguish the two, so the client checks the
reported resource type. In the mismatch case `error.details` is
`{ expected: "folder", actual: "file" }`.

#### `folder.create(path): Promise<OpenCloudResult<ResourceChange>>`

Creates a collection. The parent folder must already exist, otherwise the server
replies `409` → `CONFLICT`.

```ts
const created = await spaces.folder.create("Reports/2026");
console.log(created.data?.path); // "Reports/2026"
```

#### `folder.rename(path, newName): Promise<OpenCloudResult<ResourceChange>>`

```ts
const renamed = await spaces.folder.rename("Reports/2025", "Archive");
console.log(renamed.data?.path); // "Reports/Archive"
console.log(renamed.data?.previousPath); // "Reports/2025"
```

#### `folder.delete(path): Promise<OpenCloudResult<ResourceChange>>`

Deletes the folder **and its contents**. A successful delete typically returns
HTTP `204` with `data.body` as `{}`.

### File methods

#### `file.exists(path): Promise<OpenCloudResult<ExistsData>>`

Succeeds only when a **file** exists at `path`; a folder at that path fails with
`NOT_FOUND` and `error.details` of `{ expected: "file", actual: "folder" }`.

```ts
const found = await spaces.file.exists("Reports/hello.txt");
if (found.success) {
  const { name, size, etag, lastModified, contentType, id } =
    found.data.resource!;
}
```

#### `file.upload({ folderName, fileName, fileContent }): Promise<OpenCloudResult<ResourceChange>>`

Uploads bytes, creating or overwriting the file. The destination folder must
already exist.

```ts
await spaces.file.upload({
  folderName: "Reports",
  fileName: "report.pdf",
  fileContent: await fs.readFile("./report.pdf"),
});
```

`fileContent` must be a `Buffer`. Content-Length and a binary content type are
set for you.

#### `file.read(path): Promise<Buffer>`

Downloads the original bytes — byte-for-byte, for every file type and size, with
no options to configure. XML and JSON files are **not** parsed.

```ts
try {
  const bytes = await spaces.file.read("Reports/report.pdf");
} catch (error) {
  if (!(error instanceof OpenCloudError)) throw error; // real bugs still surface
  console.error(error.code, error.status);
}
```

Pointing this at a folder throws `RESOURCE_TYPE_MISMATCH` rather than silently
handing back a directory listing as if it were file content.

#### `file.rename(path, newFileName): Promise<OpenCloudResult<ResourceChange>>`

#### `file.delete(path): Promise<OpenCloudResult<ResourceChange>>`

### Returned data shapes

```ts
interface ExistsData {
  // exists()
  exists: boolean;
  resource: ResourceMetadata | null;
}

interface ResourceMetadata {
  name: string;
  path: string; // encoded, relative to the space root
  type: "folder" | "file" | "unknown";
  id: string | null;
  size: number | null; // null when absent or not a safe integer
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
}

interface ResourceChange {
  // create / upload / rename / delete
  name: string;
  path: string;
  type: "folder" | "file";
  previousPath: string | null; // set on rename only
  body: JsonData; // converted server body, usually {}
}
```

Raw WebDAV properties are intentionally omitted; unavailable ones become
[warnings](#warnings) instead.

## Error codes

`error.code` is stable — switch on it rather than parsing messages. `error.message`
prefers the server's own message when one is present. `error.retryable` marks the
transient cases.

| Code                     | Meaning                                              | Retryable |
| ------------------------ | ---------------------------------------------------- | --------- |
| `NOT_FOUND`              | Missing resource, or present as the other kind (404) | no        |
| `BAD_REQUEST`            | Malformed request (400)                              | no        |
| `UNAUTHORIZED`           | Bad or expired credentials (401)                     | no        |
| `FORBIDDEN`              | Authenticated but not permitted (403)                | no        |
| `METHOD_NOT_ALLOWED`     | Unsupported operation (405)                          | no        |
| `CONFLICT`               | Parent missing or target conflict (409)              | no        |
| `PRECONDITION_FAILED`    | Precondition failed (412)                            | no        |
| `PAYLOAD_TOO_LARGE`      | Upload exceeds server limits (413)                   | no        |
| `VALIDATION_ERROR`       | Server rejected the payload (422)                    | no        |
| `LOCKED`                 | Resource is locked (423)                             | no        |
| `RATE_LIMITED`           | Too many requests (429)                              | **yes**   |
| `TIMEOUT`                | Request timed out (408 or transport)                 | **yes**   |
| `SERVER_ERROR`           | Any 5xx                                              | **yes**   |
| `HTTP_ERROR`             | Unmapped 4xx                                         | no        |
| `NETWORK_ERROR`          | Connection failed                                    | **yes**   |
| `CANCELED`               | Request was canceled                                 | no        |
| `RESOURCE_TYPE_MISMATCH` | `file.read()` targeted a folder                      | no        |
| `PARTIAL_FAILURE`        | A `207` reported a failed child operation            | no        |
| `INVALID_RESPONSE`       | Unparseable or ambiguous server body                 | no        |

Two codes deserve special care:

- **`PARTIAL_FAILURE`** — a multi-status response where some child operations
  failed. Part of the work may have completed, so inspect `error.details` and
  reconcile state before retrying.
- **`NETWORK_ERROR` / `TIMEOUT`** on a mutation — the operation may still have
  succeeded server-side. Verify with `exists()` before blindly retrying.

## Warnings

`warnings` is always an array and may be populated on **successful** results. It
never indicates failure — it explains incomplete metadata.

| Code                     | Meaning                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `PROPERTY_UNAVAILABLE`   | The server could not return a property (`property` names it)    |
| `MISSING_RESOURCE_TYPE`  | No `resourcetype`, so `resource.type` is `"unknown"`            |
| `INVALID_PROPERTY_VALUE` | A value was unusable, e.g. a size beyond safe integer precision |

```ts
const result = await spaces.folder.exists("Reports");
if (result.success && result.warnings.length) {
  console.warn("incomplete metadata:", result.warnings);
}
```

## Recipes

**Create a folder only when it is absent**

```ts
const found = await spaces.folder.exists("Reports");
if (!found.success && found.error.code === "NOT_FOUND") {
  await spaces.folder.create("Reports");
} else if (!found.success) {
  throw new Error(found.error.message); // a real failure, not just "absent"
}
```

**Read a file safely, without exceptions**

```ts
async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await spaces.file.read(path);
  } catch (error) {
    if (error instanceof OpenCloudError && error.code === "NOT_FOUND")
      return null;
    throw error;
  }
}
```

**Retry only what is worth retrying**

```ts
async function withRetry<T>(operation: () => Promise<OpenCloudResult<T>>) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await operation();
    if (result.success || !result.error.retryable) return result;
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 250));
  }
  return operation();
}
```

**Log failures without leaking secrets**

Results are already free of credentials and Axios internals, so they are safe to
serialize:

```ts
if (!result.success) {
  console.error(
    JSON.stringify({ requestId: result.requestId, ...result.error }),
  );
}
```

## TypeScript

```ts
import type {
  OpenCloudResult,
  OpenCloudSuccess,
  OpenCloudFailure,
  OpenCloudErrorDetails,
  OpenCloudWarning,
  ExistsData,
  ResourceMetadata,
  ResourceChange,
  JsonData,
  JsonValue,
} from "open-cloud-spaces";
```

`OpenCloudResult<T>` is a discriminated union of `OpenCloudSuccess<T>` and
`OpenCloudFailure`, so a `success` check is all the narrowing you need. Both ESM
and CommonJS consumers get matching declaration files.

## Security notes

- Credentials are sent via HTTP Basic auth and never appear in results or errors.
- XML bodies declaring a DTD or custom entities are rejected as `INVALID_RESPONSE`
  rather than parsed, so hostile bodies cannot trigger entity-expansion attacks.
- ⚠️ **The bundled HTTPS agent currently sets `rejectUnauthorized: false`** for
  local development against self-signed certificates. This disables TLS
  certificate verification and **must be secured before production use**.

## Development

```sh
npm ci
npm run check
```

| Script                     | Purpose                                           |
| -------------------------- | ------------------------------------------------- |
| `npm run build`            | Build ESM and CommonJS bundles with `tsup`        |
| `npm run typecheck`        | Type-check without emitting                       |
| `npm test`                 | Build, then run API-contract and conversion tests |
| `npm run check`            | `typecheck` + `test`                              |
| `npm run test:integration` | Live suite against a local OpenCloud server       |

See [RESPONSE_FORMAT.md](./RESPONSE_FORMAT.md) for response formats, edge cases,
limits, and migration notes.

## License

[ISC](./LICENSE).
