import axios, {
  AxiosHeaders,
  isAxiosError,
  type AxiosInstance,
  type AxiosResponse,
  type AxiosRequestConfig,
} from "axios";
import https from "https";
import type { Buffer } from "node:buffer";
import { normalizeResponseData, type JsonData } from "./response.js";
import {
  OpenCloudError,
  axiosFailure,
  conversionFailure,
  failure,
  httpFailure,
  responseHeader,
  success,
  type FileDownload,
  type FileMetadata,
  type OpenCloudResult,
  type OpenCloudFailure,
  type ResourceChange,
  type ExistsData,
  type ResourceMetadata,
} from "./result.js";
import { existsResult, mutationResult } from "./webdav.js";

function responseContentType(headers: AxiosResponse["headers"]): string {
  if (headers instanceof AxiosHeaders)
    return String(headers.get("content-type") ?? "");
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "content-type",
  );
  return typeof entry?.[1] === "string" ? entry[1] : "";
}

// Encode each folder segment separately so nested paths remain usable.
function spaceRelativePath(folder: string, file?: string) {
  const segments = folder.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new TypeError("Folder paths must not contain '.' or '..' segments.");
  }
  return [...segments, ...(file === undefined ? [] : [file])]
    .map(encodeURIComponent)
    .join("/");
}

function resourcePath(space: string, folder: string, file?: string) {
  const relative = spaceRelativePath(folder, file);
  return `/dav/spaces/${encodeURIComponent(space)}${relative ? `/${relative}` : ""}`;
}

export interface UploadOptions {
  /** Destination folder relative to the space root; "" means root. */
  destination: string;
  fileName: string;
  buffer: Buffer;
  /** Replace an existing file. Defaults to true. */
  overwrite?: boolean;
  /** Check the destination and create missing folders, including parents, before uploading. Defaults to false. */
  ensureDestination?: boolean;
}
export class OpenCloudSpaces {
  private client: AxiosInstance;
  public folder: OpenCloudFolder;
  public file: OpenCloudFile;
  constructor(
    private apiKey: {
      base_url: string;
      user: string;
      token: string;
      space: string;
    },
  ) {
    this.client = axios.create({
      baseURL: this.apiKey.base_url,
      // Decode metadata centrally, preserving JSON null/numbers and XML charsets.
      responseType: "arraybuffer",
      auth: {
        username: this.apiKey.user,
        password: this.apiKey.token,
      },
      httpsAgent: new https.Agent({
        rejectUnauthorized: false, // Local development only
      }),
    });
    this.client.interceptors.response.use(
      (response) => {
        // Binary file downloads keep their original bytes, even for XML/JSON files.
        const binaryDownload =
          response.config.method?.toUpperCase() === "GET" &&
          response.config.responseType === "arraybuffer";
        if (!binaryDownload) {
          response.data = normalizeResponseData(
            response.data,
            responseContentType(response.headers),
          );
        }
        return response;
      },
      (error: unknown) => {
        if (isAxiosError(error) && error.response) {
          error.response.data = normalizeResponseData(
            error.response.data,
            responseContentType(error.response.headers),
          );
        }
        return Promise.reject(error);
      },
    );
    this.folder = new OpenCloudFolder(this.client, this.apiKey.space);
    this.file = new OpenCloudFile(this.client, this.apiKey.space);
  }
}

/** Run JSON endpoints without leaking Axios request/configuration objects. */
async function execute<T>(
  client: AxiosInstance,
  config: AxiosRequestConfig,
  project: (response: AxiosResponse<JsonData>) => OpenCloudResult<T>,
  missing?: T,
): Promise<OpenCloudResult<T>> {
  try {
    const response = await client.request<JsonData>(config);
    if (missing !== undefined && response.status === 404)
      return success(response, missing);
    if (response.status < 200 || response.status >= 300)
      return httpFailure(response);
    return conversionFailure(response) ?? project(response);
  } catch (error) {
    if (!isAxiosError<JsonData>(error)) throw error;
    if (missing !== undefined && error.response?.status === 404)
      return success(error.response, missing);
    return axiosFailure(error);
  }
}

/** Project download metadata from response headers, avoiding a second request. */
function fileMetadata(
  response: AxiosResponse<Buffer>,
  filePath: string,
): FileMetadata {
  const name = filePath.split("/").filter(Boolean).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const contentType = responseContentType(response.headers);
  const [media, ...parameters] = contentType.split(";");
  const charset = parameters
    .map((parameter) => /^\s*charset\s*=\s*"?([^";]+)"?/i.exec(parameter)?.[1])
    .find((value) => value !== undefined);
  return {
    name,
    path: spaceRelativePath(filePath),
    extension: dot > 0 ? name.slice(dot).toLowerCase() : null,
    mimeType: media?.trim() ? media.trim().toLowerCase() : null,
    charset: charset?.trim().toLowerCase() ?? null,
    id: responseHeader(response, "oc-fileid"),
    size: response.data.length,
    etag: responseHeader(response, "etag"),
    lastModified: responseHeader(response, "last-modified"),
  };
}

const DIRECTORY_CONTENT_TYPE = "httpd/unix-directory";

function isDirectoryResponse(response: AxiosResponse): boolean {
  return responseContentType(response.headers)
    .toLowerCase()
    .includes(DIRECTORY_CONTENT_TYPE);
}

/** PROPFIND a path and project its metadata, treating 404 as a clean "missing". */
function propfind(
  client: AxiosInstance,
  space: string,
  folder: string,
  file?: string,
): Promise<OpenCloudResult<ExistsData>> {
  const path = resourcePath(space, folder, file);
  const name = file ?? folder.split("/").filter(Boolean).at(-1) ?? "";
  return execute(
    client,
    { method: "PROPFIND", url: path, headers: { Depth: "0" } },
    (response) =>
      existsResult(response, path, name, spaceRelativePath(folder, file)),
    { exists: false, resource: null },
  );
}

/** Absence or a known different resource kind is a successful negative check. */
function existsAs(
  kind: "file" | "folder",
  result: OpenCloudResult<ExistsData>,
): OpenCloudResult<ExistsData> {
  if (!result.success) return result;
  const type = result.data.resource?.type;
  const found = result.data.exists && (type === kind || type === "unknown");
  if (found) return result;
  return { ...result, data: { exists: false, resource: null } };
}

class OpenCloudFolder {
  constructor(
    private client: AxiosInstance,
    private space: string,
  ) {}

  exists(folderName: string): Promise<OpenCloudResult<ExistsData>> {
    return propfind(this.client, this.space, folderName).then((result) =>
      existsAs("folder", result),
    );
  }

  create(folderName: string): Promise<OpenCloudResult<ResourceChange>> {
    return this.change("MKCOL", folderName);
  }

  delete(folderName: string): Promise<OpenCloudResult<ResourceChange>> {
    return this.change("DELETE", folderName);
  }

  rename(
    oldName: string,
    newName: string,
  ): Promise<OpenCloudResult<ResourceChange>> {
    return this.change("MOVE", oldName, newName);
  }

  private change(
    method: string,
    folderName: string,
    newName?: string,
  ): Promise<OpenCloudResult<ResourceChange>> {
    const path = resourcePath(this.space, folderName);
    const destination =
      newName === undefined ? path : resourcePath(this.space, newName);
    const name =
      (newName ?? folderName).split("/").filter(Boolean).at(-1) ?? "";
    const headers =
      method === "MOVE"
        ? { Destination: destination, "Content-Length": "0" }
        : method === "MKCOL"
          ? { "Content-Length": "0" }
          : {};
    return execute(this.client, { method, url: path, headers }, (response) =>
      mutationResult(response, {
        name,
        path: spaceRelativePath(newName ?? folderName),
        type: "folder",
        previousPath:
          newName === undefined ? null : spaceRelativePath(folderName),
        body: response.data,
      }),
    );
  }
}

class OpenCloudFile {
  constructor(
    private client: AxiosInstance,
    private space: string,
  ) {}

  /** Download original file bytes; failures throw OpenCloudError with a JSON result. */
  read(filePath: string): Promise<Buffer>;
  read(
    filePath: string,
    options: { withMetadata: true },
  ): Promise<FileDownload>;
  async read(
    filePath: string,
    options?: { withMetadata?: boolean },
  ): Promise<Buffer | FileDownload> {
    try {
      const response = await this.client.request<Buffer>({
        method: "GET",
        url: resourcePath(this.space, filePath),
        responseType: "arraybuffer",
      });
      // A GET on a collection yields a directory listing, never file bytes.
      if (isDirectoryResponse(response)) {
        throw new OpenCloudError(
          failure(
            response,
            "RESOURCE_TYPE_MISMATCH",
            `Expected a file at '${spaceRelativePath(filePath)}', but the server returned a folder.`,
            { expected: "file", actual: "folder" },
          ),
        );
      }
      return options?.withMetadata
        ? { bytes: response.data, resource: fileMetadata(response, filePath) }
        : response.data;
    } catch (error) {
      if (error instanceof OpenCloudError) throw error;
      if (!isAxiosError<JsonData>(error)) throw error;
      throw new OpenCloudError(axiosFailure(error));
    }
  }

  async upload({
    buffer,
    fileName,
    destination,
    overwrite = true,
    ensureDestination = false,
  }: UploadOptions): Promise<OpenCloudResult<ResourceChange>> {
    // Validate the complete path before creating any folders.
    resourcePath(this.space, destination, fileName);
    if (ensureDestination) {
      const failed = await this.ensureDestination(destination);
      if (failed) return failed;
    }
    const result = await this.change(
      "PUT", destination, fileName, undefined, buffer, overwrite,
    );
    if (!overwrite && !result.success && result.status === 412) {
      return {
        ...result,
        error: {
          ...result.error,
          code: "FILE_ALREADY_EXISTS",
          message: `A resource already exists at '${spaceRelativePath(destination, fileName)}'; overwrite is disabled.`,
        },
      };
    }
    return result;
  }

  private async ensureDestination(
    destination: string,
  ): Promise<OpenCloudFailure | null> {
    const segments = destination.split("/").filter(Boolean);
    const folders = new OpenCloudFolder(this.client, this.space);
    for (let index = 0; index < segments.length; index++) {
      const path = segments.slice(0, index + 1).join("/");
      let found = await propfind(this.client, this.space, path);
      if (!found.success) return found;
      if (!found.data.exists) {
        const created = await folders.create(path);
        if (created.success) continue;
        // Another client may have created the folder after our existence check.
        if (created.status !== 405 && created.status !== 409) return created;
        found = await propfind(this.client, this.space, path);
        if (!found.success) return found;
        if (!found.data.exists) return created;
      }
      if (found.data.resource?.type !== "folder") {
        return {
          ...found,
          success: false as const,
          data: null,
          error: {
            code: "RESOURCE_TYPE_MISMATCH",
            message: `Expected a folder at '${spaceRelativePath(path)}'.`,
            retryable: false,
            details: { expected: "folder", actual: found.data.resource?.type ?? null },
          },
        };
      }
    }
    return null;
  }

  delete(filePath: string): Promise<OpenCloudResult<ResourceChange>> {
    return this.change("DELETE", filePath);
  }

  rename(
    filePath: string,
    newFileName: string,
  ): Promise<OpenCloudResult<ResourceChange>> {
    return this.change("MOVE", filePath, undefined, newFileName);
  }

  exists(filePath: string): Promise<OpenCloudResult<ExistsData>> {
    return propfind(this.client, this.space, filePath).then((result) =>
      existsAs("file", result),
    );
  }

  /** Read file metadata without downloading content; absence returns NOT_FOUND. */
  async stat(filePath: string): Promise<OpenCloudResult<ResourceMetadata>> {
    const result = await propfind(this.client, this.space, filePath);
    if (!result.success) return result;
    const resource = result.data.resource;
    if (result.data.exists && resource && resource.type !== "folder") {
      return { ...result, data: resource };
    }
    const mismatch = result.data.exists;
    const failed = failure(
      undefined,
      mismatch ? "RESOURCE_TYPE_MISMATCH" : "NOT_FOUND",
      mismatch
        ? `Expected a file at '${spaceRelativePath(filePath)}', but the server reported a folder.`
        : `No file exists at '${spaceRelativePath(filePath)}'.`,
      mismatch ? { expected: "file", actual: resource?.type ?? null } : null,
    );
    return {
      ...failed,
      status: result.status,
      requestId: result.requestId,
      warnings: result.warnings,
    };
  }

  private change(
    method: string,
    folderName: string,
    fileName?: string,
    newName?: string,
    content?: Buffer,
    overwrite = true,
  ): Promise<OpenCloudResult<ResourceChange>> {
    const path = resourcePath(this.space, folderName, fileName);
    const parentFolder =
      fileName === undefined
        ? folderName.split("/").filter(Boolean).slice(0, -1).join("/")
        : folderName;
    const currentName =
      fileName ?? folderName.split("/").filter(Boolean).at(-1) ?? "";
    const destination =
      newName === undefined
        ? path
        : resourcePath(this.space, parentFolder, newName);
    const headers =
      method === "MOVE"
        ? { Destination: destination, "Content-Length": "0" }
        : method === "PUT"
          ? {
              "Content-Length": String(content!.length),
              "Content-Type": "application/octet-stream",
              ...(!overwrite ? { "If-None-Match": "*" } : {}),
            }
          : {};
    return execute(
      this.client,
      {
        method,
        url: path,
        headers,
        ...(content === undefined ? {} : { data: content }),
      },
      (response) =>
        mutationResult(response, {
          name: newName ?? currentName,
          path: spaceRelativePath(parentFolder, newName ?? currentName),
          type: "file",
          previousPath:
            newName === undefined
              ? null
              : spaceRelativePath(parentFolder, currentName),
          body: response.data,
        }),
    );
  }
}
