import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OpenCloudSpaces, OpenCloudError } from "../dist/index.js";

// Temporarily keep uploads for manual inspection. Set false to test deletion.
const KEEP_TEST_RESOURCES = true;

/** Exercise the lifecycle, retaining resources while KEEP_TEST_RESOURCES is true. */
export async function testOpenCloudSpaces(config, { specialNames = false } = {}) {
  for (const key of ["base_url", "user", "token", "space"]) {
    assert.ok(config[key], `Missing OpenCloudSpaces configuration: ${key}`);
  }

  const spaces = new OpenCloudSpaces(config);
  const folder = `sdk-test-${randomUUID()}${specialNames ? " नमस्ते #100% &" : ""}`;
  const renamedFolder = `${folder}-renamed`;
  const file = specialNames ? "hello नमस्ते #100%.txt" : "hello.txt";
  const renamedFile = specialNames ? "renamed नमस्ते #100%.txt" : "hello-renamed.txt";
  const content = Buffer.from("OpenCloudSpaces round trip — नमस्ते!\n", "utf8");
  const cleanupFolders = new Set();
  let currentStep = "Initial folder";
  let requestNumber = 0;
  const requests = new WeakMap();
  let expectedStatuses;
  const responses = [];
  const methodStatuses = {
    PROPFIND: [207], MKCOL: [201], PUT: [201, 204],
    GET: [200], MOVE: [201, 204], DELETE: [204],
  };

  function log(details) {
    console.log(JSON.stringify(details, (_key, value) =>
      typeof value === "string"
        ? value.replaceAll(config.token, "[REDACTED]")
        : value, 2));
  }

  // Observe Axios directly because some class methods return only response.data.
  // TypeScript's private client field is accessible in this JavaScript test.
  spaces.client.interceptors.request.use((requestConfig) => {
    const context = {
      id: ++requestNumber, step: currentStep,
      expectedStatuses: expectedStatuses ?? methodStatuses[requestConfig.method?.toUpperCase()],
    };
    requests.set(requestConfig, context);
    log({
      ...context,
      event: "request",
      method: requestConfig.method?.toUpperCase(),
      url: spaces.client.getUri(requestConfig),
      body: Buffer.isBuffer(requestConfig.data)
        ? requestConfig.data.toString("utf8")
        : requestConfig.data ?? null,
    });
    return requestConfig;
  });
  function reportResponse(response, error) {
    const context = requests.get(response?.config ?? error?.config ?? {}) ?? {};
    const status = response?.status ?? null;
    const expected = context.expectedStatuses?.includes(status) ?? false;
    if (response) {
      const binaryDownload = !error && response.config.method?.toUpperCase() === "GET"
        && response.config.responseType === "arraybuffer";
      if (binaryDownload) {
        assert.ok(Buffer.isBuffer(response.data), "Binary file data must remain a Buffer");
      } else {
        assert.ok(response.data !== null && typeof response.data === "object", "Response data must be a JSON object or array");
        assert.ok(!Buffer.isBuffer(response.data), "API response data must be normalized to JSON");
        assert.doesNotThrow(() => JSON.stringify(response.data));
      }
    }
    const details = {
      ...context, event: "response", success: !error,
      outcome: expected ? "expected" : "unexpected",
      status, statusText: response?.statusText ?? null,
      data: response?.data ?? null,
      ...(error ? { error: { code: error.code ?? null, message: error.message } } : {}),
    };
    responses.push(details);
    log(details);
    return expected;
  }
  spaces.client.interceptors.response.use(
    (response) => {
      const expected = reportResponse(response);
      assert.ok(expected, `${currentStep}: unexpected HTTP ${response.status}`);
      return response;
    },
    (error) => {
      reportResponse(error.response, error);
      return Promise.reject(error);
    },
  );

  // Avoid printing raw Axios errors, which include authentication headers.
  async function request(label, operation) {
    currentStep = label;
    expectedStatuses = undefined;
    try {
      const result = await operation();
      if (!Buffer.isBuffer(result)) {
        assert.equal(result.success, true, `${label}: ${JSON.stringify(result.error)}`);
        assert.equal(result.error, null);
        assert.doesNotThrow(() => JSON.stringify(result));
        log({ event: "result", step: label, result });
      }
      return result;
    } catch (error) {
      throw new Error(
        `${label}: ${error.response?.status ?? error.code ?? "request failed"}`,
      );
    }
  }

  async function assertMissing(label, operation) {
    currentStep = label;
    expectedStatuses = [404];
    try {
      const result = await operation();
      assert.equal(result.success, true, `${label}: ${JSON.stringify(result.error)}`);
      assert.deepEqual(result.data, { exists: false, resource: null }, `${label}: resource still exists`);
      assert.equal(result.error, null);
      assert.equal(result.status, 404);
    } catch (error) {
      // File reads return bytes and throw a typed error when the file is absent.
      if (!(error instanceof OpenCloudError)) throw error;
      assert.equal(error.status, 404, `${label}: expected HTTP 404`);
    }
  }

  try {
    await assertMissing("Initial folder", () => spaces.folder.exists(folder));
    cleanupFolders.add(folder);
    await request("Create folder", () => spaces.folder.create(folder));
    const folderResponse = await request("Check folder", () =>
      spaces.folder.exists(folder),
    );
    assert.equal(folderResponse.status, 207, "PROPFIND should return HTTP 207");
    assert.equal(folderResponse.data.exists, true);
    assert.equal(folderResponse.data.resource.type, "folder");

    await assertMissing("Initial file", () => spaces.file.exists(`${folder}/${file}`));
    await request("Upload file", () =>
      spaces.file.upload({
        destination: folder,
        fileName: file,
        buffer: content,
      }),
    );
    const fileResponse = await request("Check file", () =>
      spaces.file.exists(`${folder}/${file}`),
    );
    assert.equal(fileResponse.status, 207);
    assert.equal(fileResponse.data.exists, true);
    assert.equal(fileResponse.data.resource.type, "file");
    assert.equal(fileResponse.data.resource.size, content.length);
    const read = await request("Read file", () =>
      spaces.file.read(`${folder}/${file}`),
    );
    assert.equal(
      read.toString("utf8"),
      content.toString("utf8"),
      "Uploaded bytes must round trip",
    );

    await request("Rename file", () =>
      spaces.file.rename(`${folder}/${file}`, renamedFile),
    );
    await assertMissing("Old file name", () =>
      spaces.file.exists(`${folder}/${file}`),
    );
    await request("Check renamed file", () =>
      spaces.file.exists(`${folder}/${renamedFile}`),
    );
    const renamedRead = await request("Read renamed file", () =>
      spaces.file.read(`${folder}/${renamedFile}`),
    );
    assert.equal(renamedRead.toString("utf8"), content.toString("utf8"));

    cleanupFolders.add(renamedFolder);
    await request("Rename folder", () =>
      spaces.folder.rename(folder, renamedFolder),
    );
    await assertMissing("Old folder name", () => spaces.folder.exists(folder));
    await request("Check renamed folder", () =>
      spaces.folder.exists(renamedFolder),
    );
    const movedRead = await request("Read file in renamed folder", () =>
      spaces.file.read(`${renamedFolder}/${renamedFile}`),
    );
    assert.equal(movedRead.toString("utf8"), content.toString("utf8"));

    const binary = Buffer.from([0, 255, 128, 13, 10, 1, 254]);
    await request("Upload binary file", () => spaces.file.upload({
      destination: renamedFolder, fileName: "binary.bin", buffer: binary,
    }));
    const binaryRead = await request("Read binary file", () =>
      spaces.file.read(`${renamedFolder}/binary.bin`),
    );
    assert.deepEqual(binaryRead, binary);

    for (const [fileName, fileContent] of [
      ["sample.xml", '<example><message>Hello</message><code>001</code></example>'],
      ["sample.json", '{"message":"Hello","ok":true}'],
    ]) {
      await request(`Upload ${fileName}`, () => spaces.file.upload({
        destination: renamedFolder, fileName, buffer: Buffer.from(fileContent),
      }));
      const result = await request(`Read ${fileName} original bytes`, () => spaces.file.read(`${renamedFolder}/${fileName}`));
      assert.deepEqual(result, Buffer.from(fileContent));
      if (!KEEP_TEST_RESOURCES) {
        await request(`Delete ${fileName}`, () => spaces.file.delete(`${renamedFolder}/${fileName}`));
      }
    }

    if (!KEEP_TEST_RESOURCES) {
      await request("Delete binary file", () => spaces.file.delete(`${renamedFolder}/binary.bin`));
      await request("Delete file", () =>
        spaces.file.delete(`${renamedFolder}/${renamedFile}`),
      );
      await assertMissing("Deleted file", () =>
        spaces.file.exists(`${renamedFolder}/${renamedFile}`),
      );
      await assertMissing("Read deleted file", () =>
        spaces.file.read(`${renamedFolder}/${renamedFile}`),
      );
      await request("Delete folder", () => spaces.folder.delete(renamedFolder));
      await assertMissing("Deleted folder", () =>
        spaces.folder.exists(renamedFolder),
      );
    }
  } finally {
    log({ event: "response-summary", responses: responses.map(({ step, status, outcome }) => ({ step, status, outcome })) });
    if (KEEP_TEST_RESOURCES) {
      log({
        event: "resources-preserved",
        message: "Deletion and cleanup are disabled for manual inspection.",
        folder: renamedFolder,
        file: renamedFile,
        possibleFolders: [...cleanupFolders],
        url: `${config.base_url.replace(/\/$/, "")}/dav/spaces/${[config.space, renamedFolder, renamedFile].map(encodeURIComponent).join("/")}`,
      });
    } else {
      // Try both names: a MOVE may succeed even if its response is lost.
      const failures = [];
      for (const name of cleanupFolders) {
        currentStep = `Cleanup folder ${name}`;
        expectedStatuses = [204, 404];
        try {
          const result = await spaces.folder.delete(name);
        if (!result.success && result.status !== 404) failures.push(`${name}: ${result.error.code}`);
        } catch (error) {
          if (error.response?.status !== 404) {
            failures.push(
              `${name}: ${error.response?.status ?? error.code ?? "request failed"}`,
            );
          }
        }
      }
      assert.equal(failures.length, 0, `Cleanup failed: ${failures.join("; ")}`);
    }
  }
}

for (const specialNames of [false, true]) {
  test(
  `OpenCloudSpaces: ${specialNames ? "special names" : "standard names"} (${KEEP_TEST_RESOURCES ? "deletion disabled" : "including deletion"})`,
  async () => {
    await testOpenCloudSpaces({
      base_url: "https://localhost:9200",
      user: "admin",
      token: "outflank lavish cone acutely mankind slam",
      space: "a5e65938-80b8-4be8-b46c-1c50c21e49ad$c8857d73-5dde-4938-9b3e-62b1822dc803",
    }, { specialNames });
  },
);
}
