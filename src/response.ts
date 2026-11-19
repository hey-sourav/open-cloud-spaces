import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { XMLParser, type X2jOptions } from "fast-xml-parser";
import { SyntaxValidator } from "fast-xml-validator";
import { EntityDecoder } from "@nodable/entities";

export type JsonValue = string | number | boolean | null | JsonData;
export type JsonData = { [key: string]: JsonValue } | JsonValue[];

// Track diagnostics out of band so ordinary JSON fields named parseError cannot
// collide with the client's own conversion failures. No marker is serialized.
const conversionFailures = new WeakSet<JsonData>();
export function responseHasConversionFailure(data: JsonData): boolean {
  return conversionFailures.has(data);
}

function conversionDiagnostic(data: JsonData): JsonData {
  conversionFailures.add(data);
  return data;
}

// Limits apply to structured conversion, never to successful file downloads.
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 128;
const MAX_NODES = 100_000;
const xmlOptions: X2jOptions = {
  ignoreAttributes: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  // Attributes called "response" must remain strings.
  isArray: (name, _path, _leaf, attribute) => !attribute && /^(?:[^:]+:)?(?:response|propstat)$/.test(name),
};

function asObject(value: JsonValue): JsonData {
  return value !== null && typeof value === "object" ? value : { value };
}

function fallback(content: string, format: string, parseError: string): JsonData {
  return conversionDiagnostic({ content, format, parseError });
}

/** Clone without invoking getters/toJSON; reject data that cannot safely be JSON. */
function jsonValue(input: unknown): JsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  function visit(value: unknown, depth: number): JsonValue {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("Structured response exceeds conversion limits.");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        throw new Error("A JSON number exceeds safe numeric precision; the original body was retained.");
      }
      return value;
    }
    if (typeof value !== "object" || value === null) throw new Error("Unsupported non-JSON response value.");
    if (ancestors.has(value)) throw new Error("Circular response data cannot be converted to JSON.");
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      throw new Error("Unsupported response object type.");
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > MAX_NODES) throw new Error("Structured response exceeds conversion limits.");
        return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) return null;
        if (!('value' in descriptor)) throw new Error("Response accessors are not supported.");
        return visit(descriptor.value, depth + 1);
        });
      }
      const result: { [key: string]: JsonValue } = {};
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor)) throw new Error("Response accessors are not supported.");
        // Defining an own property also safely preserves a literal __proto__ key.
        Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  }
  return visit(input, 0);
}

/** Bound JSON nesting before JSON.parse allocates its object tree. */
function checkJsonDepth(text: string) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (++depth > MAX_DEPTH) throw new Error("JSON nesting exceeds conversion limits.");
    } else if (char === "}" || char === "]") depth--;
  }
}

/** Check XML depth before invoking recursive parsers, respecting comments/CDATA. */
function inspectXml(text: string): boolean {
  const stack: { child: boolean; text: boolean; preserveSpace: boolean }[] = [];
  let nodes = 0;
  let mixed = false;
  let index = 0;
  function markText(value: string) {
    const node = stack[stack.length - 1];
    if (node && value.length && (value.trim() || node.preserveSpace)) node.text = true;
  }
  while (index < text.length) {
    const start = text.indexOf("<", index);
    if (start < 0) break;
    markText(text.slice(index, start));
    if (text.startsWith("<!--", start) || text.startsWith("<![CDATA[", start) || text.startsWith("<?", start)) {
      const cdata = text.startsWith("<![CDATA[", start);
      const marker = cdata ? "]]>" : text.startsWith("<!--", start) ? "-->" : "?>";
      const end = text.indexOf(marker, start + (cdata ? 9 : marker === "-->" ? 4 : 2));
      if (end < 0) throw new Error("Unterminated XML comment, CDATA or processing instruction.");
      if (cdata) markText(text.slice(start + 9, end));
      index = end + marker.length;
      continue;
    }
    if (/^<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text.slice(start, start + 16))) {
      throw new Error("XML declarations containing DTDs or entities are not supported.");
    }
    let end = start + 1;
    let quote = "";
    for (; end < text.length; end++) {
      const char = text[end]!;
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end === text.length) throw new Error("Unterminated XML tag.");
    const token = text.slice(start, end + 1);
    if (token.startsWith("</")) {
      const node = stack.pop();
      if (node?.child && node.text) mixed = true;
    } else if (!token.startsWith("<!")) {
      if (++nodes > MAX_NODES || stack.length + 1 > MAX_DEPTH) throw new Error("XML structure exceeds conversion limits.");
      if (stack.length) stack[stack.length - 1]!.child = true;
      let space: string | undefined;
      for (const attribute of token.matchAll(/([^\s=<>/]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
        if (attribute[1] === "xml:space") space = attribute[3] ?? attribute[4];
      }
      const preserveSpace = space === "preserve" || (space === undefined && (stack[stack.length - 1]?.preserveSpace ?? false));
      if (!/\/\s*>$/.test(token)) stack.push({ child: false, text: false, preserveSpace });
    }
    index = end + 1;
  }
  return mixed;
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
  const declaration = /^\s*<\?xml\b[^?]*encoding\s*=\s*["']([^"']+)["']/i.exec(Buffer.from(bytes.subarray(0, 256)).toString("ascii"))?.[1];
  let encoding = charset ?? declaration ?? "utf-8";
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) encoding = "utf-8";
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  else if (bytes[0] === 0 && bytes[1] === 0x3c) encoding = "utf-16be";
  else if (bytes[0] === 0x3c && bytes[1] === 0) encoding = "utf-16le";
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

/** Never replace an HTTP error with a parser exception. Binary reads bypass this. */
export function normalizeResponseData(data: unknown, contentType = ""): JsonData {
  let original = "";
  let format = "unknown";
  try {
    if (data === undefined || data === null || data === "") return {};
    if (Buffer.isBuffer(data) || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (bytes.byteLength > MAX_BYTES) return conversionDiagnostic({ content: Buffer.from(bytes).toString("base64"), encoding: "base64", format: "binary", parseError: "Response exceeds the 8 MiB conversion limit." });
      try { data = decode(bytes, contentType); }
      catch { return conversionDiagnostic({ content: Buffer.from(bytes).toString("base64"), encoding: "base64", format: "binary", parseError: "Unsupported charset or invalid encoded response bytes." }); }
    }
    if (typeof data !== "string") return asObject(jsonValue(data));
    original = data;
    const trimmed = data.trim();
    if (!trimmed) return {};
    const xml = trimmed.startsWith("<") || /(?:\b|\+)xml\b/i.test(contentType);
    const json = /^[\[{]/.test(trimmed) || /(?:\b|\+)json\b/i.test(contentType);
    format = xml ? "xml" : json ? "json" : "text";
    if (Buffer.byteLength(data, "utf8") > MAX_BYTES) return fallback(data, format, "Response exceeds the 8 MiB conversion limit.");

    // Trust a valid body over a missing or inaccurate Content-Type header.
    try {
      if (/^[\[{]/.test(trimmed)) checkJsonDepth(trimmed);
      const parsed: unknown = JSON.parse(trimmed);
      try { return asObject(jsonValue(parsed)); }
      catch (error) { return fallback(data, "json", error instanceof Error ? error.message : "Invalid JSON value."); }
    } catch (error) {
      if (error instanceof Error && error.message === "JSON nesting exceeds conversion limits.") return fallback(data, "json", error.message);
      // A non-JSON body may be XML, HTML, or ordinary text.
    }
    if (/^<!doctype\s+html\b|^<html(?:\s|>)/i.test(trimmed)
      || (/text\/html\b/i.test(contentType) && !trimmed.startsWith("<"))) return { content: data, format: "html" };
    if (xml) {
      const mixed = inspectXml(trimmed);
      SyntaxValidator.validate(trimmed, { multipleRoots: false, invalidCharSequence: { comment: true, tagValue: true, attrLt: true } });
      const entityDecoder = new EntityDecoder({
        numericAllowed: true,
        ncr: { nullNCR: "throw" },
        onInputEntity: () => "throw",
        onExternalEntity: () => "throw",
        limit: { maxTotalExpansions: MAX_NODES, maxExpandedLength: MAX_BYTES, applyLimitsTo: "all" },
      });
      const parsed: unknown = new XMLParser({ ...xmlOptions, entityDecoder, preserveOrder: mixed }).parse(trimmed);
      return mixed ? { xml: jsonValue(parsed) } : asObject(jsonValue(parsed));
    }
    if (json) return fallback(data, "json", "Invalid JSON response.");
    return { content: data };
  } catch (error) {
    return fallback(original, format, error instanceof Error ? error.message : "Unable to normalize response data.");
  }
}
