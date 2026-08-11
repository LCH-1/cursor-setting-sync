import {
  applyEdits,
  createScanner,
  modify,
  parse,
  printParseErrorCode,
  SyntaxKind,
  type ParseError,
} from "jsonc-parser";
import type { JsonValue, MergeOutcome } from "../types";
import { canonicalBytes, canonicalJson, sha256 } from "../protocol/canonical";

export interface JsonMergeResult {
  value: JsonValue | undefined;
  conflicts: string[];
}

export const MAX_JSONC_STRUCTURAL_TOKENS = 65_536;
export const MAX_JSONC_NESTING_DEPTH = 128;

/** Rejects structural amplification before jsonc-parser builds an object graph. */
export function assertBoundedJsoncStructure(
  source: string,
  label: string,
  maxTokens = MAX_JSONC_STRUCTURAL_TOKENS,
  maxDepth = MAX_JSONC_NESTING_DEPTH,
): void {
  let tokens = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      tokens += 1;
      if (depth > maxDepth) {
        throw new Error(
          `${label} exceeds the ${maxDepth}-level automatic parse depth limit.`,
        );
      }
    } else if (character === "}" || character === "]") {
      depth = Math.max(0, depth - 1);
    } else if (character === "," || character === ":") {
      tokens += 1;
    }
    if (tokens > maxTokens) {
      throw new Error(
        `${label} exceeds the ${maxTokens}-token automatic parse limit.`,
      );
    }
  }
}

export function parseJsonc(content: string, label: string): JsonValue {
  assertBoundedJsoncStructure(content, label);
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
  const baseText = base.toString("utf8");
  const localText = local.toString("utf8");
  const remoteText = remote.toString("utf8");
  const baseValue = parseJsonc(baseText, "base");
  const localValue = parseJsonc(localText, "local");
  const remoteValue = parseJsonc(remoteText, "remote");
  const result = mergeJsonValues(baseValue, localValue, remoteValue);
  if (result.conflicts.length > 0 || result.value === undefined) {
    return jsoncMergeConflict(
      result.conflicts,
      baseValue,
      localValue,
      remoteValue,
    );
  }

  // The merged value is written back as property-level edits, so comments and
  // formatting on untouched lines survive the merge.
  //
  // Which text those edits are anchored on decides both what survives and
  // whether the merge is deterministic. Two devices resolving the same fork
  // see the same three buffers with "local" and "remote" SWAPPED, so the
  // anchor has to be picked by a rule that treats the pair as unordered;
  // anchoring on "local" unconditionally made each device write the other's
  // values into its own formatting, so the two merge events had different
  // bytes, never collapsed into one version, and re-conflicted.
  //
  // Anchoring on the base unconditionally is deterministic but deletes every
  // comment either side added since the base, silently and with no conflict
  // prompt. Comments are authored content, so the anchor is chosen from the
  // comment trivia instead, which is a property of the unordered pair:
  //
  //   - neither side touched the comments -> anchor on base; the base carries
  //     every comment both sides have, so nothing can be lost.
  //   - exactly one side touched them -> anchor on THAT side's bytes. Both
  //     devices identify the same side and anchor on the same bytes, so both
  //     emit the same output, and the added comments survive.
  //   - both sides touched them -> the two anchors are only usable if they
  //     render identically (both sides made the same edit). Otherwise no
  //     anchor can carry both sets of comments without inventing a merge that
  //     the other device would have to reproduce byte for byte, so the case
  //     falls through to manual conflict resolution rather than dropping one
  //     side's annotations.
  //
  // Pure whitespace, key ordering and indentation still normalize to the
  // chosen anchor. That loses no authored content and the merged value is
  // exact, so it is not worth a conflict prompt.
  const baseComments = collectComments(baseText);
  const localEdited = !sameComments(collectComments(localText), baseComments);
  const remoteEdited = !sameComments(collectComments(remoteText), baseComments);
  let merged: string;
  if (!localEdited && !remoteEdited) {
    merged = renderJsoncMerge(baseText, baseValue, result.value);
  } else if (localEdited && !remoteEdited) {
    merged = renderJsoncMerge(localText, localValue, result.value);
  } else if (remoteEdited && !localEdited) {
    merged = renderJsoncMerge(remoteText, remoteValue, result.value);
  } else {
    const fromLocal = renderJsoncMerge(localText, localValue, result.value);
    const fromRemote = renderJsoncMerge(remoteText, remoteValue, result.value);
    if (fromLocal !== fromRemote) {
      return jsoncMergeConflict(
        ["$ (comments changed on both sides)"],
        baseValue,
        localValue,
        remoteValue,
      );
    }
    merged = fromLocal;
  }
  const content = Buffer.from(merged, "utf8");
  return {
    status: deepEqual(result.value, localValue) && local.equals(content)
      ? "unchanged"
      : "merged",
    content,
    // Every adapter that owns a JSON-merge kind - snippets, tasks, mcp.json and
    // the other Cursor user files - hashes the raw file bytes, so the merge
    // outcome must hash the same bytes. Publishing sha256 of the canonical JSON
    // instead made the tip hash disagree with what the next scan computed, so
    // the resource was republished on every cycle and could never be
    // recognized as already applied.
    semanticHash: sha256(content),
  };
}

function jsoncMergeConflict(
  conflicts: string[],
  baseValue: JsonValue | undefined,
  localValue: JsonValue | undefined,
  remoteValue: JsonValue | undefined,
): MergeOutcome {
  return {
    status: "conflict",
    conflictContent: Buffer.from(
      `${JSON.stringify(
        {
          conflicts,
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

/** Writes `merged` into `anchorText` as property-level edits. */
function renderJsoncMerge(
  anchorText: string,
  anchorValue: JsonValue | undefined,
  merged: JsonValue,
): string {
  let text = anchorText;
  for (const [propertyPath, value] of collectJsoncEdits(anchorValue, merged, [])) {
    text =
      propertyPath.length === 0
        ? `${JSON.stringify(value, null, 2)}\n`
        : setJsoncProperty(text, propertyPath, value);
  }
  return text;
}

/**
 * Every comment token in document order. Leading and trailing whitespace is
 * trimmed so re-indenting a comment does not count as authoring one.
 */
function collectComments(source: string): string[] {
  const scanner = createScanner(source, false);
  const comments: string[] = [];
  for (
    let token = scanner.scan();
    token !== SyntaxKind.EOF;
    token = scanner.scan()
  ) {
    if (
      token === SyntaxKind.LineCommentTrivia ||
      token === SyntaxKind.BlockCommentTrivia
    ) {
      comments.push(scanner.getTokenValue().trim());
    }
  }
  return comments;
}

function sameComments(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((comment, index) => comment === right[index])
  );
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
