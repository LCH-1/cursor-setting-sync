import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import {
  publishWarningObservation,
  scanAdapters,
  type SyncScope,
} from "../src/sync/manager";
import { filterPublishableChanges } from "../src/sync/versionPolicy";
import {
  RECONCILER_WARNING_SOURCE,
  StandingWarningRegistry,
  formatWarningLine,
  isPublishWarningSource,
  publishWarningSource,
  standingWarningDiagnostics,
} from "../src/sync/warningLog";
import type { ResourceAdapter } from "../src/resources/resource";
import type {
  LocalProjection,
  ResourceKind,
  ResourceScanResult,
  ResourceSnapshot,
} from "../src/types";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-07-25T00:00:00.000Z");
const NO_KINDS: ReadonlySet<ResourceKind> = new Set();

function adapter(
  id: string,
  kinds: readonly ResourceKind[],
  scan: () => Promise<ResourceScanResult>,
): ResourceAdapter {
  return {
    id,
    kinds,
    appliesWhileRunning: false,
    scan,
    apply: () => Promise.resolve(),
  };
}

function warns(
  id: string,
  kinds: readonly ResourceKind[],
  warnings: string[],
): ResourceAdapter {
  return adapter(id, kinds, () =>
    Promise.resolve({ snapshots: [], deletions: [], warnings }),
  );
}

function produces(
  id: string,
  kinds: readonly ResourceKind[],
  snapshots: () => ResourceSnapshot[],
): ResourceAdapter {
  return adapter(id, kinds, () =>
    Promise.resolve({ snapshots: snapshots(), deletions: [], warnings: [] }),
  );
}

const KNOWN: Record<string, LocalProjection> = {};

describe("per-adapter scan partitioning", () => {
  it("gives every adapter that ran its own key, including the clean ones", async () => {
    const result = await scanAdapters(
      [
        warns("settings", ["settings"], []),
        warns("state-vscdb-chat", ["chat"], ["no body"]),
      ],
      KNOWN,
      "all",
      NO_KINDS,
    );

    expect([...result.warningsBySource.keys()]).toEqual([
      "settings",
      "state-vscdb-chat",
    ]);
    expect(result.warningsBySource.get("settings")).toEqual([]);
    expect(result.warningsBySource.get("state-vscdb-chat")).toEqual([
      "no body",
    ]);
  });

  it("omits adapters the scope did not run, rather than reporting them clean", async () => {
    const adapters = [
      warns("settings", ["settings"], ["broken"]),
      warns("state-vscdb-chat", ["chat"], ["no body"]),
    ];
    const keysFor = async (scope: SyncScope): Promise<string[]> => [
      ...(await scanAdapters(adapters, KNOWN, scope, NO_KINDS))
        .warningsBySource.keys(),
    ];

    expect(await keysFor("chat")).toEqual(["state-vscdb-chat"]);
    expect(await keysFor("files")).toEqual(["settings"]);
    expect(await keysFor("remote")).toEqual([]);
  });

  it("attributes a thrown scan to the adapter that threw", async () => {
    const result = await scanAdapters(
      [
        adapter("workspace-storage", ["workspace-storage"], () =>
          Promise.reject(new Error("EBUSY")),
        ),
      ],
      KNOWN,
      "all",
      NO_KINDS,
    );

    expect(result.warningsBySource.get("workspace-storage")).toEqual([
      "Adapter workspace-storage scan failed: EBUSY",
    ]);
  });

  it("keys a chat adapter pulled into a files cycle by requiredKinds", async () => {
    const result = await scanAdapters(
      [
        warns("settings", ["settings"], []),
        warns("state-vscdb-chat", ["chat"], ["no body"]),
      ],
      KNOWN,
      "files",
      new Set<ResourceKind>(["chat"]),
    );

    expect([...result.warningsBySource.keys()]).toEqual([
      "settings",
      "state-vscdb-chat",
    ]);
  });
});

describe("publish warnings against the standing warning registry", () => {
  const BIG = "cursor-user-file/rules/big.md";
  const LIMIT = 1024;
  const ADAPTER_OF: Partial<Record<ResourceKind, string>> = {
    "cursor-user-file": "cursor-user-files",
    chat: "state-vscdb-chat",
  };

  function file(bytes: number): ResourceSnapshot {
    return {
      resourceId: BIG,
      kind: "cursor-user-file",
      content: Buffer.alloc(bytes, 1),
      semanticHash: "d".repeat(64),
    };
  }

  /** performSync's warning composition, without the extension host around it. */
  async function cycle(
    adapters: readonly ResourceAdapter[],
    registry: StandingWarningRegistry,
    logged: string[],
    scope: SyncScope,
    now: number,
  ): Promise<void> {
    const scan = await scanAdapters(adapters, KNOWN, scope, NO_KINDS);
    const publishable = filterPublishableChanges(
      scan.snapshots,
      scan.deletions,
      LIMIT,
      (snapshot) =>
        publishWarningSource(ADAPTER_OF[snapshot.kind] ?? snapshot.kind),
    );
    const observed = new Map<string, readonly string[]>([
      [RECONCILER_WARNING_SOURCE, []],
      ...publishWarningObservation(
        scan.warningsBySource.keys(),
        publishable.warningsBySource,
      ),
      ...scan.warningsBySource,
    ]);
    for (const entry of registry.observe({ sources: observed, now })) {
      logged.push(formatWarningLine(entry));
    }
  }

  it("keeps an oversized files resource standing through chat and remote cycles", async () => {
    // Defaults put both poll intervals at 30s, so files and chat cycles
    // alternate with watcher-driven remote cycles in between. One global
    // publish bucket looked like an always-run source: the chat cycle reported
    // it empty, the registry deleted it, the status went green, and the next
    // files cycle logged the identical line as new.
    const adapters = [
      produces("cursor-user-files", ["cursor-user-file"], () => [file(4096)]),
      warns("state-vscdb-chat", ["chat"], []),
    ];
    const registry = new StandingWarningRegistry(HOUR);
    const logged: string[] = [];
    const scopes: SyncScope[] = ["files", "chat", "remote", "files"];

    for (const [index, scope] of scopes.entries()) {
      await cycle(adapters, registry, logged, scope, T0 + index * 30_000);
      // Exactly what updateStatus reads to choose "partial" over "up-to-date",
      // and what Show Diagnostics lists.
      const standing = registry.standingMatching(isPublishWarningSource);
      expect(standing).toHaveLength(1);
      expect(standing[0]?.source).toBe(
        publishWarningSource("cursor-user-files"),
      );
    }

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("Warning [publish:cursor-user-files]");
    expect(logged[0]).toContain(BIG);
    expect(
      standingWarningDiagnostics(registry.standing(), T0 + 3 * 30_000)[0],
    ).toMatchObject({ blocksPublish: true, observations: 2 });
  });

  it("clears the warning when the owning adapter reports the resource small again", async () => {
    let bytes = 4096;
    const adapters = [
      produces("cursor-user-files", ["cursor-user-file"], () => [file(bytes)]),
      warns("state-vscdb-chat", ["chat"], []),
    ];
    const registry = new StandingWarningRegistry(HOUR);
    const logged: string[] = [];

    await cycle(adapters, registry, logged, "files", T0);
    expect(registry.standingMatching(isPublishWarningSource)).toHaveLength(1);

    bytes = 16;
    await cycle(adapters, registry, logged, "chat", T0 + 30_000);
    expect(registry.standingMatching(isPublishWarningSource)).toHaveLength(1);
    await cycle(adapters, registry, logged, "files", T0 + 60_000);
    expect(registry.standingMatching(isPublishWarningSource)).toEqual([]);

    bytes = 4096;
    await cycle(adapters, registry, logged, "files", T0 + 90_000);
    expect(logged).toHaveLength(2);
    expect(logged[1]).toContain("Warning [publish:cursor-user-files]");
  });
});

describe("scope alternation against the standing warning registry", () => {
  it("logs each standing warning once across ten alternating cycles", async () => {
    // The real drainSyncQueue order with both poll intervals at 30s: the files
    // timer and the chat timer fire as two back-to-back single-scope cycles.
    const adapters = [
      warns("settings", ["settings"], ["settings.json is unreadable"]),
      warns("state-vscdb-chat", ["chat"], ["Skipped 3 chat(s) with no body"]),
    ];
    const registry = new StandingWarningRegistry(HOUR);
    const logged: string[] = [];

    const run = async (scope: SyncScope, now: number): Promise<void> => {
      const scan = await scanAdapters(adapters, KNOWN, scope, NO_KINDS);
      const observed = new Map<string, readonly string[]>([
        [RECONCILER_WARNING_SOURCE, []],
        ...scan.warningsBySource,
      ]);
      for (const entry of registry.observe({ sources: observed, now })) {
        logged.push(formatWarningLine(entry));
      }
    };

    for (let cycle = 0; cycle < 10; cycle += 1) {
      await run(cycle % 2 === 0 ? "files" : "chat", T0 + cycle * 30_000);
    }

    expect(logged).toEqual([
      "Warning [settings]: settings.json is unreadable",
      "Warning [state-vscdb-chat]: Skipped 3 chat(s) with no body",
    ]);

    // An hour later each is restated exactly once, and not again.
    logged.length = 0;
    await run("files", T0 + HOUR);
    await run("chat", T0 + HOUR + 30_000);
    await run("files", T0 + HOUR + 60_000);
    await run("chat", T0 + HOUR + 90_000);

    expect(logged).toEqual([
      "Warning [settings] (unchanged for 1h): settings.json is unreadable",
      "Warning [state-vscdb-chat] (unchanged for 1h): Skipped 3 chat(s) with no body",
    ]);
  });
});
