import { describe, expect, it } from "vitest";
import {
  createEncryptedRepository,
  unlockRepository,
  validateRepositoryFile,
} from "../src/protocol/crypto";
import type { RepositoryFile } from "../src/types";

describe("repository encryption", () => {
  it("unlocks with the original passphrase", async () => {
    const created = await createEncryptedRepository(
      "correct horse battery staple",
      "00000000-0000-4000-8000-000000000001",
    );

    const unlocked = await unlockRepository(
      "correct horse battery staple",
      created.repository,
    );

    expect(unlocked.equals(created.masterKey)).toBe(true);
    expect(() =>
      validateRepositoryFile({
        ...created.repository,
        unexpected: true,
      } as RepositoryFile),
    ).toThrow(/unknown or missing fields/i);
  });

  it("supports an empty passphrase as no passphrase", async () => {
    const created = await createEncryptedRepository(
      "",
      "00000000-0000-4000-8000-000000000009",
    );

    const unlocked = await unlockRepository("", created.repository);

    expect(unlocked.equals(created.masterKey)).toBe(true);
    await expect(
      unlockRepository("not the empty passphrase", created.repository),
    ).rejects.toThrow();
  });

  it("rejects a short but non-empty passphrase", async () => {
    await expect(
      createEncryptedRepository("short", "00000000-0000-4000-8000-00000000000a"),
    ).rejects.toThrow(/at least 12 characters/i);
  });

  it("rejects a wrong passphrase", async () => {
    const created = await createEncryptedRepository(
      "correct horse battery staple",
      "00000000-0000-4000-8000-000000000002",
    );

    await expect(
      unlockRepository("wrong passphrase value", created.repository),
    ).rejects.toThrow();
  });

  it("rejects an altered authentication tag", async () => {
    const created = await createEncryptedRepository(
      "correct horse battery staple",
      "00000000-0000-4000-8000-000000000003",
    );
    const tag = Buffer.from(created.repository.wrappedMasterKey.tag, "base64");
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    created.repository.wrappedMasterKey.tag = tag.toString("base64");

    await expect(
      unlockRepository("correct horse battery staple", created.repository),
    ).rejects.toThrow();
  });
});
