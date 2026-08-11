/**
 * The fields shared by Cursor's portable composer-header representations.
 * Kept structural so the live scanner and the offline helper can use the same
 * canonical writer without importing either other's database code.
 */
export interface PortableComposerHeaderFields {
  composerId: string;
  workspaceId: string | null;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  isArchived: number | null;
  isSubagent: number | null;
  recency: number | null;
  checkpointAt: number | null;
  value: string | null;
}

export interface CanonicalHashUpdater {
  update(data: string | Uint8Array): unknown;
}

/** Keep transient substrings small even for a near-policy-limit header. */
const JSON_STRING_CHUNK_CODE_UNITS = 16 * 1024;
const HEX = "0123456789abcdef";

/**
 * Updates a hash with exactly the bytes `JSON.stringify(value)` emits.
 *
 * Calling JSON.stringify for a multi-megabyte escape-heavy value allocates an
 * equally large (and sometimes six-times larger) second string. This writer
 * preserves JSON.stringify's escaping rules while retaining only one bounded
 * substring at a time. Lone UTF-16 surrogates are emitted as lowercase
 * `\\udxxx`; valid surrogate pairs and all other non-ASCII text stay UTF-8.
 */
export function updateCanonicalJsonString(
  hash: CanonicalHashUpdater,
  value: string,
): void {
  hash.update('"');
  let rawStart = 0;
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    let escape: string | null = null;
    let consumed = 1;
    switch (code) {
      case 0x08:
        escape = "\\b";
        break;
      case 0x09:
        escape = "\\t";
        break;
      case 0x0a:
        escape = "\\n";
        break;
      case 0x0c:
        escape = "\\f";
        break;
      case 0x0d:
        escape = "\\r";
        break;
      case 0x22:
        escape = '\\"';
        break;
      case 0x5c:
        escape = "\\\\";
        break;
      default:
        if (code < 0x20) {
          escape = unicodeEscape(code);
        } else if (code >= 0xd800 && code <= 0xdbff) {
          const next = value.charCodeAt(index + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            consumed = 2;
          } else {
            escape = unicodeEscape(code);
          }
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          escape = unicodeEscape(code);
        }
        break;
    }

    if (escape !== null) {
      updateRawStringRange(hash, value, rawStart, index);
      hash.update(escape);
      index += consumed;
      rawStart = index;
      continue;
    }

    index += consumed;
    if (index - rawStart >= JSON_STRING_CHUNK_CODE_UNITS) {
      updateRawStringRange(hash, value, rawStart, index);
      rawStart = index;
    }
  }
  updateRawStringRange(hash, value, rawStart, value.length);
  hash.update('"');
}

/** Exact UTF-8 byte length of `JSON.stringify(value)`, without serializing it. */
export function canonicalJsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d ||
      code === 0x22 ||
      code === 0x5c
    ) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Exact canonical byte length of one PortableComposerHeader object. */
export function portableComposerHeaderCanonicalByteLength(
  header: PortableComposerHeaderFields,
): number {
  let bytes = Buffer.byteLength('{"checkpointAt":');
  bytes += numberOrNullByteLength(header.checkpointAt);
  bytes += Buffer.byteLength(',"composerId":');
  bytes += canonicalJsonStringByteLength(header.composerId);
  bytes += Buffer.byteLength(',"createdAt":');
  bytes += numberOrNullByteLength(header.createdAt);
  bytes += Buffer.byteLength(',"isArchived":');
  bytes += numberOrNullByteLength(header.isArchived);
  bytes += Buffer.byteLength(',"isSubagent":');
  bytes += numberOrNullByteLength(header.isSubagent);
  bytes += Buffer.byteLength(',"lastUpdatedAt":');
  bytes += numberOrNullByteLength(header.lastUpdatedAt);
  bytes += Buffer.byteLength(',"recency":');
  bytes += numberOrNullByteLength(header.recency);
  bytes += Buffer.byteLength(',"value":');
  bytes += nullableStringByteLength(header.value);
  bytes += Buffer.byteLength(',"workspaceId":');
  bytes += nullableStringByteLength(header.workspaceId);
  bytes += 1;
  if (!Number.isSafeInteger(bytes)) {
    throw new Error("Composer header encoded length exceeds the safe integer range.");
  }
  return bytes;
}

/** Updates a hash with the exact canonical PortableComposerHeader JSON bytes. */
export function updatePortableComposerHeaderHash(
  hash: CanonicalHashUpdater,
  header: PortableComposerHeaderFields,
): void {
  hash.update('{"checkpointAt":');
  updateNumberOrNull(hash, header.checkpointAt);
  hash.update(',"composerId":');
  updateCanonicalJsonString(hash, header.composerId);
  hash.update(',"createdAt":');
  updateNumberOrNull(hash, header.createdAt);
  hash.update(',"isArchived":');
  updateNumberOrNull(hash, header.isArchived);
  hash.update(',"isSubagent":');
  updateNumberOrNull(hash, header.isSubagent);
  hash.update(',"lastUpdatedAt":');
  updateNumberOrNull(hash, header.lastUpdatedAt);
  hash.update(',"recency":');
  updateNumberOrNull(hash, header.recency);
  hash.update(',"value":');
  updateNullableString(hash, header.value);
  hash.update(',"workspaceId":');
  updateNullableString(hash, header.workspaceId);
  hash.update("}");
}

function updateRawStringRange(
  hash: CanonicalHashUpdater,
  value: string,
  start: number,
  end: number,
): void {
  let offset = start;
  while (offset < end) {
    let chunkEnd = Math.min(end, offset + JSON_STRING_CHUNK_CODE_UNITS);
    // node:crypto encodes each string passed to update independently. Cutting
    // between a valid surrogate pair would therefore encode two U+FFFDs even
    // though JSON.stringify emits the pair's one four-byte UTF-8 scalar.
    if (
      chunkEnd < end &&
      isHighSurrogate(value.charCodeAt(chunkEnd - 1)) &&
      isLowSurrogate(value.charCodeAt(chunkEnd))
    ) {
      chunkEnd += 1;
    }
    hash.update(value.slice(offset, chunkEnd));
    offset = chunkEnd;
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function unicodeEscape(code: number): string {
  return `\\u${HEX[(code >>> 12) & 0xf]}${HEX[(code >>> 8) & 0xf]}${
    HEX[(code >>> 4) & 0xf]
  }${HEX[code & 0xf]}`;
}

function numberOrNullText(value: number | null): string {
  if (value === null) {
    return "null";
  }
  if (!Number.isFinite(value)) {
    throw new Error("Composer header numeric values must be finite.");
  }
  return JSON.stringify(value);
}

function numberOrNullByteLength(value: number | null): number {
  return Buffer.byteLength(numberOrNullText(value));
}

function updateNumberOrNull(
  hash: CanonicalHashUpdater,
  value: number | null,
): void {
  hash.update(numberOrNullText(value));
}

function nullableStringByteLength(value: string | null): number {
  return value === null ? 4 : canonicalJsonStringByteLength(value);
}

function updateNullableString(
  hash: CanonicalHashUpdater,
  value: string | null,
): void {
  if (value === null) {
    hash.update("null");
    return;
  }
  updateCanonicalJsonString(hash, value);
}
