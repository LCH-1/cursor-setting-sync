import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncRepository } from "../src/protocol/repository";

const T0 = Date.parse("2026-08-08T00:00:00.000Z");
const ACK_HEARTBEAT_MS = 15 * 60 * 1000;
const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("repository acknowledgements", () => {
  it("reports first, changed, and heartbeat writes but not a fresh no-op", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-repo-ack-"));
    temporaryRoots.push(temporaryRoot);
    const repository = await SyncRepository.create(
      join(temporaryRoot, "repository"),
      join(temporaryRoot, "storage"),
      "a sufficiently long test passphrase",
      4 * 1024 * 1024,
      {
        extensionVersion: "0.0.61",
        cursorVersion: "3.15.6",
        vscodeVersion: "1.125.0",
      },
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(T0);

    await expect(repository.writeAck()).resolves.toBe(true);
    await expect(repository.writeAck()).resolves.toBe(false);

    repository.state.streams.peer = {
      lastSequence: 7,
      lastEventHash: "a".repeat(64),
    };
    await expect(repository.writeAck()).resolves.toBe(true);
    await expect(repository.writeAck()).resolves.toBe(false);

    now.mockReturnValue(T0 + ACK_HEARTBEAT_MS - 1);
    await expect(repository.writeAck()).resolves.toBe(false);
    now.mockReturnValue(T0 + ACK_HEARTBEAT_MS);
    await expect(repository.writeAck()).resolves.toBe(true);
  });
});
