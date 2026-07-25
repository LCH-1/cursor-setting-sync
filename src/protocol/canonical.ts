import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { JsonValue } from "../types";

export function canonicalJson(value: JsonValue | object): string {
  return JSON.stringify(sortValue(value));
}

export function canonicalBytes(value: JsonValue | object): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function sha256(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hmacSha256(key: Uint8Array, content: Uint8Array | string): string {
  return createHmac("sha256", key).update(content).digest("hex");
}

export function hashesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return (
    leftBuffer.length === rightBuffer.length &&
    leftBuffer.length > 0 &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

/**
 * True when `value` is base64 in the shape `Buffer.toString("base64")` emits:
 * a multiple of four characters, the standard alphabet, and padding only at the
 * end.
 *
 * Deliberately a scan rather than a regular expression. The obvious pattern for
 * this — `/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/` —
 * makes V8 push a backtracking frame per four-character group as soon as the
 * trailing optional group forces the star to give one back, and it throws
 * `RangeError: Maximum call stack size exceeded` somewhere between two and four
 * megabytes of decoded payload. Every payload in this repository is base64
 * inside its envelope and a single chat with a few hundred messages clears that
 * threshold, so the throw came out of `readObject` — from where it aborted the
 * whole sync cycle rather than failing one resource.
 *
 * This does not verify that the bits under the padding are zero, matching what
 * the pattern it replaces accepted. Call sites that need exact canonical form
 * re-encode and compare, which is the only check that actually establishes it.
 */
export function isCanonicalBase64Text(value: string): boolean {
  if (value.length % 4 !== 0) {
    return false;
  }
  let padding = 0;
  if (value.length > 0 && value.charCodeAt(value.length - 1) === 0x3d) {
    padding = value.charCodeAt(value.length - 2) === 0x3d ? 2 : 1;
  }
  for (let index = 0; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !(code >= 0x41 && code <= 0x5a) && // A-Z
      !(code >= 0x61 && code <= 0x7a) && // a-z
      !(code >= 0x30 && code <= 0x39) && // 0-9
      code !== 0x2b && // +
      code !== 0x2f // /
    ) {
      return false;
    }
  }
  return true;
}

export function hasExactObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (value !== null && typeof value === "object") {
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort(compareCanonicalKeys)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) {
        sorted[key] = sortValue(child);
      }
    }
    return sorted;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new Error(`Unsupported canonical JSON value: ${typeof value}`);
}

function compareCanonicalKeys(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
