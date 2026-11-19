# Open Cloud Spaces

A JavaScript and TypeScript client for OpenCloud Spaces WebDAV APIs, using Axios.
Requires Node.js 22 or newer. Supports ESM and CommonJS.

```sh
npm install open-cloud-spaces
```

```ts
import { OpenCloudSpaces, OpenCloudError } from "open-cloud-spaces";

const spaces = new OpenCloudSpaces({
  base_url: "https://cloud.example.com",
  user: process.env.OPENCLOUD_USER!,
  token: process.env.OPENCLOUD_TOKEN!, // OpenCloud app token used as a password
  space: process.env.OPENCLOUD_SPACE!,
});

const created = await spaces.folder.create("Reports");
if (!created.success) {
  console.error(created.error.code, created.error.message);
} else {
  console.log(created.status, created.data.path);
}

const found = await spaces.file.exists("Reports/hello.txt");
if (found.success && found.data.exists) {
  console.log(found.data.resource?.name, found.data.resource?.size);
}

const uploaded = await spaces.file.upload({
  folderName: "Reports",
  fileName: "hello.txt",
  fileContent: Buffer.from("Hello, OpenCloud!"),
});
if (!uploaded.success) console.error(uploaded.error);

// Reads return the file bytes directly, without response options.
try {
  const bytes = await spaces.file.read("Reports/hello.txt");
  console.log(bytes.toString("utf8"));
} catch (error) {
  if (error instanceof OpenCloudError) console.error(error.result);
  else throw error;
}
```

## Result contract

Every non-read method returns `{ success, status, data, error, warnings, requestId }`.
Check `success` to narrow the TypeScript result. Failure results have `data: null`;
success results have `error: null`. JSON results never include Axios request
objects or authentication configuration.

- `success` reflects the operation's outcome, so `exists()` succeeds only when
  the resource is actually there: `data.exists` is `true` with readable metadata
  in `data.resource`. A missing path is a `NOT_FOUND` failure.
- Existence checks are resource-type aware: a WebDAV path alone cannot tell a
  file from a folder, so `file.exists()` on a folder also fails with `NOT_FOUND`
  (and `folder.exists()` does the same for a file). `error.details` then reports
  `{ expected, actual }` so callers can see what the path actually is.
- Paths are URL-encoded and relative to the space root, such as `Reports/hello.txt`,
  without the dynamic DAV prefix or space ID.
- Mutations provide the affected `path`, `name`, `type`, `previousPath` (on rename),
  and converted server `body`. Even an empty `204` response is useful.
- Resource metadata includes name, type, byte size, ID, ETag, modification date,
  and content type. Raw WebDAV properties are omitted. Unavailable properties appear in
  `warnings`; missing metadata fields are nullable.
- HTTP/transport failures return stable error codes, readable messages, retry
  hints, and converted server details. They do not expose raw Axios errors.
- `file.read()` is the exception: it returns a Buffer and throws `OpenCloudError`
  on HTTP/transport failure. The error's `result` uses the same failure contract.
  Reading a folder path throws `RESOURCE_TYPE_MISMATCH` instead of returning a
  directory listing as if it were file content.

| Folder methods | File methods |
| --- | --- |
| `folder.exists(name)` | `file.exists(path)` |
| `folder.create(name)` | `file.upload({ folderName, fileName, fileContent })` |
| `folder.rename(oldName, newName)` | `file.rename(path, newName)` |
| `folder.delete(name)` | `file.delete(path)` |
| | `file.read(path)` |

XML is converted centrally. Response fields retain server data without requiring
callers to handle WebDAV XML prefixes for common metadata. Malformed or unsafe
metadata responses produce `INVALID_RESPONSE` with the original body retained.
See [response formats, edge cases, limits and migration notes](./RESPONSE_FORMAT.md).

## Development

```sh
npm ci
npm run check
```

`npm run check` builds both module formats and runs TypeScript, API-contract and
response-conversion checks. `npm run test:integration` runs the live localhost
suite using its test configuration. Test uploads are currently preserved for
manual inspection; deletion is disabled by `KEEP_TEST_RESOURCES`.

The current HTTPS agent is configured for local development with certificate
verification disabled. That transport setting must be secured before deploying
this package to production; the result contract does not change TLS behavior.

## License

[ISC](./LICENSE).
