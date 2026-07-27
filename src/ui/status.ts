import * as vscode from "vscode";
import { RESTART_TO_APPLY_TITLE } from "../constants";

export type SyncStatus =
  | "unconfigured"
  | "locked"
  | "disabled"
  | "syncing"
  | "up-to-date"
  | "partial"
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
        : status === "conflict" || status === "partial"
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
        tooltip:
          "The repository key is not available on this device. Click to re-enter the passphrase, or run \"Cursor Setting Sync: Disconnect\" to clear the local configuration.",
        command: "cursorSync.setup",
      };
    case "disabled":
      // A configured repository with automatic sync switched off used to show
      // "Setup", whose click opens the first-run folder picker against a
      // working repository. It is paused, not unconfigured.
      return {
        text: "$(circle-slash) Cursor Setting Sync: Paused",
        tooltip:
          "Automatic synchronization is off (cursorSettingSync.enabled). Click to synchronize once.",
        command: "cursorSync.syncNow",
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
    case "partial":
      // Everything that can sync is in sync, but whole resource kinds are
      // switched off. A plain check mark there is a lie the user only
      // discovers weeks later.
      return {
        text: "$(warning) Cursor Setting Sync: Partial",
        tooltip:
          "Some resource kinds are not synchronizing. Open diagnostics for details.",
        command: "cursorSync.showDiagnostics",
      };
    case "pending-restart":
      // Naming the command in the item itself, not just the tooltip: the old
      // text said "restart", the user quit and relaunched Cursor, and the queue
      // was still there afterwards - because the shutdown finalizer exports
      // without applying. Nobody hovers a status item to discover that.
      return {
        text: `$(debug-restart) ${RESTART_TO_APPLY_TITLE}`,
        tooltip:
          `Changes from another device are queued. Run "${RESTART_TO_APPLY_TITLE}" to write them - ` +
          "quitting and reopening Cursor does not, because only that command applies the queue.",
        // Reports, does not act. Clicking used to quit Cursor outright, which
        // is a large thing to do to someone who was aiming for the item next to
        // it - and the command is a rare, deliberate one, not something worth a
        // permanent button. Diagnostics is the safe destination; the text and
        // tooltip name the command so the palette is one step away.
        command: "cursorSync.showDiagnostics",
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
