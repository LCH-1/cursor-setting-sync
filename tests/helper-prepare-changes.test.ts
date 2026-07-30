import { mkdtemp, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import { prepareChanges } from "../src/helper/main";
import { EventReconciler } from "../src/protocol/reconciler";
import { SyncRepository } from "../src/protocol/repository";
import { sha256 } from "../src/protocol/canonical";
import type {
  EventProducer,
  ResourceSnapshot,
  ResourceTip,
} from "../src/types";
import type { HelperChange } from "../src/helper/types";

const PASSPHRASE = "a sufficiently long test passphrase";
const PRODUCER: EventProducer = {
  extensionVersion: "0.0.1",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

describe("preparing a helper batch", () => {
  it("defers one unreadable payload instead of losing the whole batch", async () => {
    // A payload object that EXISTS but cannot be read - a cloud placeholder
    // that materialized as zero bytes, a truncated write, bit rot - used to
    // rethrow out of the preparation step. That happens before anything is
    // applied, dequeued or blocked, so the entire request died: nothing
    // written, the queue exactly as it was found, and the modal offering it
    // again at the next launch. The bytes never heal, so every later apply
    // died the same way and quit Cursor to do it.
    await withRepository(async (repository, root) => {
      const good = await publish(repository, "good", "keep me");
      const bad = await publish(repository, "bad", "unreadable");

      // Zero the object file the way a cloud placeholder does.
      await truncate(objectPath(root, bad), 0);

      const result = await prepareChanges(repository, [
        helperChange(good),
        helperChange(bad),
      ]);

      // The healthy sibling is still applied.
      expect(result.prepared.map((item) => item.change.resourceId)).toEqual([
        good.resourceId,
      ]);
      // ...and the damaged one is reported per resource, so it can be blocked
      // rather than re-offered forever.
      expect(Object.keys(result.failureByResourceId)).toEqual([bad.resourceId]);
      expect(result.skipped.join("\n")).toContain(bad.resourceId);
    });
  });

  it("keeps a payload that has not arrived yet queued without calling it a failure", async () => {
    // The opposite case, and the reason the two are told apart: a shared
    // folder that delivers the event before the object. That heals on its own,
    // so blocking it would make the user run the command by hand for a file
    // OneDrive is about to hand over.
    await withRepository(async (repository, root) => {
      const late = await publish(repository, "late", "not here yet");
      await rm(objectPath(root, late));

      const result = await prepareChanges(repository, [helperChange(late)]);

      expect(result.prepared).toHaveLength(0);
      expect(result.failureByResourceId).toEqual({});
      expect(result.skipped.join("\n")).toContain("payload not yet synced");
    });
  });

  it("defers a change whose event carries no payload reference", async () => {
    await withRepository(async (repository) => {
      const tip = await publish(repository, "orphan", "x");
      const change = helperChange(tip);
      delete change.payload;

      const result = await prepareChanges(repository, [change]);

      expect(result.prepared).toHaveLength(0);
      expect(result.failureByResourceId[tip.resourceId]).toContain(
        "no payload reference",
      );
    });
  });
});

interface PublishedTip {
  resourceId: string;
  tip: ResourceTip;
}

async function publish(
  repository: SyncRepository,
  name: string,
  body: string,
): Promise<PublishedTip> {
  const resourceId = `snippet/${name}.json`;
  const content = Buffer.from(JSON.stringify({ body }), "utf8");
  const snapshot: ResourceSnapshot = {
    resourceId,
    kind: "snippet",
    content,
    semanticHash: sha256(content),
  };
  await repository.publish([snapshot], []);
  // Tips come from reconciliation, not from publishing.
  new EventReconciler().reconcile(
    await repository.listEvents(),
    repository.state,
    null,
  );
  const tip = (repository.state.tips[resourceId] ?? [])[0];
  if (tip === undefined) {
    throw new Error(`publish did not create a tip for ${resourceId}`);
  }
  return { resourceId, tip };
}

function helperChange(published: PublishedTip): HelperChange {
  const { tip, resourceId } = published;
  const change: HelperChange = {
    eventHash: tip.eventHash,
    changeIndex: tip.changeIndex,
    resourceId,
    kind: tip.kind,
    operation: tip.operation,
    semanticHash: tip.semanticHash,
  };
  if (tip.payload !== undefined) {
    change.payload = tip.payload;
  }
  return change;
}

/** Mirrors the repository's own object layout. */
function objectPath(root: string, published: PublishedTip): string {
  const reference = published.tip.payload;
  if (reference === undefined) {
    throw new Error("tip has no payload reference");
  }
  return join(
    root,
    "devices",
    reference.deviceId,
    "blobs",
    "sha256",
    reference.objectId.slice(0, 2),
    `${reference.objectId}.cso`,
  );
}

async function withRepository(
  run: (repository: SyncRepository, root: string) => Promise<void>,
): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-prepare-test-"));
  const root = join(temporaryRoot, "repository");
  try {
    const repository = await SyncRepository.create(
      root,
      join(temporaryRoot, "storage"),
      PASSPHRASE,
      1024 * 1024,
      PRODUCER,
    );
    await run(repository, root);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
