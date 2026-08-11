import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import { EventReconciler } from "../src/protocol/reconciler";
import {
  autoMergeConflicts,
  settleOversizedSnapshots,
} from "../src/sync/manager";
import { SyncRepository } from "../src/protocol/repository";
import {
  canonicalBytes,
  isCanonicalBase64Text,
  sha256,
} from "../src/protocol/canonical";
import { parsePortableChatSnapshot } from "../src/chat/stateVscdb";
import { oversizedPayloadWarning } from "../src/sync/versionPolicy";
import { publishWarningSource } from "../src/sync/warningLog";
import type { ResourceAdapter } from "../src/resources/resource";
import type {
  EventProducer,
  ResourceSnapshot,
  SyncConflict,
} from "../src/types";

const PASSPHRASE = "a sufficiently long test passphrase";
const PRODUCER: EventProducer = {
  extensionVersion: "0.0.1",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};
const COMPOSER = "026e7136-6ca9-4847-9328-6fc5a697c651";

/**
 * Large enough that the regular expression this validator replaced overflowed
 * the V8 regex stack. That pattern coped with two megabytes and threw at four;
 * five keeps the margin without making the suite slow.
 *
 * The content is random rather than repeated, and that is the point: payloads
 * are gzipped before they are encrypted and base64-encoded into their envelope,
 * so five megabytes of one repeated byte produces a ciphertext of a few hundred
 * characters and never reaches the size that breaks anything. A real chat is
 * base64 message bodies, which do not compress - which is why this only ever
 * showed up in production.
 */
const OVERFLOWING_BYTES = 5 * 1024 * 1024;
// Still produces >4 MiB individual Base64 fields (the historical recursive
// validator failure), while both tips together remain below the fixed 32 MiB
// interactive auto-merge budget.
const CHAT_OVERFLOWING_BYTES = 3 * 1024 * 1024;

function incompressible(bytes: number): Buffer {
  return randomBytes(bytes);
}

describe("isCanonicalBase64Text", () => {
  it("accepts a payload large enough to overflow a backtracking matcher", () => {
    // The bug this replaces: `RangeError: Maximum call stack size exceeded`
    // thrown by RegExp.test inside readObject, which aborted the sync cycle
    // rather than failing one resource. The size is chosen to force trailing
    // padding, which is what made the star quantifier give a group back.
    const encoded = incompressible(OVERFLOWING_BYTES + 2).toString("base64");
    expect(encoded.endsWith("=")).toBe(true);

    expect(() => isCanonicalBase64Text(encoded)).not.toThrow();
    expect(isCanonicalBase64Text(encoded)).toBe(true);
  });

  it("still rejects what the pattern rejected", () => {
    expect(isCanonicalBase64Text("QQ==")).toBe(true);
    expect(isCanonicalBase64Text("QUJD")).toBe(true);
    expect(isCanonicalBase64Text("")).toBe(true);
    // Not a multiple of four.
    expect(isCanonicalBase64Text("QUJ")).toBe(false);
    // Padding in the middle, and past the two-character maximum.
    expect(isCanonicalBase64Text("QQ==QQ==")).toBe(false);
    expect(isCanonicalBase64Text("Q===")).toBe(false);
    expect(isCanonicalBase64Text("====")).toBe(false);
    // Outside the standard alphabet: url-safe, whitespace, newline.
    expect(isCanonicalBase64Text("QQ-_")).toBe(false);
    expect(isCanonicalBase64Text("QU J D")).toBe(false);
    expect(isCanonicalBase64Text("QUJD\nQUJD")).toBe(false);
  });
});

describe("large payloads through the repository", () => {
  it("reads back an object far past the old validator's limit", async () => {
    await withRepository(async (repository) => {
      // Incompressible, so the base64 ciphertext in the envelope really is
      // megabytes long - which is the string the validator has to survive.
      const content = incompressible(OVERFLOWING_BYTES);
      const published = await repository.publish(
        [
          {
            resourceId: "cursor-user-file/big.md",
            kind: "cursor-user-file",
            content,
            semanticHash: sha256(content),
            metadata: { relativePath: "big.md" },
            parents: [],
          },
        ],
        [],
      );

      const read = await repository.readVersion(`${published.eventHash ?? ""}#0`);

      expect(read.content?.byteLength).toBe(content.byteLength);
      expect(read.content?.equals(content)).toBe(true);
    });
  });

  it("auto-merges a base-free chat fork whose payloads are megabytes", async () => {
    // The exact production failure: two base-free chat tips, each large enough
    // that reading one threw out of readObject, through resolveBaseFreeChatConflict
    // and autoMergeConflicts, and took the whole cycle down on every poll.
    await withRepository(async (repository) => {
      const resourceId = `chat/${COMPOSER}`;
      // b1 is the same immutable message on both sides. Generating this inside
      // `bigChat` accidentally made it two random same-key rows, which is an
      // ambiguous conflict rather than an additive-union scenario.
      const sharedBody = incompressible(CHAT_OVERFLOWING_BYTES).toString(
        "base64",
      );
      for (const [side, extra] of [
        ["a", "b2"],
        ["b", "b3"],
      ] as const) {
        const content = bigChat(side, extra, sharedBody);
        await repository.publish(
          [
            {
              resourceId,
              kind: "chat",
              content,
              semanticHash: sha256(content),
              metadata: { composerId: COMPOSER, workspaceId: null },
              parents: [],
            },
          ],
          [],
        );
      }
      const conflicts = await reconcileConflicts(repository);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.baseVersionId).toBeNull();

      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);

      await reconcileConflicts(repository);
      const tips = repository.state.tips[resourceId] ?? [];
      expect(tips).toHaveLength(1);
      const resolved = await repository.readVersion(tips[0]?.versionId ?? "");
      const merged = parsePortableChatSnapshot(resolved.content ?? Buffer.alloc(0));
      // Both sides' messages survived, at full size.
      expect(merged.bubbles.map((bubble) => bubble.key).sort()).toEqual([
        `bubbleId:${COMPOSER}:b1`,
        `bubbleId:${COMPOSER}:b2`,
        `bubbleId:${COMPOSER}:b3`,
      ]);
    });
  }, 15_000);
});

describe("autoMergeConflicts error containment", () => {
  it("degrades one failing conflict to manual instead of ending the cycle", async () => {
    await withRepository(async (repository) => {
      const resourceId = `chat/${COMPOSER}`;
      for (const side of ["a", "b"] as const) {
        const content = smallChat(side);
        await repository.publish(
          [
            {
              resourceId,
              kind: "chat",
              content,
              semanticHash: sha256(content),
              metadata: { composerId: COMPOSER, workspaceId: null },
              parents: [],
            },
          ],
          [],
        );
      }
      const conflicts = await reconcileConflicts(repository);
      const warnings: string[] = [];
      // Any unanticipated failure inside the merge - the 0.0.6 RangeError was
      // one - must not escape. `readObject` is where that one surfaced.
      vi.spyOn(repository, "readObject").mockRejectedValue(
        new RangeError("Maximum call stack size exceeded"),
      );

      const merged = await autoMergeConflicts(
        repository,
        conflicts,
        () => true,
        (warning) => warnings.push(warning),
      );

      expect(merged).toBe(false);
      expect(conflicts[0]?.resolvedAt).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(resourceId);
      expect(warnings[0]).toContain("Maximum call stack size exceeded");
      expect(warnings[0]).toContain("Resolve Conflicts");
      vi.restoreAllMocks();
    });
  });
});

describe("oversized adapter settlement warnings", () => {
  it("keeps the exact warning while the adapter runs, without re-supplying bytes", () => {
    const maxPayloadBytes = 100;
    const snapshot: ResourceSnapshot = {
      resourceId: `chat/${COMPOSER}`,
      kind: "chat",
      content: Buffer.alloc(101),
      semanticHash: "oversized-semantic-hash",
    };
    const settle = vi.fn(() => true);
    const adapter: ResourceAdapter = {
      id: "state-vscdb-chat",
      kinds: ["chat"],
      appliesWhileRunning: false,
      scan: async () => ({ snapshots: [], deletions: [], warnings: [] }),
      apply: async () => {},
      settleOversizedSnapshot: settle,
      oversizedSnapshotSettlements: () => [
        {
          resourceId: snapshot.resourceId,
          semanticHash: snapshot.semanticHash,
          byteLength: snapshot.content.byteLength,
          maxPayloadBytes,
        },
      ],
    };
    const source = publishWarningSource(adapter.id);
    const warning = oversizedPayloadWarning(
      snapshot.resourceId,
      snapshot.content.byteLength,
      maxPayloadBytes,
    );

    expect(
      settleOversizedSnapshots(
        [adapter],
        [adapter.id],
        [snapshot],
        maxPayloadBytes,
      ).get(source),
    ).toEqual([warning]);
    expect(settle).toHaveBeenCalledOnce();

    // The next observation carries only the lightweight settlement. An
    // adapter that did not run does not overwrite its standing warning bucket.
    expect(
      settleOversizedSnapshots(
        [adapter],
        [adapter.id],
        [],
        maxPayloadBytes,
      ).get(source),
    ).toEqual([warning]);
    expect(
      settleOversizedSnapshots([adapter], [], [], maxPayloadBytes),
    ).toEqual(new Map());
  });
});

function chatSnapshot(bubbles: Array<[string, string]>, lastUpdatedAt: number): Buffer {
  return canonicalBytes({
    schemaVersion: 1,
    composerId: COMPOSER,
    header: {
      composerId: COMPOSER,
      workspaceId: null,
      createdAt: 1,
      lastUpdatedAt,
      isArchived: 0,
      isSubagent: 0,
      recency: 0,
      checkpointAt: null,
      value: "conversation",
    },
    composerData: {
      key: `composerData:${COMPOSER}`,
      valueBase64: Buffer.from("body", "utf8").toString("base64"),
      valueType: "text",
    },
    bubbles: bubbles.map(([id, body]) => ({
      key: `bubbleId:${COMPOSER}:${id}`,
      valueBase64: Buffer.from(body, "utf8").toString("base64"),
      valueType: "text",
    })),
  });
}

/** A snapshot whose own payload is past the old validator's breaking point. */
function bigChat(side: string, extraBubble: string, body: string): Buffer {
  return chatSnapshot(
    [
      ["b1", body],
      [extraBubble, `${side}-${body}`],
    ],
    side === "a" ? 200 : 100,
  );
}

function smallChat(side: string): Buffer {
  return chatSnapshot([["b1", side]], side === "a" ? 200 : 100);
}

async function reconcileConflicts(
  repository: SyncRepository,
): Promise<SyncConflict[]> {
  return new EventReconciler().reconcile(
    await repository.listEvents(),
    repository.state,
    null,
  ).conflicts;
}

async function withRepository<T>(
  run: (repository: SyncRepository) => Promise<T>,
): Promise<T> {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "cursor-setting-sync-large-"),
  );
  try {
    return await run(
      await SyncRepository.create(
        join(temporaryRoot, "repository"),
        join(temporaryRoot, "storage"),
        PASSPHRASE,
        // Well above the payloads below, so nothing is refused for size.
        64 * 1024 * 1024,
        PRODUCER,
      ),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
