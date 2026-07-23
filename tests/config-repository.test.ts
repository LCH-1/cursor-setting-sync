import { describe, expect, it } from "vitest";
import {
  activateRepository,
  type RepositoryActivationTarget,
} from "../src/configRepository";

describe("repository-scoped workspace mappings", () => {
  it("clears mappings before activating a different repository", async () => {
    const calls: string[] = [];
    const target = activationTarget("old-repository", calls);

    await activateRepository(
      target,
      "C:/sync/new",
      "new-repository",
      "encoded-key",
    );

    expect(calls).toEqual([
      "store:new-repository",
      "clear-mappings",
      "path:C:/sync/new",
      "id:new-repository",
      "delete:old-repository",
    ]);
    expect(calls.indexOf("clear-mappings")).toBeLessThan(
      calls.indexOf("id:new-repository"),
    );
  });

  it("preserves mappings when reopening the same repository", async () => {
    const calls: string[] = [];

    await activateRepository(
      activationTarget("same-repository", calls),
      "C:/sync/moved",
      "same-repository",
      "encoded-key",
    );

    expect(calls).not.toContain("clear-mappings");
    expect(calls).not.toContain("delete:same-repository");
  });

  it("clears legacy mappings when no repository was previously active", async () => {
    const calls: string[] = [];

    await activateRepository(
      activationTarget(null, calls),
      "C:/sync/first",
      "first-repository",
      "encoded-key",
    );

    expect(calls).toContain("clear-mappings");
  });
});

function activationTarget(
  currentRepositoryId: string | null,
  calls: string[],
): RepositoryActivationTarget {
  return {
    currentRepositoryId,
    storeMasterKey: async (repositoryId) => {
      calls.push(`store:${repositoryId}`);
    },
    clearWorkspaceMappings: async () => {
      calls.push("clear-mappings");
    },
    setRepositoryPath: async (repositoryPath) => {
      calls.push(`path:${repositoryPath}`);
    },
    setRepositoryId: async (repositoryId) => {
      calls.push(`id:${repositoryId}`);
    },
    deleteMasterKey: async (repositoryId) => {
      calls.push(`delete:${repositoryId}`);
    },
  };
}
