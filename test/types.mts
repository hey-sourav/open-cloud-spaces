import { OpenCloudSpaces, type FileDownload, type UploadOptions, type ResourceMetadata } from "open-cloud-spaces";
const spaces = new OpenCloudSpaces({ base_url: "https://example.invalid", user: "admin", token: "token", space: "space" });
void spaces.folder.exists("folder");
void spaces.folder.create("folder");
void spaces.folder.rename("folder", "new-folder");
void spaces.folder.delete("folder");
void spaces.file.upload({ destination: "folder", fileName: "file", buffer: Buffer.from("hello") });
const uploadOptions: UploadOptions = { destination: "folder", fileName: "file", buffer: Buffer.from("hello"), overwrite: false, ensureDestination: true };
void spaces.file.upload(uploadOptions);
// @ts-expect-error overwrite must be a boolean.
void spaces.file.upload({ ...uploadOptions, overwrite: "false" });
// @ts-expect-error ensureDestination must be a boolean.
void spaces.file.upload({ ...uploadOptions, ensureDestination: "true" });
const bytes: Buffer = await spaces.file.read("folder/file");
void bytes;
void spaces.file.exists("folder/file");
const stat = await spaces.file.stat("folder/file");
if (stat.success) {
  const metadata: ResourceMetadata = stat.data;
  void metadata;
}
void spaces.file.rename("folder/old", "new");
void spaces.file.delete("folder/file");
// @ts-expect-error Uploads require a Buffer.
void spaces.file.upload({ destination: "folder", fileName: "file", buffer: "hello" });
// @ts-expect-error Folder names must be strings.
void spaces.folder.exists(123);

// @ts-expect-error File reads do not accept arbitrary Axios response options.
void spaces.file.read("folder/file", { responseType: "arraybuffer" });

const download: FileDownload = await spaces.file.read("folder/file", { withMetadata: true });
const downloadedBytes: Buffer = download.bytes;
const extension: string | null = download.resource.extension;
const mimeType: string | null = download.resource.mimeType;
const charset: string | null = download.resource.charset;
const downloadSize: number = download.resource.size;
void [downloadedBytes, extension, mimeType, charset, downloadSize];

// @ts-expect-error withMetadata must be literal true, not an arbitrary boolean toggle.
void spaces.file.read("folder/file", { withMetadata: false });

const existence = await spaces.folder.exists("folder");
if (existence.success) {
  const found: boolean = existence.data.exists;
  const kind: "folder" | "file" | "unknown" | undefined = existence.data.resource?.type;
  void [found, kind];
} else {
  const code: string = existence.error.code;
  const retryable: boolean = existence.error.retryable;
  void [code, retryable];
  // @ts-expect-error Failure results have null data.
  void existence.data.exists;
}
const created = await spaces.folder.create("folder");
if (created.success) {
  const path: string = created.data.path;
  void path;
}
