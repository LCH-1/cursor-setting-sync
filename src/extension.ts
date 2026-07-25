import * as vscode from "vscode";
import { ExtensionConfiguration } from "./config";
import { resolveCursorPaths } from "./platform/paths";
import { inspectCompatibility } from "./platform/compatibility";
import { SyncManager } from "./sync/manager";
import { StatusController } from "./ui/status";
import { ConflictController } from "./ui/conflicts";

let manager: SyncManager | null = null;

const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
  "win32",
  "darwin",
  "linux",
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
    registerCommand("cursorSync.setup", () => manager?.setup()),
    registerCommand("cursorSync.syncNow", () => manager?.syncNowCommand()),
    registerCommand("cursorSync.restartToApply", () =>
      manager?.restartToApply(),
    ),
    registerCommand("cursorSync.resolveConflicts", () =>
      manager?.resolveConflicts(),
    ),
    registerCommand("cursorSync.restoreVersion", () =>
      manager?.restoreVersion(),
    ),
    registerCommand("cursorSync.showDiagnostics", () =>
      manager?.showDiagnostics(),
    ),
    registerCommand("cursorSync.restoreBackup", () =>
      manager?.restoreBackup(),
    ),
    registerCommand("cursorSync.forgetDevice", () => manager?.forgetDevice()),
    registerCommand("cursorSync.repositoryUsage", () =>
      manager?.showRepositoryUsage(),
    ),
    registerCommand("cursorSync.compactRepository", () =>
      manager?.compactRepository(),
    ),
    registerCommand("cursorSync.checkpointRepository", () =>
      manager?.checkpointRepository(),
    ),
    registerCommand("cursorSync.archiveRepository", () =>
      manager?.archiveRepository(),
    ),
    registerCommand("cursorSync.disconnect", () => manager?.disconnect()),
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
        void vscode.commands.executeCommand("cursorSync.showDiagnostics");
      }
    }, () => {
      status.log("Unable to show the compatibility notification.");
    });
}

export function deactivate(): void {
  manager?.dispose();
  manager = null;
}

function registerUnsupportedPlatformCommands(
  context: vscode.ExtensionContext,
): void {
  // Cursor paths, the offline helper, and database handling exist only for
  // the supported platform set. Registering the contributed commands as clear
  // no-ops avoids an opaque activation failure elsewhere.
  const message = "Cursor Setting Sync supports Windows, macOS and Linux.";
  for (const command of [
    "cursorSync.setup",
    "cursorSync.syncNow",
    "cursorSync.restartToApply",
    "cursorSync.resolveConflicts",
    "cursorSync.restoreVersion",
    "cursorSync.showDiagnostics",
    "cursorSync.restoreBackup",
    "cursorSync.forgetDevice",
    "cursorSync.repositoryUsage",
    "cursorSync.compactRepository",
    "cursorSync.checkpointRepository",
    "cursorSync.archiveRepository",
    "cursorSync.disconnect",
  ]) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        void vscode.window.showInformationMessage(message);
      }),
    );
  }
  context.subscriptions.push(
    vscode.window.setStatusBarMessage("Cursor Setting Sync: unsupported platform"),
  );
}

function registerCommand(
  command: string,
  callback: () => Promise<void> | undefined,
): vscode.Disposable {
  return vscode.commands.registerCommand(command, async () => {
    try {
      await callback();
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Cursor Setting Sync: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}
