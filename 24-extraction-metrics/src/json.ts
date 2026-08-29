/**
 * JSON value model shared by the whole project. Extraction outputs are parsed
 * JSON, so every comparison works over this type, never over class instances.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export function isPrimitive(v: JsonValue): v is JsonPrimitive {
  return v === null || typeof v !== "object";
}

export function isArray(v: JsonValue): v is JsonValue[] {
  return Array.isArray(v);
}

export function isObject(v: JsonValue): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A path segment: object key (string) or array index (number). */
export type PathSegment = string | number;

/**
 * One primitive leaf of a JSON tree, with the segments that reach it.
 * Objects and arrays are structure; leaves are what extraction is graded on.
 */
export interface Leaf {
  segments: PathSegment[];
  value: JsonPrimitive;
}

/** Flatten a JSON value into its primitive leaves, depth-first, in document order. */
export function flatten(value: JsonValue, prefix: PathSegment[] = []): Leaf[] {
  if (isPrimitive(value)) {
    return [{ segments: prefix, value }];
  }
  const leaves: Leaf[] = [];
  if (isArray(value)) {
    value.forEach((item, i) => {
      leaves.push(...flatten(item, [...prefix, i]));
    });
  } else {
    for (const key of Object.keys(value)) {
      leaves.push(...flatten(value[key] as JsonValue, [...prefix, key]));
    }
  }
  return leaves;
}

/** Count primitive leaves without materializing them. */
export function countLeaves(value: JsonValue): number {
  if (isPrimitive(value)) return 1;
  if (isArray(value)) return value.reduce((n: number, v) => n + countLeaves(v), 0);
  return Object.values(value).reduce((n: number, v) => n + countLeaves(v), 0);
}

/** Concrete display path: vendor.name, line_items[2].qty. */
export function pathToString(segments: PathSegment[]): string {
  let out = "";
  for (const seg of segments) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out === "" ? seg : `.${seg}`;
  }
  return out === "" ? "(root)" : out;
}

/**
 * Generic path: array indices collapsed to [], so every line item's qty
 * aggregates under one row. This is the grouping key for per-field metrics.
 */
export function genericPath(segments: PathSegment[]): string {
  let out = "";
  for (const seg of segments) {
    if (typeof seg === "number") out += "[]";
    else out += out === "" ? seg : `.${seg}`;
  }
  return out === "" ? "(root)" : out;
}

/** Strict deep equality over JSON values: same types, same structure, same order. */
export function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (isPrimitive(a) || isPrimitive(b)) return a === b;
  if (isArray(a) || isArray(b)) {
    if (!isArray(a) || !isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i] as JsonValue));
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => k in b && deepEqual(a[k] as JsonValue, b[k] as JsonValue));
}
