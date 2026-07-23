import * as vscode from "vscode";
import type {
  ResourceDeletion,
  ResourceKind,
  ResourceSnapshot,
  ResourceTip,
} from "../types";
import type { SyncRepository } from "../protocol/repository";
import { sha256 } from "../protocol/canonical";

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

  async collectSelections(
    repository: SyncRepository,
    blockReason: (tips: ResourceTip[]) => string | null = () => null,
    liveSnapshot: (
      resourceId: string,
      kind: ResourceKind,
    ) => Promise<ResourceSnapshot | undefined> = async () => undefined,
  ): Promise<CollectedConflictSelections> {
    const activeConflicts = repository.state.conflicts.filter(
      (conflict) => conflict.resolvedAt === undefined,
    );
    const selections: ConflictSelection[] = [];
    const deferred: string[] = [];
    for (const conflict of activeConflicts) {
      const tips = repository.state.tips[conflict.resourceId] ?? [];
      if (tips.length < 2) {
        continue;
      }
      const reason = blockReason(tips);
      if (reason !== null) {
        deferred.push(`${conflict.resourceId}: ${reason}`);
        continue;
      }
      await this.showDiff(repository, conflict.resourceId, tips[0], tips[1]);
      const live = await liveSnapshot(conflict.resourceId, conflict.kind);
      const keepLocal =
        live !== undefined &&
        tips.every((tip) => tip.semanticHash !== live.semanticHash)
          ? live
          : null;
      const items: Array<vscode.QuickPickItem & { tip: ResourceTip | null }> =
        tips.map((tip) => ({
          label: `${tip.deviceId === repository.state.device.deviceId ? "$(device-desktop) Local" : "$(cloud) Remote"} · Lamport ${tip.lamport}`,
          description: `${tip.operation} ${tip.semanticHash.slice(0, 12)}`,
          detail: tip.versionId,
          tip,
        }));
      if (keepLocal !== null) {
        items.push({
          label: "$(edit) Keep current local content",
          description: `put ${keepLocal.semanticHash.slice(0, 12)}`,
          detail: "Publishes the current unpublished file content as the resolution.",
          tip: null,
        });
      }
      const selection = await vscode.window.showQuickPick(items, {
        title: `Resolve ${conflict.resourceId}`,
        placeHolder: "Choose the version that should become the shared result.",
        ignoreFocusOut: true,
      });
      if (selection === undefined) {
        break;
      }
      selections.push({
        conflictId: conflict.conflictId,
        resourceId: conflict.resourceId,
        tipVersionIds: tips.map((tip) => tip.versionId).sort(),
        tip: selection.tip,
        live: selection.tip === null ? keepLocal : null,
      });
    }
    return { selections, deferred };
  }

  async applySelections(
    repository: SyncRepository,
    selections: ConflictSelection[],
  ): Promise<ConflictResolutionResult> {
    let resolved = 0;
    const deferred: string[] = [];
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
          `${selection.resourceId}: The conflict changed while it was being resolved; run Resolve Conflicts again.`,
        );
        continue;
      }
      const input =
        selection.tip === null
          ? localContentAsPublishInput(selection.resourceId, selection.live)
          : await tipAsPublishInput(
              repository,
              selection.resourceId,
              selection.tip,
            );
      await repository.publish(
        input.snapshot === undefined ? [] : [input.snapshot],
        input.deletion === undefined ? [] : [input.deletion],
      );
      conflict.resolvedAt = new Date().toISOString();
      resolved += 1;
    }
    await repository.saveState();
    return { resolved, deferred };
  }

  dispose(): void {
    this.registration.dispose();
  }

  private async showDiff(
    repository: SyncRepository,
    resourceId: string,
    leftTip: ResourceTip | undefined,
    rightTip: ResourceTip | undefined,
  ): Promise<void> {
    if (leftTip === undefined || rightTip === undefined) {
      return;
    }
    const left = await tipContent(repository, leftTip);
    const right = await tipContent(repository, rightTip);
    const token = encodeURIComponent(resourceId);
    const leftUri = vscode.Uri.parse(`cursor-sync-conflict:${token}/left`);
    const rightUri = vscode.Uri.parse(`cursor-sync-conflict:${token}/right`);
    this.documents.set(leftUri.toString(), left);
    this.documents.set(rightUri.toString(), right);
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `Cursor Setting Sync Conflict: ${resourceId}`,
      { preview: true },
    );
  }
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
  let content: Buffer;
  try {
    content = await repository.readObject(tip.payload);
  } catch {
    // A payload compacted behind a checkpoint degrades the preview to the
    // sides that remain readable instead of failing the whole flow.
    return "[Payload content is unavailable; it may have been compacted]\n";
  }
  if (content.byteLength > 1024 * 1024) {
    return `[Payload is ${content.byteLength} bytes; preview omitted]\n`;
  }
  const text = content.toString("utf8");
  return text.includes("\uFFFD")
    ? `[Binary payload]\n${content.toString("base64")}`
    : text;
}
