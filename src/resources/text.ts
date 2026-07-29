import type { MergeOutcome } from "../types";
import { sha256 } from "../protocol/canonical";

// node-diff3 exposes a dedicated CommonJS build used by the bundled extension.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const diff3 = require("node-diff3") as {
  mergeDiff3(
    local: string[],
    base: string[],
    remote: string[],
    options: {
      excludeFalseConflicts: boolean;
      label: { a: string; o: string; b: string };
    },
  ): { conflict: boolean; result: string[] };
};

export function mergeTextBuffers(
  base: Buffer,
  local: Buffer,
  remote: Buffer,
): MergeOutcome {
  if (local.equals(remote)) {
    return {
      status: "unchanged",
      content: local,
      semanticHash: sha256(local),
    };
  }
  if (local.equals(base)) {
    return {
      status: "merged",
      content: remote,
      semanticHash: sha256(remote),
    };
  }
  if (remote.equals(base)) {
    return {
      status: "unchanged",
      content: local,
      semanticHash: sha256(local),
    };
  }

  // diff3 works on decoded strings, and decoding is only faithful for UTF-8:
  // any invalid byte becomes U+FFFD, so a genuinely binary "user file" (an
  // .ico, a .woff2, an .mp3 the extension denylist did not anticipate) would
  // be MERGED into replacement-character soup that both machines then
  // converge on with no prompt - authored content silently destroyed. A
  // round-trip check is exact where an extension denylist can never be:
  // if any side's bytes do not survive decode+encode, this is not text and
  // the manual resolver (which handles binary either/or) must decide.
  if (
    !utf8RoundTrips(base) ||
    !utf8RoundTrips(local) ||
    !utf8RoundTrips(remote)
  ) {
    return { status: "conflict" };
  }

  const result = diff3.mergeDiff3(
    splitLines(local),
    splitLines(base),
    splitLines(remote),
    {
      excludeFalseConflicts: true,
      label: {
        a: "LOCAL",
        o: "BASE",
        b: "REMOTE",
      },
    },
  );
  // Joining with the base's dominant EOL keeps the resolution deterministic
  // across devices: both sides share the base, so two devices auto-merging
  // the same conflict produce byte-identical output instead of a CRLF/LF
  // pair that would conflict again. A base without line breaks falls back to
  // "\n".
  const content = Buffer.from(
    result.result.join(dominantEol(base.toString("utf8"))),
    "utf8",
  );
  if (result.conflict) {
    return {
      status: "conflict",
      conflictContent: content,
    };
  }
  return {
    status: "merged",
    content,
    semanticHash: sha256(content),
  };
}

function utf8RoundTrips(content: Buffer): boolean {
  return Buffer.from(content.toString("utf8"), "utf8").equals(content);
}

function splitLines(content: Buffer): string[] {
  return content.toString("utf8").replaceAll("\r\n", "\n").split("\n");
}

function dominantEol(content: string): string {
  const crlf = content.split("\r\n").length - 1;
  const bareLf = content.split("\n").length - 1 - crlf;
  return crlf > bareLf ? "\r\n" : "\n";
}
