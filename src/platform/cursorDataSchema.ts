import { gzipSync, gunzipSync } from "node:zlib";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { CursorSchemaSnapshot } from "../monitor/cursorSchema";
import { CURSOR_MESSAGE_NAMES } from "../chat/cursorMessageNames";

export const MAX_CURSOR_SCHEMA_BYTES = 512 * 1024;
export const MAX_ENCODED_CURSOR_SCHEMA = 128 * 1024;
const decoded = new Map<string, CursorSchemaSnapshot>();

export function encodeCursorDataSchema(schema: CursorSchemaSnapshot): string {
  const bytes = Buffer.from(JSON.stringify(schema));
  if (bytes.length > MAX_CURSOR_SCHEMA_BYTES) throw new Error("Cursor schema exceeds the compatibility inspection limit");
  return gzipSync(bytes).toString("base64");
}

export function decodeCursorDataSchema(encoded: string): CursorSchemaSnapshot {
  const cached = decoded.get(encoded);
  if (cached !== undefined) return cached;
  if (encoded.length > MAX_ENCODED_CURSOR_SCHEMA || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Invalid Cursor data schema");
  const value: unknown = JSON.parse(gunzipSync(Buffer.from(encoded, "base64"), { maxOutputLength: MAX_CURSOR_SCHEMA_BYTES }).toString("utf8"));
  if (value === null || typeof value !== "object" || !("formatVersion" in value) || value.formatVersion !== 1 ||
    !("messages" in value) || value.messages === null || typeof value.messages !== "object" || Array.isArray(value.messages)) throw new Error("Invalid Cursor data schema");
  const validateLiteral = (entry: unknown, depth = 0): void => {
    if (depth > 8) throw new Error("Cursor descriptor nesting exceeds inspection limit");
    if (["string", "boolean"].includes(typeof entry) || (typeof entry === "number" && Number.isFinite(entry))) return;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid Cursor descriptor literal");
    for (const child of Object.values(entry)) validateLiteral(child, depth + 1);
  };
  for (const name of Object.values(CURSOR_MESSAGE_NAMES)) {
    if (!Object.hasOwn(value.messages, name)) throw new Error(`Missing Cursor descriptor ${name}`);
  }
  for (const fields of Object.values(value.messages)) {
    if (!Array.isArray(fields) || fields.length > 4096) throw new Error("Invalid Cursor descriptor fields");
    const numbers = new Set<number>();
    for (const rawField of fields) {
      const field: unknown = rawField;
      if (field === null || typeof field !== "object" || !("no" in field) || typeof field.no !== "number" || !Number.isSafeInteger(field.no) || field.no < 1 || numbers.has(field.no) ||
        !("name" in field) || typeof field.name !== "string" || !("kind" in field) || typeof field.kind !== "string" || !["message", "scalar", "enum", "map"].includes(field.kind)) throw new Error("Invalid Cursor descriptor field");
      numbers.add(field.no);
      validateLiteral(field);
    }
  }
  if ("enums" in value) {
    if (value.enums === null || typeof value.enums !== "object" || Array.isArray(value.enums)) throw new Error("Invalid Cursor enum descriptors");
    for (const fields of Object.values(value.enums)) {
      if (!Array.isArray(fields) || fields.length > 4096) throw new Error("Invalid Cursor enum descriptor");
      for (const field of fields) validateLiteral(field);
    }
  }
  if (decoded.size >= 16) decoded.delete(decoded.keys().next().value!);
  decoded.set(encoded, value as CursorSchemaSnapshot);
  return value as CursorSchemaSnapshot;
}

export async function inspectInstalledCursorDataSchema(appRoot: string): Promise<string> {
  const worker = new Worker(join(__dirname, "schema-inspector.js"), { workerData: appRoot });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (schema?: string, error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (schema === undefined) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(schema);
    };
    const timer = setTimeout(() => finish(undefined, new Error("Cursor schema inspection timed out")), 30_000);
    worker.once("message", (value: { schema?: string; error?: string }) => {
      if (typeof value?.schema !== "string") finish(undefined, new Error(value?.error ?? "Cursor schema inspection failed"));
      else { try { decodeCursorDataSchema(value.schema); finish(value.schema); } catch (error) { finish(undefined, error); } }
    });
    worker.once("error", error => finish(undefined, error));
    worker.once("exit", code => finish(undefined, new Error(`Cursor schema inspector exited without a result (${code})`)));
  });
}

export async function readCursorWorkbench(appRoot: string): Promise<string> {
  const path = join(appRoot, "out/vs/workbench/workbench.desktop.main.js");
  if ((await stat(path)).size > 256 * 1024 * 1024) throw new Error("Cursor workbench exceeds inspection limit");
  return readFile(path, "utf8");
}
