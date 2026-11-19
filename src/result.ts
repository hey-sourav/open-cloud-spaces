import { AxiosHeaders, type AxiosError, type AxiosResponse } from "axios";
import type { Buffer } from "node:buffer";
import {
  responseHasConversionFailure,
  type JsonData,
  type JsonValue,
} from "./response.js";

export interface OpenCloudWarning {
  code: string;
  message: string;
  status: number | null;
  property: string | null;
}

export interface OpenCloudErrorDetails {
  code: string;
  message: string;
  retryable: boolean;
  details: JsonData | null;
}

interface ResultMetadata {
  /** HTTP status; null when no HTTP response was received. */
  status: number | null;
  requestId: string | null;
  warnings: OpenCloudWarning[];
}

export interface OpenCloudSuccess<T> extends ResultMetadata {
  success: true;
  status: number;
  data: T;
  error: null;
}

export interface OpenCloudFailure extends ResultMetadata {
  success: false;
  data: null;
  error: OpenCloudErrorDetails;
}

/** Discriminated union: check success before accessing data or error. */
export type OpenCloudResult<T> = OpenCloudSuccess<T> | OpenCloudFailure;

export interface ResourceMetadata {
  name: string;
  /** Encoded path relative to the space root, without a leading slash. */
  path: string;
  type: "folder" | "file" | "unknown";
  id: string | null;
  size: number | null;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
}

export interface ExistsData {
  exists: boolean;
  resource: ResourceMetadata | null;
}

/** Metadata derived from a download response, without a second request. */
export interface FileMetadata {
  name: string;
  /** Encoded path relative to the space root, without a leading slash. */
  path: string;
  /** Lowercase extension including the dot, such as ".txt"; null when absent. */
  extension: string | null;
  /** Media type without parameters, such as "text/plain". */
  mimeType: string | null;
  /** Charset from the content type, such as "utf-8". */
  charset: string | null;
  id: string | null;
  /** Byte length of the downloaded content. */
  size: number;
  etag: string | null;
  lastModified: string | null;
}

export interface FileDownload {
  bytes: Buffer;
  resource: FileMetadata;
}

export interface ResourceChange {
  name: string;
  /** Encoded path relative to the space root, without a leading slash. */
  path: string;
  type: "folder" | "file";
  previousPath: string | null;
  /** Converted server body; usually {} for successful mutations. */
  body: JsonData;
}

/** Only file.read() throws this for HTTP/transport failures; other APIs return results. */
export class OpenCloudError extends Error {
  readonly result: OpenCloudFailure;
  constructor(result: OpenCloudFailure) {
    super(result.error.message);
    this.name = "OpenCloudError";
    this.result = result;
  }
  get code() {
    return this.result.error.code;
  }
  get status() {
    return this.result.status;
  }
  toJSON() {
    return this.result;
  }
}

export function responseHeader(
  response: AxiosResponse,
  name: string,
): string | null {
  const headers = response.headers;
  const value =
    headers instanceof AxiosHeaders
      ? headers.get(name)
      : Object.entries(headers).find(
          ([key]) => key.toLowerCase() === name.toLowerCase(),
        )?.[1];
  return typeof value === "string" ? value : null;
}

export function success<T>(
  response: AxiosResponse,
  data: T,
  warnings: OpenCloudWarning[] = [],
): OpenCloudSuccess<T> {
  return {
    success: true,
    status: response.status,
    data,
    error: null,
    warnings,
    requestId:
      responseHeader(response, "x-request-id") ??
      responseHeader(response, "oc-request-id"),
  };
}

export function failure(
  response: AxiosResponse | undefined,
  code: string,
  message: string,
  details: JsonData | null,
  retryable = false,
): OpenCloudFailure {
  return {
    success: false,
    status: response?.status ?? null,
    data: null,
    error: { code, message, retryable, details },
    warnings: [],
    requestId: response
      ? (responseHeader(response, "x-request-id") ??
        responseHeader(response, "oc-request-id"))
      : null,
  };
}

function serverMessage(value: JsonValue, depth = 0): string | null {
  if (depth > 8 || !value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (
      key.split(":").at(-1)?.toLowerCase() === "message" &&
      typeof child === "string" &&
      child.length <= 500
    )
      return child;
  }
  for (const child of Object.values(value)) {
    const message = serverMessage(child, depth + 1);
    if (message) return message;
  }
  return null;
}

export function httpFailure(
  response: AxiosResponse<JsonData>,
  status = response.status,
  details: JsonData = response.data,
): OpenCloudFailure {
  const codes: Record<number, string> = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    408: "TIMEOUT",
    409: "CONFLICT",
    412: "PRECONDITION_FAILED",
    413: "PAYLOAD_TOO_LARGE",
    422: "VALIDATION_ERROR",
    423: "LOCKED",
    429: "RATE_LIMITED",
  };
  const message =
    serverMessage(details) ?? `OpenCloud request failed (HTTP ${status}).`;
  const result = failure(
    response,
    codes[status] ?? (status >= 500 ? "SERVER_ERROR" : "HTTP_ERROR"),
    message,
    details,
    [408, 429, 500, 502, 503, 504].includes(status),
  );
  // For 207 inner failures keep the outer HTTP status; the inner status is explicit.
  if (status !== response.status)
    result.error.details = { status, body: details };
  return result;
}

export function axiosFailure(error: AxiosError<JsonData>): OpenCloudFailure {
  if (error.response) return httpFailure(error.response);
  const code =
    error.code === "ERR_CANCELED"
      ? "CANCELED"
      : ["ECONNABORTED", "ETIMEDOUT"].includes(error.code ?? "")
        ? "TIMEOUT"
        : "NETWORK_ERROR";
  const message =
    code === "CANCELED"
      ? "OpenCloud request was canceled."
      : code === "TIMEOUT"
        ? "OpenCloud request timed out."
        : "Unable to connect to OpenCloud.";
  return failure(
    undefined,
    code,
    message,
    error.code ? { transportCode: error.code } : null,
    code !== "CANCELED",
  );
}

export function conversionFailure(
  response: AxiosResponse<JsonData>,
): OpenCloudFailure | null {
  const body = response.data;
  if (responseHasConversionFailure(body)) {
    return failure(
      response,
      "INVALID_RESPONSE",
      "OpenCloud returned a body that could not be safely converted.",
      body,
    );
  }
  return null;
}
