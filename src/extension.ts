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
  | "sync-apply"
  | "conflicts"
  | "recover-chats"
  | "restore-data"
  | "repository-devices";

type ManagementRoute =
  | ManagementAction
  | "sync"
  | "apply"
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

interface ManagementRouteItem extends vscode.QuickPickItem {
  action: ManagementRoute;
}

const MANAGEMENT_ITEMS: readonly ManagementItem[] = [
  {
    label: "$(pulse) Show Diagnostics",
    description: "status, warnings, pending work, repository usage",
    action: "diagnostics",
  },
  {
    label: "$(sync) Sync & Apply Now",
    description:
      "sync first; quit, apply offline, and relaunch only when changes are queued",
    action: "sync-apply",
  },
  {
    label: "$(diff) Resolve Conflicts",
    description: "choose between changes that cannot be merged safely",
    action: "conflicts",
  },
  {
    label: "$(wrench) Recover Chats…",
    description: "repair damaged chats or open a preserved recovery transcript",
    action: "recover-chats",
  },
  {
    label: "$(history) Restore Data…",
    description: "restore synchronized history or an emergency database backup",
    action: "restore-data",
  },
  {
    label: "$(device-desktop) Repository & Devices…",
    description: "set up, archive, manage peer streams, or disconnect this PC",
    action: "repository-devices",
  },
];

const RECOVER_CHAT_ITEMS: readonly ManagementRouteItem[] = [
  {
    label: "$(wrench) Check and Recover Current Chats",
    description: "audit, repair, or safely preserve unavailable conversations",
    action: "repair-chats",
  },
  {
    label: "$(comment-discussion) Open a Preserved Chat",
    description: "prepare one verified recovery transcript in an empty Agent",
    action: "open-recovered",
  },
];

const RESTORE_DATA_ITEMS: readonly ManagementRouteItem[] = [
  {
    label: "$(history) Restore a Synchronized Version",
    description: "publish an earlier repository version as the newest state",
    action: "restore-version",
  },
  {
    label: "$(database) Restore a Local Database Backup (Emergency)",
    description: "quit Cursor and transactionally import a pre-apply backup",
    action: "restore-backup",
  },
];

const REPOSITORY_DEVICE_ITEMS: readonly ManagementRouteItem[] = [
  {
    label: "$(settings-gear) Setup or Reconfigure This PC…",
    description: "connect this PC or switch synchronization repositories",
    action: "setup",
  },
  {
    label: "$(archive) Archive Repository…",
    description: "copy the complete encrypted repository to a safe location",
    action: "archive",
  },
  {
    label: "$(device-desktop) Retire or Restore Another Device…",
    description: "change which peer streams this PC reads",
    action: "forget-device",
  },
  {
    label: "$(debug-disconnect) Disconnect This PC",
    description: "clear this PC's path, key, and mappings; shared data stays",
    action: "disconnect",
  },
];

const MANAGEMENT_ROUTES: ReadonlySet<ManagementRoute> = new Set([
  ...MANAGEMENT_ITEMS.map((item) => item.action),
  ...RECOVER_CHAT_ITEMS.map((item) => item.action),
  ...RESTORE_DATA_ITEMS.map((item) => item.action),
  ...REPOSITORY_DEVICE_ITEMS.map((item) => item.action),
  // Status-bar actions deliberately bypass the menu. A normal sync click must
  // never inherit the top-level Sync & Apply action's potential Cursor quit.
  "sync",
  "apply",
]);

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
      const action = isManagementRoute(requestedAction)
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
        await runManagementRoute(activeManager, action);
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

function isManagementRoute(value: unknown): value is ManagementRoute {
  return typeof value === "string" && MANAGEMENT_ROUTES.has(value as ManagementRoute);
}

async function runManagementRoute(
  activeManager: SyncManager,
  action: ManagementRoute,
): Promise<void> {
  if (action === "recover-chats") {
    const selected = await showManagementSubmenu(
      "Recover Chats",
      "Choose a verified repair or preserved-chat workflow",
      RECOVER_CHAT_ITEMS,
    );
    if (selected !== undefined) {
      await runManagementRoute(activeManager, selected);
    }
    return;
  }
  if (action === "restore-data") {
    const selected = await showManagementSubmenu(
      "Restore Data",
      "Restores are explicit and never selected automatically",
      RESTORE_DATA_ITEMS,
    );
    if (selected !== undefined) {
      await runManagementRoute(activeManager, selected);
    }
    return;
  }
  if (action === "repository-devices") {
    const selected = await showManagementSubmenu(
      "Repository & Devices",
      "Repository and device changes always require your explicit choice",
      REPOSITORY_DEVICE_ITEMS,
    );
    if (selected !== undefined) {
      await runManagementRoute(activeManager, selected);
    }
    return;
  }
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
    case "sync-apply":
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

async function showManagementSubmenu(
  title: string,
  placeHolder: string,
  items: readonly ManagementRouteItem[],
): Promise<ManagementRoute | undefined> {
  return (
    await vscode.window.showQuickPick(items, {
      title: `${MANAGE_TITLE}: ${title}`,
      placeHolder,
      matchOnDescription: true,
    })
  )?.action;
}
