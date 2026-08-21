import * as vscode from "vscode";
import { ExtensionConfiguration } from "./config";
import { resolveCursorPaths } from "./platform/paths";
import { inspectCompatibility } from "./platform/compatibility";
import { SyncManager } from "./sync/manager";
import { StatusController } from "./ui/status";
import { ConflictController } from "./ui/conflicts";
import { MANAGE_COMMAND, MANAGE_TITLE } from "./constants";

let manager: SyncManager | null = null;

const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
  "win32",
  "darwin",
  "linux",
]);

type ManagementAction =
  | "diagnostics"
  | "sync"
  | "apply"
  | "conflicts"
  | "repair-chats"
  | "open-recovered"
  | "restore-version"
  | "restore-backup"
  | "archive"
  | "forget-device"
  | "setup"
  | "disconnect";

interface ManagementItem extends vscode.QuickPickItem {
  action: ManagementAction;
}

const MANAGEMENT_ITEMS: readonly ManagementItem[] = [
  {
    label: "$(pulse) Show Diagnostics",
    description: "status, warnings, pending work, repository usage",
    action: "diagnostics",
  },
  {
    label: "$(sync) Sync Now",
    description: "normally automatic; force one bounded cycle now",
    action: "sync",
  },
  {
    label: "$(debug-restart) Apply Queued Changes",
    description:
      "quit Cursor, apply offline, then relaunch; normally automatic on shutdown",
    action: "apply",
  },
  {
    label: "$(diff) Resolve Conflicts",
    description: "choose between changes that cannot be merged safely",
    action: "conflicts",
  },
  {
    label: "$(wrench) Repair Unavailable Chats",
    description: "audit and safely repair or preserve damaged conversations",
    action: "repair-chats",
  },
  {
    label: "$(comment-discussion) Open Recovered Chat",
    description: "open one previously preserved recovery transcript",
    action: "open-recovered",
  },
  {
    label: "$(history) Restore Version History",
    description: "publish an earlier synchronized resource version",
    action: "restore-version",
  },
  {
    label: "$(database) Restore Database Backup",
    description: "restore a pre-apply SQLite backup while Cursor is closed",
    action: "restore-backup",
  },
  {
    label: "$(archive) Archive Repository",
    description: "copy the complete encrypted repository to a safe location",
    action: "archive",
  },
  {
    label: "$(device-desktop) Forget Device",
    description: "retire or restore a device stream",
    action: "forget-device",
  },
  {
    label: "$(settings-gear) Setup or Reconfigure",
    description: "connect this PC to a sync repository",
    action: "setup",
  },
  {
    label: "$(debug-disconnect) Disconnect This PC",
    description: "clear only this PC's repository configuration and key",
    action: "disconnect",
  },
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    registerUnsupportedPlatformCommands(context);
    return;
  }
  const status = new StatusController();
  const conflicts = new ConflictController();
  const paths = resolveCursorPaths(context, vscode.env.appRoot);
  const packageJson = context.extension.packageJSON as { version?: unknown };
  const extensionVersion =
    typeof packageJson.version === "string" ? packageJson.version : "unknown";
  const compatibility = await inspectCompatibility(paths, extensionVersion);
  const configuration = new ExtensionConfiguration(context);
  manager = new SyncManager(
    context,
    paths,
    compatibility,
    configuration,
    status,
    conflicts,
  );
  context.subscriptions.push(
    status,
    conflicts,
    manager,
    registerCommand(MANAGE_COMMAND, async (requestedAction) => {
      const activeManager = manager;
      if (activeManager === null) {
        return;
      }
      const action = isManagementAction(requestedAction)
        ? requestedAction
        : (
            await vscode.window.showQuickPick(MANAGEMENT_ITEMS, {
              title: MANAGE_TITLE,
              placeHolder:
                "Synchronization, live file apply, shutdown database apply, and repository maintenance are automatic.",
              matchOnDescription: true,
            })
          )?.action;
      if (action !== undefined) {
        await runManagementAction(activeManager, action);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("cursorSettingSync") ||
        event.affectsConfiguration("cursorSync")
      ) {
        const activeManager = manager;
        if (activeManager !== null) {
          void activeManager.configurationChanged().catch((error: unknown) => {
            void vscode.window.showErrorMessage(
              `Cursor Setting Sync configuration update failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
      }
    }),
  );

  for (const warning of compatibility.warnings) {
    status.log(`Compatibility warning: ${warning}`);
  }
  for (const reason of compatibility.reasons) {
    status.log(`Database writes disabled: ${reason}`);
  }
  // Losing the database capability silently drops profiles, UI state,
  // extensions and all chat from the sync set, and the status bar still shows
  // a green check mark because the remaining file resources really are up to
  // date. An output-channel line nobody opens is not a signal.
  announceReducedCapability(compatibility, status);

  try {
    await manager.initialize();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.log(`Activation failed: ${message}`);
    status.setStatus("error", message);
    void vscode.window.showErrorMessage(`Cursor Setting Sync activation failed: ${message}`);
  }
}

function announceReducedCapability(
  compatibility: Awaited<ReturnType<typeof inspectCompatibility>>,
  status: StatusController,
): void {
  const problems = [...compatibility.reasons, ...compatibility.warnings];
  if (problems.length === 0) {
    return;
  }
  const headline = compatibility.compatible
    ? "Cursor Setting Sync: some resources may not synchronize on this Cursor build."
    : "Cursor Setting Sync: profiles, UI state, extensions and chat will not synchronize on this Cursor build.";
  const action = "Show Diagnostics";
  void vscode.window
    .showWarningMessage(`${headline} ${problems[0] ?? ""}`.trim(), action)
    .then((choice) => {
      if (choice === action) {
        void vscode.commands.executeCommand(MANAGE_COMMAND, "diagnostics");
      }
    }, () => {
      status.log("Unable to show the compatibility notification.");
    });
}

export async function deactivate(): Promise<void> {
  const activeManager = manager;
  manager = null;
  await activeManager?.shutdown();
}

function registerUnsupportedPlatformCommands(
  context: vscode.ExtensionContext,
): void {
  // Cursor paths, the offline helper, and database handling exist only for
  // the supported platform set. Registering the contributed commands as clear
  // no-ops avoids an opaque activation failure elsewhere.
  const message = "Cursor Setting Sync supports Windows, macOS and Linux.";
  context.subscriptions.push(
    vscode.commands.registerCommand(MANAGE_COMMAND, () => {
      void vscode.window.showInformationMessage(message);
    }),
  );
  context.subscriptions.push(
    vscode.window.setStatusBarMessage("Cursor Setting Sync: unsupported platform"),
  );
}

function registerCommand(
  command: string,
  callback: (...args: unknown[]) => Promise<void> | undefined,
): vscode.Disposable {
  return vscode.commands.registerCommand(command, async (...args: unknown[]) => {
    try {
      await callback(...args);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Cursor Setting Sync: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

function isManagementAction(value: unknown): value is ManagementAction {
  return MANAGEMENT_ITEMS.some((item) => item.action === value);
}

async function runManagementAction(
  activeManager: SyncManager,
  action: ManagementAction,
): Promise<void> {
  if (action === "setup") {
    await activeManager.setup();
    return;
  }
  if (action === "disconnect") {
    await activeManager.disconnect();
    return;
  }
  if (action === "open-recovered") {
    await activeManager.openRecoveredChatSafely();
    return;
  }
  await activeManager.prepareForRepositoryCommand();
  switch (action) {
    case "diagnostics":
      await activeManager.showDiagnostics();
      return;
    case "sync":
      await activeManager.syncNowCommand();
      return;
    case "apply":
      await activeManager.restartToApply();
      return;
    case "conflicts":
      await activeManager.resolveConflicts();
      return;
    case "repair-chats":
      await activeManager.repairUnavailableChats();
      return;
    case "restore-version":
      await activeManager.restoreVersion();
      return;
    case "restore-backup":
      await activeManager.restoreBackup();
      return;
    case "archive":
      await activeManager.archiveRepository();
      return;
    case "forget-device":
      await activeManager.forgetDevice();
      return;
  }
}
