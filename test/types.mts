import { OpenCloudSpaces } from "open-cloud-spaces";
const spaces = new OpenCloudSpaces({ base_url: "https://example.invalid", user: "admin", token: "token", space: "space" });
void spaces.folder.exists("folder");
void spaces.folder.create("folder");
void spaces.folder.rename("folder", "new-folder");
void spaces.folder.delete("folder");
void spaces.file.upload({ folderName: "folder", fileName: "file", fileContent: Buffer.from("hello") });
const bytes: Buffer = await spaces.file.read("folder/file");
void bytes;
void spaces.file.exists("folder/file");
void spaces.file.rename("folder/old", "new");
void spaces.file.delete("folder/file");
// @ts-expect-error Uploads require a Buffer.
void spaces.file.upload({ folderName: "folder", fileName: "file", fileContent: "hello" });
// @ts-expect-error Folder names must be strings.
void spaces.folder.exists(123);

// @ts-expect-error File reads no longer accept response options.
void spaces.file.read("folder/file", { responseType: "arraybuffer" });

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
