import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import { isUnscannableIncomingResource } from "../src/sync/manager";
import { isSyncableComposerId } from "../src/chat/stateVscdb";
const UUID = "0218ca54-5c11-4ef9-9009-69033b689e1a";

describe("inbound resources this device's scan will never produce", () => {
  // Leaving the queue is observational - an entry goes when a later scan finds
  // the value already local. So anything the scan does not emit is queued for
  // good: offered at launch, skipped by the helper, offered again. Three of
  // these survived three consecutive applies on a real device.

  it("refuses workspaceStorage from a window with no folder open", () => {
    // Named after the millisecond the window opened, or `empty-window`. Both
    // name a window here and nothing at all on any other computer.
    for (const workspaceId of ["1785164815421", "empty-window", "ext-dev"]) {
      expect(
        isUnscannableIncomingResource(
          `workspace-storage/${workspaceId}%2Fstate.vscdb`,
          "workspace-storage",
          { workspaceId, workspaceUri: null },
        ),
      ).toBe(true);
    }
  });

  it("accepts workspaceStorage that carries a folder URI", () => {
    // 1229 of this repository's 1237 workspaceStorage resources. The rule has
    // to leave every one of them alone.
    expect(
      isUnscannableIncomingResource(
        "workspace-storage/fe1a6c7f473850204df9f61b8a9f6a82%2Fstate.vscdb",
        "workspace-storage",
        {
          workspaceId: "fe1a6c7f473850204df9f61b8a9f6a82",
          workspaceUri: "vscode-remote://ssh-remote%2Bprod/home/ubuntu/server",
        },
      ),
    ).toBe(false);
  });

  it("refuses a composer whose ID is not a chat ID", () => {
    // Cursor keeps `empty-state-draft` on every installation, so both devices
    // publish one, they conflict, and neither can ever apply the other's.
    expect(
      isUnscannableIncomingResource("chat/empty-state-draft", "chat", {
        composerId: "empty-state-draft",
        bubbleCount: 0,
      }),
    ).toBe(true);
    expect(isSyncableComposerId("empty-state-draft")).toBe(false);
  });

  it("accepts an ordinary chat", () => {
    expect(
      isUnscannableIncomingResource(`chat/${UUID}`, "chat", {
        composerId: UUID,
        workspaceId: "empty-window",
      }),
    ).toBe(false);
    expect(isSyncableComposerId(UUID)).toBe(true);
  });

  it("leaves a chat alone for having a folderless workspace ID", () => {
    // The workspaceStorage rule must not reach chats a second time. Scoping it
    // wrongly is what deferred 69 conversations under a message about workspace
    // storage; a chat with an unplaceable workspace ID still applies, because
    // the helper writes its source workspace ID straight back.
    expect(
      isUnscannableIncomingResource(`chat/${UUID}`, "chat", {
        composerId: UUID,
        workspaceId: "1785164815421",
        workspaceUri: null,
      }),
    ).toBe(false);
  });

  it("says nothing about kinds it does not govern", () => {
    for (const kind of ["settings", "extension", "ui-state"] as const) {
      expect(
        isUnscannableIncomingResource(`${kind}/whatever`, kind, {}),
      ).toBe(false);
    }
  });
});
