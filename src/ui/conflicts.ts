import * as vscode from "vscode";
import type {
  ResourceDeletion,
  ResourceKind,
  ResourceSnapshot,
  ResourceTip,
  SyncConflict,
} from "../types";
import type { SyncRepository } from "../protocol/repository";
import { sha256 } from "../protocol/canonical";
import { MAX_EVENT_CHANGES } from "../constants";
import type { ConflictSideView, ConflictView } from "./conflictSummary";
import { PREVIEW_BYTE_LIMIT, describeConflict } from "./conflictSummary";
import {
  isNotepadsResourceId,
  renderNotepadsPreview,
} from "./notepadPreview";

/**
 * Conflict resolution runs in the live extension host and repository payload
 * policy can be as high as 512 MiB. Keep the materialized source page fixed:
 * publishing may allocate compression/encryption copies in addition to these
 * buffers, but later selections are not read until the current page is gone.
 */
const CONFLICT_RESOLUTION_MAX_RETAINED_BYTES = 32 * 1024 * 1024;

export interface ConflictResolutionResult {
  resolved: number;
  deferred: string[];
}

export interface ConflictSelection {
  conflictId: string;
  resourceId: string;
  tipVersionIds: string[];
  tip: ResourceTip | null;
  live: ResourceSnapshot | null;
}

export interface CollectedConflictSelections {
  selections: ConflictSelection[];
  deferred: string[];
}

/** What the user asked for, before it is bound to a particular conflict. */
export type ConflictChoice = "newest" | "local" | "remote";

/**
 * Picks the tip a bulk choice means for one conflict, or null when the choice
 * does not apply to it.
 *
 * `local` and `remote` are not always available: with three devices, a conflict
 * can be between two tips that both came from elsewhere, and "keep this PC's
 * version" then names nothing. Returning null lets the caller leave that
 * conflict alone and say so, instead of quietly substituting a different answer
 * than the one the user picked — which is the failure mode a bulk action has to
 * avoid above all others.
 */
export function tipForChoice(
  view: ConflictView,
  choice: ConflictChoice,
): ResourceTip | null {
  // Deliberately `view.latest` and not `view.tips[0]`: the head of the
  // comparator order is the causally later version, which is routinely NOT the
  // one whose timestamp the same screen prints as later. See `latestSideIndex`.
  if (choice === "newest") {
    return view.latest;
  }
  const wanted = choice === "local" ? "local" : "remote";
  const matching = view.sides.filter((side) => side.origin === wanted);
  return matching.length === 1 ? matching[0]?.tip ?? null : null;
}

export class ConflictController
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly documents = new Map<string, string>();
  private readonly registration: vscode.Disposable;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(
      "cursor-sync-conflict",
      this,
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString()) ?? "Conflict content is unavailable.";
  }

  /**
   * Collects one decision per conflict.
   *
   * The flow is a single list of every conflict — named, with both sides' values
   * beside them — fronted by the three bulk answers that resolve the whole list
   * at once. Until 0.0.5 this was one modal quick pick per conflict, each
   * preceded by a diff editor opening on its own: 36 conflicts meant 36 diff
   * tabs and 36 prompts, and cancelling any one of them threw away every
   * decision already made. A diff is now opened only for the conflict the user
   * asks to review, and backing out of the list keeps what was decided.
   */
  async collectSelections(
    repository: SyncRepository,
    blockReason: (tips: ResourceTip[]) => string | null = () => null,
    liveSnapshot: (
      resourceId: string,
      kind: ResourceKind,
    ) => Promise<ResourceSnapshot | undefined> = async () => undefined,
  ): Promise<CollectedConflictSelections> {
    const deferred: string[] = [];
    const views: ConflictView[] = [];
    for (const conflict of repository.state.conflicts) {
      if (conflict.resolvedAt !== undefined) {
        continue;
      }
      const tips = repository.state.tips[conflict.resourceId] ?? [];
      if (tips.length < 2) {
        continue;
      }
      const reason = blockReason(tips);
      if (reason !== null) {
        deferred.push(`${conflict.resourceId}: ${reason}`);
        continue;
      }
      views.push(
        describeConflict(conflict, tips, {
          localDeviceId: repository.state.device.deviceId,
          now: Date.now(),
          contentOf: await this.previewReader(repository, tips),
        }),
      );
    }
    if (views.length === 0) {
      return { selections: [], deferred };
    }
    const decisions = await this.runResolver(repository, views, liveSnapshot);
    return { selections: decisions.selections, deferred: [...deferred, ...decisions.deferred] };
  }

  async applySelections(
    repository: SyncRepository,
    selections: ConflictSelection[],
  ): Promise<ConflictResolutionResult> {
    const deferred: string[] = [];
    let pending: PendingResolution[] = [];
    let pendingBytes = 0;
    let resolved = 0;
    const resolvedAt = new Date().toISOString();
    const flushPending = async (): Promise<void> => {
      if (pending.length === 0) {
        return;
      }
      // Drop the controller's references before awaiting repository work. The
      // local `batch` remains bounded, and the next page cannot be read until
      // this function returns.
      const batch = pending;
      pending = [];
      pendingBytes = 0;
      if (await publishBatch(repository, batch)) {
        for (const item of batch) {
          item.conflict.resolvedAt = resolvedAt;
          resolved += 1;
        }
        return;
      }
      // One resolution the repository refuses -- a payload over the configured
      // repository limit is the realistic case -- must not cost the other
      // resolutions already admitted to this bounded page.
      for (const item of batch) {
        if (await publishBatch(repository, [item])) {
          item.conflict.resolvedAt = resolvedAt;
          resolved += 1;
        } else {
          deferred.push(
            `${item.conflict.resourceId}: ${item.failure ?? "The resolution could not be published."}`,
          );
        }
      }
    };
    for (const selection of selections) {
      const conflict = repository.state.conflicts.find(
        (candidate) =>
          candidate.conflictId === selection.conflictId &&
          candidate.resolvedAt === undefined,
      );
      const currentTipIds = (repository.state.tips[selection.resourceId] ?? [])
        .map((tip) => tip.versionId)
        .sort();
      if (
        conflict === undefined ||
        currentTipIds.length !== selection.tipVersionIds.length ||
        !currentTipIds.every(
          (versionId, index) => versionId === selection.tipVersionIds[index],
        )
      ) {
        deferred.push(
          `${selection.resourceId}: The conflict changed while it was being resolved; open "Cursor Setting Sync: Manage" and choose "Resolve Conflicts" again.`,
        );
        continue;
      }
      try {
        const declaredBytes = resolutionSourceBytes(selection);
        if (declaredBytes > CONFLICT_RESOLUTION_MAX_RETAINED_BYTES) {
          deferred.push(
            `${selection.resourceId}: The selected conflict payload is ${declaredBytes} bytes and exceeds the fixed ${CONFLICT_RESOLUTION_MAX_RETAINED_BYTES}-byte live resolution work limit. The conflict remains unchanged; reduce or restore this resource separately before resolving it.`,
          );
          continue;
        }
        if (
          pending.length > 0 &&
          (pending.length >= MAX_EVENT_CHANGES ||
            pendingBytes + declaredBytes >
              CONFLICT_RESOLUTION_MAX_RETAINED_BYTES)
        ) {
          await flushPending();
        }
        const input =
          selection.tip === null
            ? localContentAsPublishInput(selection.resourceId, selection.live)
            : await tipAsPublishInput(
                repository,
                selection.resourceId,
                selection.tip,
              );
        pending.push({ conflict, ...input });
        pendingBytes += declaredBytes;
        if (
          pending.length >= MAX_EVENT_CHANGES ||
          pendingBytes >= CONFLICT_RESOLUTION_MAX_RETAINED_BYTES
        ) {
          await flushPending();
        }
      } catch (error) {
        deferred.push(`${selection.resourceId}: ${messageOf(error)}`);
      }
    }
    // Published in bounded batches rather than one event per conflict.
    // Resolving 36 tiny conflicts still appends one event, while large inputs
    // are released page by page instead of all remaining live in `pending`.
    await flushPending();
    await repository.saveState();
    return { resolved, deferred };
  }

  dispose(): void {
    this.registration.dispose();
  }

  /**
   * Drives the overview list until the user resolves everything, picks a bulk
   * answer, or backs out. Returns whatever was decided either way.
   */
  private async runResolver(
    repository: SyncRepository,
    views: ConflictView[],
    liveSnapshot: (
      resourceId: string,
      kind: ResourceKind,
    ) => Promise<ResourceSnapshot | undefined>,
  ): Promise<CollectedConflictSelections> {
    const chosen = new Map<string, ConflictSelection>();
    const deferredConflictIds = new Set<string>();
    const deferred: string[] = [];
    let retainedLiveBytes = 0;
    for (;;) {
      const remaining = views.filter(
        (view) =>
          !chosen.has(view.conflict.conflictId) &&
          !deferredConflictIds.has(view.conflict.conflictId),
      );
      if (remaining.length === 0) {
        break;
      }
      const picked = await vscode.window.showQuickPick(
        overviewItems(remaining, chosen.size),
        {
          title:
            chosen.size === 0
              ? `Resolve ${remaining.length} synchronization conflict(s)`
              : `${remaining.length} conflict(s) left · ${chosen.size} decided`,
          placeHolder:
            "Apply one answer to everything, or pick a single conflict to review.",
          ignoreFocusOut: true,
          matchOnDescription: true,
          matchOnDetail: true,
        },
      );
      if (picked === undefined || picked.action.type === "defer") {
        break;
      }
      if (picked.action.type === "bulk") {
        const choice = picked.action.choice;
        for (const view of remaining) {
          const tip = tipForChoice(view, choice);
          if (tip === null) {
            deferred.push(
              `${view.conflict.resourceId}: "${bulkLabel(choice)}" does not apply to this conflict; resolve it individually.`,
            );
            continue;
          }
          chosen.set(view.conflict.conflictId, selectionFor(view, tip, null));
        }
        break;
      }
      const selection = await this.reviewOne(
        repository,
        picked.action.view,
        liveSnapshot,
      );
      if (selection !== null) {
        const liveBytes = selection.live?.content.byteLength ?? 0;
        if (
          liveBytes > CONFLICT_RESOLUTION_MAX_RETAINED_BYTES ||
          retainedLiveBytes + liveBytes >
            CONFLICT_RESOLUTION_MAX_RETAINED_BYTES
        ) {
          deferredConflictIds.add(picked.action.view.conflict.conflictId);
          deferred.push(
            `${picked.action.view.conflict.resourceId}: Keeping unpublished local content would exceed the fixed ${CONFLICT_RESOLUTION_MAX_RETAINED_BYTES}-byte live resolution work limit. This conflict remains unchanged; resolve it separately.`,
          );
          continue;
        }
        retainedLiveBytes += liveBytes;
        chosen.set(picked.action.view.conflict.conflictId, selection);
      }
    }
    return { selections: [...chosen.values()], deferred };
  }

  /** One conflict, with a diff and the sides spelled out. */
  private async reviewOne(
    repository: SyncRepository,
    view: ConflictView,
    liveSnapshot: (
      resourceId: string,
      kind: ResourceKind,
    ) => Promise<ResourceSnapshot | undefined>,
  ): Promise<ConflictSelection | null> {
    await this.showDiff(repository, view);
    const live = await liveSnapshot(view.conflict.resourceId, view.conflict.kind);
    const keepLocal =
      live !== undefined &&
      view.tips.every((tip) => tip.semanticHash !== live.semanticHash)
        ? live
        : null;
    const items: Array<vscode.QuickPickItem & { tip: ResourceTip | null }> =
      view.sides.map((side, index) => ({
        // The badge names why this side is elected, so it can never read as a
        // claim about time on a conflict where no time was compared.
        //
        // LEFT/RIGHT ties the entry to the pane the user is looking at. The
        // diff opens beside this list, and the list used to identify its two
        // options only by which computer wrote them - so the one question the
        // screen actually raises, "which of these panes am I picking", had no
        // answer anywhere on it. `view.sides` and `view.tips` share an order,
        // and showDiff hands tips[0] to the left pane.
        label: `${index === 0 ? "LEFT" : "RIGHT"} · ${
          side.origin === "local" ? "$(device-desktop)" : "$(cloud)"
        } ${side.deviceLabel}${
          side.newest
            ? view.electedByClock
              ? " · written later"
              : " · published last"
            : ""
        }`,
        description: side.value,
        ...(side.when === null ? {} : { detail: `Written ${side.when}` }),
        tip: side.tip,
      }));
    if (keepLocal !== null) {
      items.push({
        label: "$(edit) Keep what is on this PC right now",
        description: "Unpublished local content, different from both sides",
        detail: "Publishes the current local content as the resolution.",
        tip: null,
      });
    }
    const selection = await vscode.window.showQuickPick(items, {
      title: `${view.category}: ${view.name}`,
      placeHolder: "Choose the version that should become the shared result.",
      ignoreFocusOut: true,
    });
    // Backing out returns to the list rather than abandoning the run, so a
    // mis-click no longer costs every decision already made.
    return selection === undefined
      ? null
      : selectionFor(view, selection.tip, selection.tip === null ? keepLocal : null);
  }

  /**
   * Reads each side's payload once, up front, so the list can show values
   * instead of hashes. Oversized and unreadable payloads resolve to null and are
   * described as such rather than failing the run.
   */
  private async previewReader(
    repository: SyncRepository,
    tips: readonly ResourceTip[],
  ): Promise<(tip: ResourceTip) => Buffer | null> {
    const contents = new Map<string, Buffer>();
    for (const tip of tips) {
      if (
        tip.operation === "delete" ||
        tip.payload === undefined ||
        tip.payload.plainBytes > PREVIEW_BYTE_LIMIT
      ) {
        continue;
      }
      try {
        contents.set(tip.versionId, await repository.readObject(tip.payload));
      } catch {
        // Compacted behind a checkpoint, or otherwise unreadable.
      }
    }
    return (tip) => contents.get(tip.versionId) ?? null;
  }

  private async showDiff(
    repository: SyncRepository,
    view: ConflictView,
  ): Promise<void> {
    const [leftSide, rightSide] = view.sides;
    const leftTip = view.tips[0];
    const rightTip = view.tips[1];
    if (
      leftTip === undefined ||
      rightTip === undefined ||
      leftSide === undefined ||
      rightSide === undefined
    ) {
      return;
    }
    const resourceId = view.conflict.resourceId;
    const [left, right] = await Promise.all([
      this.previewText(repository, resourceId, leftTip),
      this.previewText(repository, resourceId, rightTip),
    ]);
    const token = encodeURIComponent(resourceId);
    // The side labels live in the URI path, not only in the title: the diff
    // editor prints the path in each pane's own header and in the tab, so
    // "which of these two is mine" is answerable from the panes themselves.
    // With `left`/`right` alone it was not answerable anywhere on screen.
    const leftUri = vscode.Uri.parse(
      `cursor-sync-conflict:${token}/LEFT ${encodeURIComponent(leftSide.deviceLabel)}`,
    );
    const rightUri = vscode.Uri.parse(
      `cursor-sync-conflict:${token}/RIGHT ${encodeURIComponent(rightSide.deviceLabel)}`,
    );
    this.documents.set(leftUri.toString(), left);
    this.documents.set(rightUri.toString(), right);
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${view.category}: ${view.name} — LEFT ${leftSide.deviceLabel} ↔ RIGHT ${rightSide.deviceLabel}`,
      { preview: true },
    );
  }

  /**
   * The bytes a person can actually read, falling back to the bytes themselves.
   */
  private async previewText(
    repository: SyncRepository,
    resourceId: string,
    tip: ResourceTip,
  ): Promise<string> {
    const raw = await tipContent(repository, tip);
    if (!isNotepadsResourceId(resourceId)) {
      return raw;
    }
    return renderNotepadsPreview(raw) ?? raw;
  }
}

interface PendingResolution {
  conflict: SyncConflict;
  snapshot?: ResourceSnapshot;
  deletion?: ResourceDeletion;
  /** Why the last publish attempt for this item failed, for the report. */
  failure?: string;
}

/**
 * Publishes one batch, recording the reason on every item if it fails so the
 * caller can retry them individually and still say what went wrong.
 */
async function publishBatch(
  repository: SyncRepository,
  batch: readonly PendingResolution[],
): Promise<boolean> {
  try {
    await repository.publish(
      batch.flatMap((item) => (item.snapshot === undefined ? [] : [item.snapshot])),
      batch.flatMap((item) => (item.deletion === undefined ? [] : [item.deletion])),
    );
    return true;
  } catch (error) {
    for (const item of batch) {
      item.failure = messageOf(error);
    }
    return false;
  }
}

type OverviewAction =
  | { type: "bulk"; choice: ConflictChoice }
  | { type: "review"; view: ConflictView }
  | { type: "defer" };

type OverviewItem = vscode.QuickPickItem & { action: OverviewAction };

function overviewItems(
  remaining: readonly ConflictView[],
  decided: number,
): OverviewItem[] {
  const items: OverviewItem[] = [];
  for (const choice of ["newest", "local", "remote"] as const) {
    const applicable = remaining.filter(
      (view) => tipForChoice(view, choice) !== null,
    ).length;
    if (applicable === 0) {
      continue;
    }
    items.push({
      label: `${bulkIcon(choice)} ${bulkLabel(choice)}`,
      description:
        applicable === remaining.length
          ? `all ${applicable}`
          : `${applicable} of ${remaining.length}`,
      detail: bulkDetail(choice, remaining),
      action: { type: "bulk", choice },
    });
  }
  items.push({
    label: "",
    kind: vscode.QuickPickItemKind.Separator,
    action: { type: "defer" },
  });
  for (const view of remaining) {
    const when = whenLine(view);
    items.push({
      label: `${view.category}: ${view.name}`,
      description: view.sides.map(sideChip).join("   vs   "),
      ...(when === undefined ? {} : { detail: when }),
      action: { type: "review", view },
    });
  }
  items.push({
    label: "",
    kind: vscode.QuickPickItemKind.Separator,
    action: { type: "defer" },
  });
  items.push({
    label: "$(clock) Decide later",
    description:
      decided === 0 ? "leave every conflict as it is" : `keep the ${decided} already decided`,
    detail:
      "Nothing is lost. Both versions stay in the repository until you resolve the conflict.",
    action: { type: "defer" },
  });
  return items;
}

function sideChip(side: ConflictSideView): string {
  return `${side.deviceLabel}: ${side.value}`;
}

function whenLine(view: ConflictView): string | undefined {
  const parts = view.sides
    .filter((side) => side.when !== null)
    .map((side) => `${side.deviceLabel} ${side.when}`);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function bulkIcon(choice: ConflictChoice): string {
  return choice === "newest"
    ? "$(zap)"
    : choice === "local"
      ? "$(device-desktop)"
      : "$(cloud)";
}

function bulkLabel(choice: ConflictChoice): string {
  switch (choice) {
    case "newest":
      return "Keep the version written later everywhere";
    case "local":
      return "Keep this PC's version everywhere";
    case "remote":
      return "Keep the other PC's version everywhere";
  }
}

function bulkDetail(
  choice: ConflictChoice,
  remaining: readonly ConflictView[],
): string {
  switch (choice) {
    case "newest": {
      // The wording has to survive the case where some conflicts carry no
      // timestamp to compare — a version folded into a checkpoint keeps none —
      // because "written later" would then be a claim about something the
      // screen never showed.
      const undated = remaining.filter((view) => !view.electedByClock).length;
      const base =
        "Per conflict, the side with the later time shown below wins. Usually what you want.";
      return undated === 0
        ? base
        : `${base} ${undated} conflict(s) show no time to compare; there the last one published wins.`;
    }
    case "local":
      return "Every conflict resolves to what this machine published.";
    case "remote":
      return "Every conflict resolves to what the other machine published.";
  }
}

function selectionFor(
  view: ConflictView,
  tip: ResourceTip | null,
  live: ResourceSnapshot | null,
): ConflictSelection {
  return {
    conflictId: view.conflict.conflictId,
    resourceId: view.conflict.resourceId,
    tipVersionIds: view.tips.map((candidate) => candidate.versionId).sort(),
    tip,
    live,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Authenticated/plain source bytes retained if this selection is materialized. */
function resolutionSourceBytes(selection: ConflictSelection): number {
  if (selection.tip === null) {
    return selection.live?.content.byteLength ?? 0;
  }
  if (selection.tip.operation === "delete") {
    return 0;
  }
  if (selection.tip.payload === undefined) {
    throw new Error(`Conflict tip payload is missing: ${selection.tip.versionId}`);
  }
  return selection.tip.payload.plainBytes;
}

function localContentAsPublishInput(
  resourceId: string,
  live: ResourceSnapshot | null,
): {
  snapshot?: ResourceSnapshot;
  deletion?: ResourceDeletion;
} {
  if (live === null) {
    throw new Error(`Local conflict content is unavailable: ${resourceId}`);
  }
  return {
    snapshot: {
      resourceId,
      kind: live.kind,
      content: live.content,
      semanticHash: live.semanticHash,
      metadata: {
        ...(live.metadata ?? {}),
        syncOrigin: "conflict-resolution",
      },
    },
  };
}

async function tipAsPublishInput(
  repository: SyncRepository,
  resourceId: string,
  tip: ResourceTip,
): Promise<{
  snapshot?: ResourceSnapshot;
  deletion?: ResourceDeletion;
}> {
  if (tip.operation === "delete") {
    return {
      deletion: {
        resourceId,
        kind: tip.kind,
        semanticHash: sha256(`deleted:${resourceId}`),
        metadata: {
          ...(tip.metadata ?? {}),
          syncOrigin: "conflict-resolution",
        },
      },
    };
  }
  if (tip.payload === undefined) {
    throw new Error(`Conflict tip payload is missing: ${tip.versionId}`);
  }
  return {
    snapshot: {
      resourceId,
      kind: tip.kind,
      content: await repository.readObject(tip.payload),
      semanticHash: tip.semanticHash,
      metadata: {
        ...(tip.metadata ?? {}),
        syncOrigin: "conflict-resolution",
      },
    },
  };
}

async function tipContent(
  repository: SyncRepository,
  tip: ResourceTip,
): Promise<string> {
  if (tip.operation === "delete") {
    return "[Deleted]\n";
  }
  if (tip.payload === undefined) {
    return "[Payload missing]\n";
  }
  if (tip.payload.plainBytes > PREVIEW_BYTE_LIMIT) {
    return `[Payload is ${tip.payload.plainBytes} bytes; preview omitted]\n`;
  }
  let content: Buffer;
  try {
    content = await repository.readObject(tip.payload);
  } catch {
    // A payload compacted behind a checkpoint degrades the preview to the
    // sides that remain readable instead of failing the whole flow.
    return "[Payload content is unavailable; it may have been compacted]\n";
  }
  if (content.byteLength > PREVIEW_BYTE_LIMIT) {
    return `[Payload is ${content.byteLength} bytes; preview omitted]\n`;
  }
  const text = content.toString("utf8");
  return text.includes("\uFFFD")
    ? `[Binary payload]\n${content.toString("base64")}`
    : text;
}
