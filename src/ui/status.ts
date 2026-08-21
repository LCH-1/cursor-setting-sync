import * as vscode from "vscode";
import {
  MANAGE_COMMAND,
  RESTART_TO_APPLY_TITLE,
} from "../constants";

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
  command: vscode.Command;
} {
  switch (status) {
    case "unconfigured":
      return {
        text: "$(cloud) Cursor Setting Sync: Setup",
        tooltip: "Select a shared folder and configure encryption.",
        command: managementAction("setup", "Set up Cursor Setting Sync"),
      };
    case "locked":
      return {
        text: "$(lock) Cursor Setting Sync",
        tooltip:
          "The repository key is not available on this device. Click to re-enter the passphrase, or open Manage and choose Disconnect This PC to clear the local configuration.",
        command: managementAction("setup", "Unlock Cursor Setting Sync"),
      };
    case "disabled":
      // A configured repository with automatic sync switched off used to show
      // "Setup", whose click opens the first-run folder picker against a
      // working repository. It is paused, not unconfigured.
      return {
        text: "$(circle-slash) Cursor Setting Sync: Paused",
        tooltip:
          "Automatic synchronization is off (cursorSettingSync.enabled). Click to synchronize once.",
        command: managementAction("sync", "Synchronize now"),
      };
    case "syncing":
      // Says the word, not just a spinning glyph. A cycle on a large repository
      // runs for minutes, and an icon that changes shape is not something
      // anyone reads as "busy" while they are waiting to know whether their
      // chats have arrived.
      return {
        text: "$(sync~spin) Cursor Setting Sync: Syncing...",
        tooltip: "Synchronization is in progress.",
        command: managementAction("diagnostics", "Show sync diagnostics"),
      };
    case "up-to-date":
      return {
        text: "$(check) Cursor Setting Sync",
        tooltip: "All locally available events are applied.",
        command: managementAction("sync", "Synchronize now"),
      };
    case "partial":
      // Everything that can sync is in sync, but whole resource kinds are
      // switched off. A plain check mark there is a lie the user only
      // discovers weeks later.
      return {
        text: "$(warning) Cursor Setting Sync: Partial",
        tooltip:
          "Some resource kinds are not synchronizing. Open diagnostics for details.",
        command: managementAction("diagnostics", "Show sync diagnostics"),
      };
    case "pending-restart":
      // Describes the state, and only the state.
      //
      // It read like the name of the command, which was a promise the click
      // stopped keeping the moment that click was pointed somewhere harmless:
      // pressing a button labelled "Restart to Apply" and being handed a
      // diagnostics document instead is worse than either behaviour alone.
      // Quitting Cursor is too large a thing to sit one misclick away from the
      // item beside it, so the click still only reports - and the label no
      // longer claims otherwise. The command is in the palette, where running
      // it is deliberate, and the tooltip says so.
      return {
        text: "$(debug-restart) Cursor Setting Sync: Queued",
        tooltip:
          "Changes from another device are waiting to be written. They apply automatically after every Cursor window closes. " +
          `To apply them immediately, open "${RESTART_TO_APPLY_TITLE}". Clicking here opens diagnostics.`,
        command: managementAction("diagnostics", "Show queued changes"),
      };
    case "conflict":
      return {
        text: "$(warning) Cursor Setting Sync",
        tooltip: "One or more synchronization conflicts require attention.",
        command: managementAction("conflicts", "Resolve sync conflicts"),
      };
    case "error":
      return {
        text: "$(error) Cursor Setting Sync",
        tooltip: "Synchronization failed. Open diagnostics for details.",
        command: managementAction("diagnostics", "Show sync diagnostics"),
      };
  }
}

function managementAction(action: string, title: string): vscode.Command {
  return {
    command: MANAGE_COMMAND,
    title,
    arguments: [action],
  };
}
