import { describe, expect, it } from "vitest";
import type { CursorPaths } from "../src/platform/paths";
import type { PreparedHelperChange } from "../src/helper/database";
import { applyNonGlobalChanges } from "../src/helper/resourceApply";
import type { HelperRequest } from "../src/helper/types";

describe("ignored extension apply policy", () => {
  it("records the remote projection while retaining the local extension", async () => {
    const resourceId = "extension/default/publisher.ignored";
    const prepared: PreparedHelperChange[] = [
      {
        change: {
          eventHash: "a".repeat(64),
          changeIndex: 0,
          resourceId,
          kind: "extension",
          operation: "delete",
          semanticHash: "b".repeat(64),
          metadata: {
            profileId: "default",
            profileName: "Default",
            extensionId: "publisher.ignored",
          },
        },
      },
    ];

    const result = await applyNonGlobalChanges(helperRequest(), prepared);

    expect(result.applied).toEqual([resourceId]);
    expect(result.retainedLocal).toEqual([resourceId]);
    expect(result.skipped.join("\n")).toContain("ignored on this device");
  });
});

function helperRequest(): HelperRequest {
  return {
    version: 1,
    requestId: "ignored-extension-test",
    mode: "apply-and-restart",
    createdAt: "2026-07-20T00:00:00.000Z",
    repositoryRoot: "C:/repository",
    storageRoot: "C:/storage",
    cursorExecutable: "C:/Cursor/Cursor.exe",
    extensionHostPid: 1,
    restart: false,
    expectedCursorVersion: "3.11.19",
    expectedVscodeVersion: "1.125.0",
    extensionVersion: "0.0.1",
    paths: {} as CursorPaths,
    changes: [],
    workspaceMappings: {},
    syncOptions: {
      ignoredSettings: [],
      ignoredExtensions: ["PUBLISHER.IGNORED"],
      machineScopedSettings: [],
      syncChat: true,
      syncWorkspaceStorage: true,
      maxPayloadBytes: 1024 * 1024,
    },
  };
}
