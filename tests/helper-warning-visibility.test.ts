import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import { helperWarningObservation, settledStatus, SyncManager } from "../src/sync/manager";
import {
  HELPER_WARNING_SOURCE,
  StandingWarningRegistry,
  standingWarningDiagnostics,
} from "../src/sync/warningLog";
import { filterPublishableChanges } from "../src/sync/versionPolicy";
import { sha256 } from "../src/protocol/canonical";
import type { HelperResult } from "../src/helper/types";
import type { ResourceSnapshot } from "../src/types";
import type { SyncRepository } from "../src/protocol/repository";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-07-25T00:00:00.000Z");
const WORKSPACE_DATABASE = "workspace-storage/workspace-a%2Fstate.vscdb";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/**
 * The exact wording the shutdown export produces when it drops a resource, so
 * the test is anchored to the real guard rather than to a made-up string.
 */
const DROPPED_BACKUP = droppedBackupWarning();

function droppedBackupWarning(): string {
  const content = Buffer.alloc(8192, 0x61);
  const snapshot: ResourceSnapshot = {
    resourceId: WORKSPACE_DATABASE,
    kind: "workspace-storage",
    content,
    semanticHash: sha256(content),
  };
  const warning = filterPublishableChanges([snapshot], [], 4096).warnings[0];
  if (warning === undefined) {
    throw new Error("The oversized-payload guard produced no warning.");
  }
  return warning;
}

function helperResult(overrides: Partial<HelperResult> = {}): HelperResult {
  return {
    requestId: "11111111-1111-4111-8111-111111111111",
    success: true,
    completedAt: new Date(T0).toISOString(),
    applied: [],
    skipped: [],
    backupPath: null,
    error: null,
    ...overrides,
  };
}

describe("helper-reported warnings reach the user", () => {
  it("consumes actual shutdown results and checks status as well as the empty queue", async () => {
    const extensionStorage = await mkdtemp(join(tmpdir(), "cursor-sync-helper-status-"));
    roots.push(extensionStorage);
    const registry = new StandingWarningRegistry(HOUR);
    const status = { log: vi.fn(), setStatus: vi.fn() };
    const repository = { state: { conflicts: [], pendingDatabaseChanges: [] } } as unknown as SyncRepository;
    const manager = Object.assign(Object.create(SyncManager.prototype) as object, {
      paths: { extensionStorage },
      warnings: registry,
      status,
      repository,
      compatibility: { compatible: true },
      configuration: { enabled: true },
      disposed: false,
      helperFailure: null,
      recordHelperBackups: vi.fn().mockResolvedValue(undefined),
      reportAbandonedHelpers: vi.fn().mockResolvedValue(undefined),
    }) as unknown as {
      consumeHelperResults(options?: { atStartup: boolean }): Promise<void>;
      updateStatus(repository: SyncRepository): void;
    };
    const observations = [
      "workspace-a/state.vscdb: Ignored 1 unknown column(s) in composerHeaders.",
      "Skipped agent blob enrichment for chat/empty-state-draft: Chat snapshot composer ID is invalid..",
    ];
    let sequence = 0;
    const consume = async (overrides: Partial<HelperResult>, atStartup: boolean) => {
      const requestId = `11111111-1111-4111-8111-${String(++sequence).padStart(12, "0")}`;
      const result = helperResult({ requestId, mode: "final-export", ...overrides });
      await writeFile(join(extensionStorage, `helper-result-${requestId}.json`), JSON.stringify(result));
      await manager.consumeHelperResults({ atStartup });
      manager.updateStatus(repository);
      expect(await readdir(extensionStorage)).toEqual([]);
      expect(repository.state.pendingDatabaseChanges).toEqual([]);
    };

    await consume({ warnings: observations, skipped: observations }, true);
    expect(registry.standingFor(HELPER_WARNING_SOURCE)).toHaveLength(2);
    expect(status.setStatus).toHaveBeenLastCalledWith("partial", expect.stringContaining("2 warning(s)"));

    for (let poll = 0; poll < 5; poll += 1) manager.updateStatus(repository);
    await consume({ mode: "verify-live", warnings: [], applied: ["chat/already-present"] }, false);
    await consume({ warnings: [] }, false);
    await consume({}, true);
    expect(registry.standingFor(HELPER_WARNING_SOURCE)).toHaveLength(2);
    expect(status.setStatus).toHaveBeenLastCalledWith("partial", expect.any(String));

    await consume({ warnings: [] }, true);
    expect(registry.standingFor(HELPER_WARNING_SOURCE)).toEqual([]);
    expect(status.setStatus).toHaveBeenLastCalledWith("up-to-date", undefined);
    for (let poll = 0; poll < 5; poll += 1) manager.updateStatus(repository);
    await consume({ warnings: [] }, true);
    expect(status.setStatus).toHaveBeenLastCalledWith("up-to-date", undefined);

    await consume({ warnings: [DROPPED_BACKUP], skipped: [DROPPED_BACKUP] }, true);
    expect(registry.standingFor(HELPER_WARNING_SOURCE)).toHaveLength(1);
    expect(status.setStatus).toHaveBeenLastCalledWith("partial", expect.stringContaining("1 warning(s)"));
  });

  it("turns a skipped-resource warning into a standing warning and a non-green status", () => {
    // The shutdown export is the ONLY path that backs up workspaceStorage. The
    // defect-4 fix turned an oversized payload there from a hard failure into a
    // dropped snapshot, and a dropped snapshot on a success=true result used to
    // be one output-channel line under a green check mark — quieter than the
    // crash it replaced, on every shutdown, indefinitely.
    const registry = new StandingWarningRegistry(HOUR);
    const result = helperResult({
      skipped: [DROPPED_BACKUP],
      warnings: [DROPPED_BACKUP],
    });

    const logged = registry.observe({
      sources: helperWarningObservation([result]),
      now: T0,
    });

    expect(logged).toEqual([
      {
        source: HELPER_WARNING_SOURCE,
        warning: DROPPED_BACKUP,
        reason: "new",
        standingForMs: 0,
      },
    ]);
    const standing = registry.standingFor(HELPER_WARNING_SOURCE);
    expect(standing).toHaveLength(1);

    const status = settledStatus({
      streamWarnings: 0,
      publishWarnings: 0,
      helperWarnings: standing.length,
      disabledKinds: "",
    });
    expect(status.status).toBe("partial");
    expect(status.detail).toContain("offline helper");
    expect(status.detail).toContain("Show Diagnostics");
  });

  it("keeps the warning standing across cycles the helper did not run", () => {
    const registry = new StandingWarningRegistry(HOUR);
    registry.observe({
      sources: helperWarningObservation([
        helperResult({ warnings: [DROPPED_BACKUP] }),
      ]),
      now: T0,
    });

    // Ordinary sync cycles observe adapters and the reconciler; the helper
    // source is simply absent, which must not read as "cleared".
    for (let cycle = 1; cycle <= 10; cycle += 1) {
      registry.observe({
        sources: new Map([["settings", []]]),
        now: T0 + cycle * 30_000,
      });
    }

    expect(registry.standingFor(HELPER_WARNING_SOURCE)).toHaveLength(1);
  });

  it("clears the warning when a later helper run reports nothing", () => {
    const registry = new StandingWarningRegistry(HOUR);
    registry.observe({
      sources: helperWarningObservation([
        helperResult({ warnings: [DROPPED_BACKUP] }),
      ]),
      now: T0,
    });

    registry.observe({
      sources: helperWarningObservation([helperResult({ warnings: [] })]),
      now: T0 + HOUR,
    });

    expect(registry.standingFor(HELPER_WARNING_SOURCE)).toEqual([]);
    expect(
      settledStatus({
        streamWarnings: 0,
        publishWarnings: 0,
        helperWarnings: 0,
        disabledKinds: "",
      }).status,
    ).toBe("up-to-date");
  });

  it("leaves the bucket alone for a result written by a 0.0.1-0.0.3 helper", () => {
    // Those results have no structured warnings field, and their `skipped` list
    // mixes real problems with routine entries such as a retained tombstone.
    // Guessing would either invent a warning or clear one that is still true.
    const registry = new StandingWarningRegistry(HOUR);
    registry.observe({
      sources: helperWarningObservation([
        helperResult({ warnings: [DROPPED_BACKUP] }),
      ]),
      now: T0,
    });

    const legacy = helperResult({
      skipped: ["chat/composer%2Fabc: transcript tombstone retained"],
    });
    delete legacy.warnings;
    expect(helperWarningObservation([legacy]).size).toBe(0);

    registry.observe({
      sources: helperWarningObservation([legacy]),
      now: T0 + 1_000,
    });
    expect(registry.standingFor(HELPER_WARNING_SOURCE)).toHaveLength(1);
  });

  it("merges every result in one consumed batch into a single bucket", () => {
    const observation = helperWarningObservation([
      helperResult({ warnings: [DROPPED_BACKUP] }),
      helperResult({ warnings: ["git push skipped: no upstream", DROPPED_BACKUP] }),
    ]);

    expect([...observation.keys()]).toEqual([HELPER_WARNING_SOURCE]);
    expect(observation.get(HELPER_WARNING_SOURCE)).toEqual([
      DROPPED_BACKUP,
      "git push skipped: no upstream",
    ]);
  });

  it("reports a helper warning as publish-blocking in diagnostics", () => {
    const registry = new StandingWarningRegistry(HOUR);
    registry.observe({
      sources: helperWarningObservation([
        helperResult({ warnings: [DROPPED_BACKUP] }),
      ]),
      now: T0,
    });

    const [entry] = standingWarningDiagnostics(registry.standing(), T0 + HOUR);
    expect(entry?.source).toBe(HELPER_WARNING_SOURCE);
    expect(entry?.warning).toContain(WORKSPACE_DATABASE);
    expect(entry?.blocksPublish).toBe(true);
    expect(entry?.blocksMaintenance).toBe(false);
    expect(entry?.standingFor).toBe("1h");
  });
});
