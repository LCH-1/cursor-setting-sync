import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import type { JsonValue, MergeOutcome } from "../types";
import { canonicalBytes, canonicalJson, sha256 } from "../protocol/canonical";

export interface JsonMergeResult {
  value: JsonValue | undefined;
  conflicts: string[];
}

export function parseJsonc(content: string, label: string): JsonValue {
  const errors: ParseError[] = [];
  const value = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  }) as JsonValue | undefined;
  if (errors.length > 0 || value === undefined) {
    const details = errors
      .map((error) => `${printParseErrorCode(error.error)} at ${error.offset}`)
      .join(", ");
    throw new Error(`Invalid JSONC in ${label}: ${details}`);
  }
  return value;
}

export function parseJsoncObject(
  content: string,
  label: string,
): Record<string, JsonValue> {
  const value = parseJsonc(content, label);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Expected a JSON object in ${label}.`);
  }
  return value;
}

export function semanticHash(value: JsonValue): string {
  return sha256(canonicalBytes(value));
}

export function serializeCanonical(value: JsonValue): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

export function setJsoncProperty(
  source: string,
  propertyPath: (string | number)[],
  value: JsonValue | undefined,
): string {
  const edits = modify(source, propertyPath, value, {
    formattingOptions: detectFormatting(source),
    isArrayInsertion: false,
  });
  return applyEdits(source, edits);
}

export function mergeJsonValues(
  base: JsonValue | undefined,
  local: JsonValue | undefined,
  remote: JsonValue | undefined,
  path = "$",
): JsonMergeResult {
  if (deepEqual(local, remote)) {
    return { value: local, conflicts: [] };
  }
  if (deepEqual(local, base)) {
    return { value: remote, conflicts: [] };
  }
  if (deepEqual(remote, base)) {
    return { value: local, conflicts: [] };
  }

  if (isObject(base) && isObject(local) && isObject(remote)) {
    const output = Object.create(null) as Record<string, JsonValue>;
    const conflicts: string[] = [];
    const keys = new Set([
      ...Object.keys(base),
      ...Object.keys(local),
      ...Object.keys(remote),
    ]);
    for (const key of [...keys].sort(compareKeys)) {
      const merged = mergeJsonValues(base[key], local[key], remote[key], `${path}.${key}`);
      conflicts.push(...merged.conflicts);
      if (merged.value !== undefined) {
        output[key] = merged.value;
      }
    }
    return { value: output, conflicts };
  }

  return { value: local, conflicts: [path] };
}

export function mergeJsoncBuffers(
  base: Buffer,
  local: Buffer,
  remote: Buffer,
): MergeOutcome {
  const baseValue = parseJsonc(base.toString("utf8"), "base");
  const localValue = parseJsonc(local.toString("utf8"), "local");
  const remoteValue = parseJsonc(remote.toString("utf8"), "remote");
  const result = mergeJsonValues(baseValue, localValue, remoteValue);
  if (result.conflicts.length > 0 || result.value === undefined) {
    return {
      status: "conflict",
      conflictContent: Buffer.from(
        `${JSON.stringify(
          {
            conflicts: result.conflicts,
            base: baseValue,
            local: localValue,
            remote: remoteValue,
          },
          null,
          2,
        )}\n`,
        "utf8",
      ),
    };
  }
  // The merged value is written back as property-level edits to the local
  // text, so comments and formatting on untouched lines survive the merge.
  let merged = local.toString("utf8");
  for (const [propertyPath, value] of collectJsoncEdits(localValue, result.value, [])) {
    merged =
      propertyPath.length === 0
        ? `${JSON.stringify(value, null, 2)}\n`
        : setJsoncProperty(merged, propertyPath, value);
  }
  return {
    status: deepEqual(result.value, localValue) ? "unchanged" : "merged",
    content: Buffer.from(merged, "utf8"),
    semanticHash: semanticHash(result.value),
  };
}

function collectJsoncEdits(
  local: JsonValue | undefined,
  merged: JsonValue | undefined,
  path: (string | number)[],
): Array<[(string | number)[], JsonValue | undefined]> {
  if (deepEqual(local, merged)) {
    return [];
  }
  if (isObject(local) && isObject(merged)) {
    const edits: Array<[(string | number)[], JsonValue | undefined]> = [];
    const keys = new Set([...Object.keys(local), ...Object.keys(merged)]);
    for (const key of [...keys].sort(compareKeys)) {
      edits.push(...collectJsoncEdits(local[key], merged[key], [...path, key]));
    }
    return edits;
  }
  return [[path, merged]];
}

function detectFormatting(source: string): {
  insertSpaces: boolean;
  tabSize: number;
  eol: string;
} {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const indentation = /^( +|\t+)(?=")/m.exec(source)?.[1] ?? "  ";
  return {
    insertSpaces: !indentation.includes("\t"),
    tabSize: indentation.includes("\t") ? 1 : indentation.length,
    eol,
  };
}

function deepEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return canonicalJson(left) === canonicalJson(right);
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== undefined && value !== null && !Array.isArray(value) && typeof value === "object";
}

function compareKeys(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
