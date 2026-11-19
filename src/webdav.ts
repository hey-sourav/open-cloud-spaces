import type { AxiosResponse } from "axios";
import type { JsonData, JsonValue } from "./response.js";
import { failure, httpFailure, success, type ExistsData, type OpenCloudResult, type OpenCloudWarning, type ResourceMetadata, type ResourceChange } from "./result.js";

type ObjectValue = { [key: string]: JsonValue };
type Namespaces = Record<string, string>;
type Element = { value: JsonValue; namespaces: Namespaces };
function object(value: JsonValue | undefined): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function namespaces(value: JsonValue, inherited: Namespaces): Namespaces {
  const result = { ...inherited };
  for (const [key, uri] of Object.entries(object(value) ?? {})) {
    if (typeof uri === "string" && (key === "@_xmlns" || key.startsWith("@_xmlns:"))) {
      Object.defineProperty(result, key === "@_xmlns" ? "" : key.slice(8), { value: uri, enumerable: true, configurable: true, writable: true });
    }
  }
  return result;
}
function children(parent: JsonValue, local: string, inherited: Namespaces, uri = "DAV:"): Element[] {
  const matches: Element[] = [];
  for (const [key, value] of Object.entries(object(parent) ?? {})) {
    if (key.startsWith("@_") || key === "#text" || key.split(":").at(-1) !== local) continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      const scope = namespaces(child, inherited);
      const prefix = key.includes(":") ? key.split(":")[0]! : "";
      if (scope[prefix] === uri || (!prefix && !scope[prefix])) matches.push({ value: child, namespaces: scope });
    }
  }
  return matches;
}
function first(parent: JsonValue, name: string, scope: Namespaces, uri = "DAV:") {
  return children(parent, name, scope, uri)[0];
}
function text(value: JsonValue | undefined): string | null {
  if (typeof value === "string") return value;
  const node = object(value);
  return typeof node?.["#text"] === "string" ? node["#text"] : null;
}
function status(value: JsonValue | undefined): number | null {
  const match = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s|$)/i.exec(text(value)?.trim() ?? "");
  const code = match ? Number(match[1]) : 0;
  return code >= 100 && code <= 599 ? code : null;
}
function canonical(path: string): string {
  try { return decodeURIComponent(new URL(path, "https://dav.invalid").pathname).replace(/\/$/, ""); }
  catch { return path.replace(/\/$/, ""); }
}
function bytes(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

/** A mutation's 207 is not successful if any reported child operation failed. */
export function mutationResult(response: AxiosResponse<JsonData>, data: ResourceChange): OpenCloudResult<ResourceChange> {
  if (response.status !== 207) return success(response, data);
  const roots = children(response.data, "multistatus", {});
  const entries = roots.length === 1 ? children(roots[0]!.value, "response", roots[0]!.namespaces) : [];
  if (!entries.length) return failure(response, "INVALID_RESPONSE", "Unrecognized WebDAV mutation status response.", response.data);
  for (const entry of entries) {
    const direct = first(entry.value, "status", entry.namespaces);
    const groups = children(entry.value, "propstat", entry.namespaces);
    const codes = [
      ...(direct ? [status(direct.value)] : []),
      ...groups.map((group) => status(first(group.value, "status", group.namespaces)?.value)),
    ];
    if (!codes.length || codes.some((code) => code === null)) return failure(response, "INVALID_RESPONSE", "Incomplete WebDAV mutation status information.", response.data);
    if (codes.some((code) => code! < 200 || code! >= 300)) {
      return failure(response, "PARTIAL_FAILURE", "One or more WebDAV resource operations failed. Inspect the details before retrying.", response.data);
    }
  }
  return success(response, data);
}

/** Project WebDAV properties by namespace URI rather than a hardcoded prefix. */
export function existsResult(response: AxiosResponse<JsonData>, path: string, name: string, relativePath: string): OpenCloudResult<ExistsData> {
  const invalid = (reason: string) => failure(response, "INVALID_RESPONSE", reason, response.data);
  if (response.status !== 207) return invalid("Expected a WebDAV 207 response for an existence check.");
  const roots = children(response.data, "multistatus", {});
  if (roots.length !== 1) return invalid("OpenCloud returned an unrecognized WebDAV response structure.");
  const root = roots[0]!;
  const entries = children(root.value, "response", root.namespaces);
  const matching = entries.filter((entry) => canonical(text(first(entry.value, "href", entry.namespaces)?.value) ?? "") === canonical(path));
  const selected = entries.length === 1 ? entries[0] : matching.length === 1 ? matching[0] : undefined;
  if (!selected) return invalid("WebDAV response does not identify the requested resource.");
  const scope = selected.namespaces;
  const resourceStatus = status(first(selected.value, "status", scope)?.value);
  if (resourceStatus === 404) return success(response, { exists: false, resource: null });
  if (resourceStatus !== null && (resourceStatus < 200 || resourceStatus >= 300)) return httpFailure(response, resourceStatus);
  const groups = children(selected.value, "propstat", scope);
  if (!groups.length) return invalid("WebDAV response has no property status information.");
  const properties: ObjectValue = {};
  const warnings: OpenCloudWarning[] = [];
  const successful: Element[] = [];
  let firstFailedStatus: number | null = null;
  for (const group of groups) {
    const code = status(first(group.value, "status", group.namespaces)?.value);
    if (code === null) return invalid("WebDAV property group has an invalid or missing status.");
    const prop = first(group.value, "prop", group.namespaces);
    if (!prop) return invalid("WebDAV property group has no properties element.");
    if (!object(prop.value) && prop.value !== "") return invalid("WebDAV properties have an unexpected structure.");
    if (code >= 200 && code < 300) {
      successful.push(prop);
      for (const [key, value] of Object.entries(object(prop.value) ?? {})) {
        if (Object.hasOwn(properties, key) && JSON.stringify(properties[key]) !== JSON.stringify(value)) {
          return invalid("WebDAV returned conflicting values for the same property.");
        }
        Object.defineProperty(properties, key, { value, enumerable: true, configurable: true, writable: true });
      }
    } else {
      firstFailedStatus ??= code;
      const names = Object.keys(object(prop.value) ?? {}).filter((key) => !key.startsWith("@_"));
      for (const property of names.length ? names : [null]) warnings.push({ code: "PROPERTY_UNAVAILABLE", message: "A WebDAV property could not be retrieved.", status: code, property });
    }
  }
  if (!successful.length) {
    const result = firstFailedStatus === 404 ? invalid("WebDAV returned only unavailable properties; resource existence could not be confirmed.") : httpFailure(response, firstFailedStatus ?? 500);
    result.warnings = warnings;
    return result;
  }
  function property(local: string, uri = "DAV:"): Element | undefined {
    for (const group of successful) {
      const value = first(group.value, local, group.namespaces, uri);
      if (value) return value;
    }
    return undefined;
  }
  const resourceType = property("resourcetype");
  const kind = resourceType ? (first(resourceType.value, "collection", resourceType.namespaces) ? "folder" : "file") : "unknown";
  const size = bytes(text(property("getcontentlength")?.value) ?? text(property("size", "http://owncloud.org/ns")?.value));
  if (kind === "unknown") warnings.push({ code: "MISSING_RESOURCE_TYPE", message: "The server did not provide the resource type.", status: null, property: "resourcetype" });
  if (size === null && (property("getcontentlength") || property("size", "http://owncloud.org/ns"))) {
    warnings.push({ code: "INVALID_PROPERTY_VALUE", message: "Resource size is unavailable or outside safe numeric precision.", status: null, property: "size" });
  }
  const resource: ResourceMetadata = {
    name: text(property("displayname")?.value) ?? name,
    path: relativePath,
    type: kind,
    id: text(property("id", "http://owncloud.org/ns")?.value),
    size,
    etag: text(property("getetag")?.value),
    lastModified: text(property("getlastmodified")?.value),
    contentType: text(property("getcontenttype")?.value),
  };
  return success(response, { exists: true, resource }, warnings);
}
