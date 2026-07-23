import * as vscode from "vscode";

export type SyncStatus =
  | "unconfigured"
  | "locked"
  | "syncing"
  | "up-to-date"
  | "pending-restart"
  | "conflict"
  | "error";

export class StatusController implements vscode.Disposable {
  readonly output = vscode.window.createOutputChannel("Cursor Setting Sync");
  private readonly item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    90,
  );

  constructor() {
    this.item.name = "Cursor Setting Sync";
    this.setStatus("unconfigured");
    this.item.show();
  }

  setStatus(status: SyncStatus, detail?: string): void {
    const presentation = statusPresentation(status);
    this.item.text = presentation.text;
    this.item.tooltip = detail ?? presentation.tooltip;
    this.item.command = presentation.command;
    this.item.backgroundColor =
      status === "error"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : status === "conflict"
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
  }

  log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  show(): void {
    this.output.show(true);
  }

  dispose(): void {
    this.item.dispose();
    this.output.dispose();
  }
}

function statusPresentation(status: SyncStatus): {
  text: string;
  tooltip: string;
  command: string;
} {
  switch (status) {
    case "unconfigured":
      return {
        text: "$(cloud) Cursor Setting Sync: Setup",
        tooltip: "Select a shared folder and configure encryption.",
        command: "cursorSync.setup",
      };
    case "locked":
      return {
        text: "$(lock) Cursor Setting Sync",
        tooltip: "Unlock the synchronization repository.",
        command: "cursorSync.setup",
      };
    case "syncing":
      return {
        text: "$(sync~spin) Cursor Setting Sync",
        tooltip: "Synchronization is in progress.",
        command: "cursorSync.showDiagnostics",
      };
    case "up-to-date":
      return {
        text: "$(check) Cursor Setting Sync",
        tooltip: "All locally available events are applied.",
        command: "cursorSync.syncNow",
      };
    case "pending-restart":
      return {
        text: "$(debug-restart) Cursor Setting Sync",
        tooltip: "Restart Cursor to apply database-backed resources.",
        command: "cursorSync.restartToApply",
      };
    case "conflict":
      return {
        text: "$(warning) Cursor Setting Sync",
        tooltip: "One or more synchronization conflicts require attention.",
        command: "cursorSync.resolveConflicts",
      };
    case "error":
      return {
        text: "$(error) Cursor Setting Sync",
        tooltip: "Synchronization failed. Open diagnostics for details.",
        command: "cursorSync.showDiagnostics",
      };
  }
}
