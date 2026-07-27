import { describe, expect, it } from "vitest";
import { HELPER_APPLIED_KINDS, SUPPORTED_RESOURCE_KINDS } from "../src/types";
import type { CursorPaths } from "../src/platform/paths";
import type { ResourceAdapter } from "../src/resources/resource";
import type { ResourceKind } from "../src/types";
import { createIgnoreMatcher } from "../src/resources/ignorePatterns";
import { SettingsAdapter } from "../src/resources/settings";
import { ProfileFilesAdapter } from "../src/resources/profileFiles";
import { ProfilesAdapter } from "../src/resources/profiles";
import { ExtensionsAdapter } from "../src/resources/extensions";
import { UiStateAdapter } from "../src/resources/uiState";
import { CursorUserFilesAdapter } from "../src/resources/cursorUserFiles";
import { WorkspaceStorageAdapter } from "../src/resources/workspaceStorage";
import { StateVscdbChatAdapter } from "../src/chat/stateVscdb";
import { ChatTranscriptsAdapter } from "../src/chat/transcripts";
import { StoreDbChatAdapter } from "../src/chat/storeDb";

// Every adapter constructor only stores what it is handed, so no path here is
// ever opened; the test reads declarations, not behaviour.
const paths = {} as CursorPaths;
const nothingIgnored = createIgnoreMatcher([]);

const adapters: ResourceAdapter[] = [
  new SettingsAdapter(paths, nothingIgnored, nothingIgnored, nothingIgnored),
  new ProfileFilesAdapter(paths),
  new ProfilesAdapter(paths),
  new ExtensionsAdapter(paths, nothingIgnored),
  new UiStateAdapter(paths),
  new CursorUserFilesAdapter(paths),
  new WorkspaceStorageAdapter(paths),
  new StateVscdbChatAdapter(paths),
  new ChatTranscriptsAdapter(paths),
  new StoreDbChatAdapter(paths),
];

describe("HELPER_APPLIED_KINDS", () => {
  /**
   * The repository layer has to know which kinds only the offline helper can
   * write - the checkpoint marker must not land on one - and it cannot import
   * the adapters to find out. This is the check that keeps the copy honest.
   */
  it("lists exactly the kinds whose adapter cannot apply while Cursor runs", () => {
    const declared = new Set<ResourceKind>();
    for (const adapter of adapters) {
      if (!adapter.appliesWhileRunning) {
        for (const kind of adapter.kinds) {
          declared.add(kind);
        }
      }
    }
    expect([...HELPER_APPLIED_KINDS].sort()).toEqual([...declared].sort());
  });

  it("leaves no supported kind unclaimed by an adapter", () => {
    // A kind no adapter owns would silently fall on the permissive side of
    // every `HELPER_APPLIED_KINDS.has(...)` test, including the marker choice.
    const claimed = new Set<ResourceKind>();
    for (const adapter of adapters) {
      for (const kind of adapter.kinds) {
        claimed.add(kind);
      }
    }
    expect([...SUPPORTED_RESOURCE_KINDS].filter((kind) => !claimed.has(kind))).toEqual(
      [],
    );
  });
});
