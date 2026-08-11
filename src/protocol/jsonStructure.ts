/** Fixed interactive default shared by automatic JSON graph consumers. */
export const JSON_STRUCTURE_MAX_TOKENS = 65_536;
export const JSON_STRUCTURE_MAX_DEPTH = 256;
/**
 * Outer portable resource envelopes need to remain compatible with the
 * largest bounded snapshots produced by Cursor while still imposing a fixed
 * allocation limit before JSON.parse. Nested decoded JSON keeps the smaller
 * interactive budget above.
 */
export const PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS = 262_144;

export interface JsonStructureBudgetOptions {
  maxStructuralTokens?: number;
  maxNestingDepth?: number;
  /** JSONC callers skip comments; strict JSON callers leave them as input. */
  allowComments?: boolean;
}

export interface JsonStructureBudget {
  /** Debits one independent JSON document from this shared aggregate budget. */
  consume(input: Uint8Array | string): boolean;
}

/**
 * Allocation-free structural preflight for JSON bytes or already-decoded
 * text. Punctuation outside strings accounts for properties and array items,
 * while a separate nesting cap protects recursive parsers/serializers. One
 * token budget is shared across every supplied input.
 *
 * This deliberately is not a JSON validator. Malformed input still belongs to
 * the real parser, but it cannot hide unbounded structure from this scan.
 */
export function buffersFitJsonStructureBudget(
  inputs: Iterable<Uint8Array | string>,
  options: JsonStructureBudgetOptions = {},
): boolean {
  const budget = createJsonStructureBudget(options);
  for (const input of inputs) {
    if (!budget.consume(input)) {
      return false;
    }
  }
  return true;
}

/** Creates a mutable aggregate budget for inputs decoded one at a time. */
export function createJsonStructureBudget(
  options: JsonStructureBudgetOptions = {},
): JsonStructureBudget {
  const maxStructuralTokens =
    options.maxStructuralTokens ?? JSON_STRUCTURE_MAX_TOKENS;
  const maxNestingDepth =
    options.maxNestingDepth ?? JSON_STRUCTURE_MAX_DEPTH;
  const invalid =
    !Number.isSafeInteger(maxStructuralTokens) ||
    maxStructuralTokens <= 0 ||
    !Number.isSafeInteger(maxNestingDepth) ||
    maxNestingDepth <= 0;
  let remaining = maxStructuralTokens;

  return {
    consume(input): boolean {
      if (invalid || remaining <= 0) {
        return false;
      }
      // Count a scalar root even when it has no structural punctuation.
      remaining -= 1;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let inLineComment = false;
      let inBlockComment = false;
      for (let index = 0; index < input.length; index += 1) {
        const code = typeof input === "string"
          ? input.charCodeAt(index)
          : input[index];
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (code === 0x5c) {
            escaped = true;
          } else if (code === 0x22) {
            inString = false;
          }
          continue;
        }
        if (inLineComment) {
          if (code === 0x0a || code === 0x0d) {
            inLineComment = false;
          }
          continue;
        }
        if (inBlockComment) {
          if (code === 0x2a && structureCodeAt(input, index + 1) === 0x2f) {
            inBlockComment = false;
            index += 1;
          }
          continue;
        }
        if (code === 0x22) {
          inString = true;
          continue;
        }
        if (
          options.allowComments === true &&
          code === 0x2f &&
          structureCodeAt(input, index + 1) === 0x2f
        ) {
          inLineComment = true;
          index += 1;
          continue;
        }
        if (
          options.allowComments === true &&
          code === 0x2f &&
          structureCodeAt(input, index + 1) === 0x2a
        ) {
          inBlockComment = true;
          index += 1;
          continue;
        }
        const opens = code === 0x7b || code === 0x5b;
        const closes = code === 0x7d || code === 0x5d;
        if (!opens && !closes && code !== 0x2c && code !== 0x3a) {
          continue;
        }
        if (remaining <= 0) {
          return false;
        }
        remaining -= 1;
        if (opens) {
          depth += 1;
          if (depth > maxNestingDepth) {
            return false;
          }
        } else if (closes) {
          depth -= 1;
          if (depth < 0) {
            return false;
          }
        }
      }
      // Unterminated strings/comments and unmatched containers must not hide
      // structure that a downstream JSON/JSONC parser would otherwise inspect.
      return depth === 0 && !inString && !inBlockComment;
    },
  };
}

function structureCodeAt(input: Uint8Array | string, index: number): number {
  return typeof input === "string"
    ? input.charCodeAt(index)
    : (input[index] ?? Number.NaN);
}
