import { describe, expect, it } from "vitest";
import {
  GLOBAL_DATABASE_KINDS,
  HELPER_APPLIED_KINDS,
  SUPPORTED_RESOURCE_KINDS,
} from "../src/types";
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

  it("routes every helper-applied kind to an applier", () => {
    // The helper splits prepared changes by kind: GLOBAL_DATABASE_KINDS go to
    // the global state.vscdb writer, the rest to applyNonGlobalChanges. A kind
    // on neither side is not an error - it is prepared, written by nobody, and
    // never marked applied, so it sits in the queue forever being re-offered.
    // `remote-targets` shipped in 0.0.48 with its write path but not its
    // routing, and the SSH folder history it carries never landed on either
    // computer until 0.0.52.
    const nonGlobal: ResourceKind[] = [
      "extension",
      "chat-transcript",
      "chat-store",
      "workspace-storage",
    ];
    const routed = new Set<ResourceKind>([
      ...GLOBAL_DATABASE_KINDS,
      ...nonGlobal,
    ]);

    expect(
      [...HELPER_APPLIED_KINDS].filter((kind) => !routed.has(kind)),
    ).toEqual([]);
    // And nothing is claimed by both halves, which would apply it twice.
    expect(
      GLOBAL_DATABASE_KINDS.filter((kind) => nonGlobal.includes(kind)),
    ).toEqual([]);
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
