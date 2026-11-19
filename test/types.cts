import sdk = require("open-cloud-spaces");
const spaces = new sdk.OpenCloudSpaces({ base_url: "https://example.invalid", user: "admin", token: "token", space: "space" });
void spaces.file.read("folder/file");
void spaces.folder.create("folder");
// @ts-expect-error File names must be strings.
void spaces.file.exists(123);
