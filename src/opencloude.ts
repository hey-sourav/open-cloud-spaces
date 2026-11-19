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
  success,
  type OpenCloudResult,
  type ResourceChange,
  type ExistsData,
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

/**
 * `success` reflects the operation's outcome, so a resource that is absent — or
 * present as the other kind, which a WebDAV path alone cannot distinguish — is a
 * NOT_FOUND failure rather than a successful "exists: false".
 */
function existsAs(
  kind: "file" | "folder",
  relativePath: string,
  result: OpenCloudResult<ExistsData>,
): OpenCloudResult<ExistsData> {
  if (!result.success) return result;
  const type = result.data.resource?.type;
  const found =
    result.data.exists && (type === kind || type === "unknown");
  if (found) return result;
  const missing = failure(
    undefined,
    "NOT_FOUND",
    result.data.exists
      ? `Expected a ${kind} at '${relativePath}', but the server reported a ${type}.`
      : `No ${kind} exists at '${relativePath}'.`,
    result.data.exists ? { expected: kind, actual: type ?? null } : null,
  );
  missing.status = result.status;
  missing.requestId = result.requestId;
  missing.warnings = result.warnings;
  return missing;
}

class OpenCloudFolder {
  constructor(
    private client: AxiosInstance,
    private space: string,
  ) {}

  exists(folderName: string): Promise<OpenCloudResult<ExistsData>> {
    return propfind(this.client, this.space, folderName).then((result) =>
      existsAs("folder", spaceRelativePath(folderName), result),
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
  async read(filePath: string): Promise<Buffer> {
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
      return response.data;
    } catch (error) {
      if (error instanceof OpenCloudError) throw error;
      if (!isAxiosError<JsonData>(error)) throw error;
      throw new OpenCloudError(axiosFailure(error));
    }
  }

  upload({
    fileContent,
    fileName,
    folderName,
  }: {
    folderName: string;
    fileName: string;
    fileContent: Buffer;
  }): Promise<OpenCloudResult<ResourceChange>> {
    return this.change("PUT", folderName, fileName, undefined, fileContent);
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
      existsAs("file", spaceRelativePath(filePath), result),
    );
  }

  private change(
    method: string,
    folderName: string,
    fileName?: string,
    newName?: string,
    content?: Buffer,
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
