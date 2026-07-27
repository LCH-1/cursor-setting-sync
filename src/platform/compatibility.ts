import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type {
  DatabaseCapability,
  DatabaseCapabilityStatus,
  CompatibilityReport,
  EventProducer,
  ResourceKind,
} from "../types";
import { pathExists } from "./files";
import type { CursorPaths } from "./paths";
import {
  inspectSqliteCapabilities,
  openDatabase,
} from "./sqlite";

interface CursorProduct {
  version?: string;
  vscodeVersion?: string;
}

const ITEM_TABLE_COLUMNS: Record<string, string[]> = {
  ItemTable: ["key", "value"],
};

const CHAT_TABLE_COLUMNS: Record<string, string[]> = {
  composerHeaders: [
    "composerId",
    "workspaceId",
    "createdAt",
    "lastUpdatedAt",
    "isArchived",
    "isSubagent",
    "recency",
    "checkpointAt",
    "value",
  ],
  cursorDiskKV: ["key", "value"],
};

export async function inspectCompatibility(
  paths: CursorPaths,
  extensionVersion: string,
): Promise<CompatibilityReport> {
  const warnings: string[] = [];
  const product = await readProduct(paths.appRoot);
  const cursorVersion = product.version ?? "unknown";
  const vscodeVersion = product.vscodeVersion ?? "unknown";
  const sqlite = inspectSqliteCapabilities();
  const runtimeReasons: string[] = [];

  if (!sqlite.database) {
    runtimeReasons.push("The Cursor Node runtime does not expose node:sqlite.");
  }
  if (!sqlite.backup) {
    runtimeReasons.push("The Cursor Node runtime does not expose node:sqlite backup.");
  }

  const databaseCapabilities: CompatibilityReport["databaseCapabilities"] = {
    "global-item-table": capability(runtimeReasons),
    "global-chat": capability(runtimeReasons),
    "sqlite-files": capability(runtimeReasons),
  };
  if (runtimeReasons.length === 0) {
    if (!(await pathExists(paths.globalDatabase))) {
      const reason = `Cursor global database was not found: ${paths.globalDatabase}`;
      databaseCapabilities["global-item-table"] = capability([reason]);
      databaseCapabilities["global-chat"] = capability([reason]);
    } else {
      const global = inspectGlobalDatabaseSchemaCapabilities(
        paths.globalDatabase,
        warnings,
      );
      databaseCapabilities["global-item-table"] = global["global-item-table"];
      databaseCapabilities["global-chat"] = global["global-chat"];
    }
  }

  if (!isExpectedCursorExecutable(process.execPath)) {
    warnings.push(`Unexpected extension host executable: ${process.execPath}`);
  }

  const compatible = Object.values(databaseCapabilities).some(
    (status) => status.available,
  );
  if (compatible) {
    for (const [name, status] of Object.entries(databaseCapabilities)) {
      if (!status.available) {
        warnings.push(
          `${capabilityLabel(name as DatabaseCapability)} synchronization is unavailable: ${status.reasons.join(" ")}`,
        );
      }
    }
  }
  const reasons = compatible
    ? []
    : uniqueReasons(
        Object.values(databaseCapabilities).flatMap((status) => status.reasons),
      );

  return {
    compatible,
    extensionVersion,
    cursorVersion,
    vscodeVersion,
    nodeVersion: process.version,
    sqliteAvailable: sqlite.database,
    sqliteBackupAvailable: sqlite.backup,
    globalDatabasePath: paths.globalDatabase,
    databaseCapabilities,
    reasons,
    warnings,
  };
}

export function assertCompatibleForDatabaseWrite(report: CompatibilityReport): void {
  const reasons = uniqueReasons([
    ...report.databaseCapabilities["global-item-table"].reasons,
    ...report.databaseCapabilities["global-chat"].reasons,
  ]);
  if (
    !hasDatabaseCapability(report, "global-item-table") ||
    !hasDatabaseCapability(report, "global-chat")
  ) {
    throw new Error(`Full global database writes are disabled: ${reasons.join(" ")}`);
  }
}

export function assertDatabaseRuntimeForWrite(report: CompatibilityReport): void {
  const status = report.databaseCapabilities["sqlite-files"];
  if (!status.available) {
    throw new Error(`Database writes are disabled: ${status.reasons.join(" ")}`);
  }
}

export function hasDatabaseCapability(
  report: CompatibilityReport,
  capabilityName: DatabaseCapability,
): boolean {
  return report.databaseCapabilities[capabilityName].available;
}

export function isExpectedCursorExecutable(
  execPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    return execPath.toLowerCase().endsWith("cursor.exe");
  }
  const name = posix.basename(execPath);
  if (platform === "darwin") {
    return isMacosCursorProcessName(name);
  }
  return isLinuxCursorProcessName(name);
}

/**
 * What the user has to close when the offline helper gives up waiting.
 *
 * The bare "Timed out waiting for Cursor to exit." told a real user nothing:
 * they had already quit, and there was no way to learn what was still holding
 * the databases open. Two processes must never be listed as something to close
 * - the helper itself, which exits on its own, and a shutdown finalizer, whose
 * whole job is the workspaceStorage backup that killing it would destroy.
 */
export function cursorExitTimeoutDetail(
  survivors: readonly number[] | null,
  finalizerPid: number | null,
): string {
  if (survivors === null) {
    return (
      "The list of running Cursor processes could not be read, so what is still " +
      "holding the databases open is unknown. Close every Cursor window and try again."
    );
  }
  const closable = survivors.filter((pid) => pid !== finalizerPid);
  if (closable.length === 0) {
    return survivors.length === 0
      ? "Cursor has since exited, so running the command again should work."
      : "Only this extension's own shutdown helper is still running, and it exits on its own; running the command again shortly should work.";
  }
  const listed = closable.slice(0, LISTED_SURVIVOR_PIDS).join(", ");
  const remainder = Math.max(0, closable.length - LISTED_SURVIVOR_PIDS);
  return (
    `${closable.length} Cursor process(es) are still running (pid ${listed}${
      remainder === 0 ? "" : `, and ${remainder} more`
    }). ` +
    "Close every Cursor window - including any that is minimized, on another " +
    "desktop, or waiting on a 'save your changes?' prompt, which keeps the whole " +
    "application alive until it is answered - then run the command again."
  );
}

const LISTED_SURVIVOR_PIDS = 8;

export function parseCursorProcessIds(
  output: string,
  platform: NodeJS.Platform = process.platform,
): number[] {
  if (platform === "win32") {
    return [...output.matchAll(/"Cursor\.exe","(\d+)"/gi)].map((match) =>
      Number(match[1]),
    );
  }
  const pids: number[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid)) {
      continue;
    }
    const name = posix.basename(match[2]);
    const matches =
      platform === "darwin"
        ? isMacosCursorProcessName(name)
        : isLinuxCursorProcessName(name);
    if (matches) {
      pids.push(pid);
    }
  }
  return pids;
}

/**
 * The Windows gate counts every Cursor.exe, so macOS must also count the
 * renderer, GPU and plugin helpers: any of them can still hold state.vscdb
 * open while the offline helper writes to it.
 */
function isMacosCursorProcessName(name: string): boolean {
  return name === "Cursor" || name.startsWith("Cursor Helper");
}

function isLinuxCursorProcessName(name: string): boolean {
  return (
    name === "cursor" ||
    name.endsWith(".AppImage") ||
    name.endsWith(".appimage")
  );
}

const MACOS_BUNDLE_BINARY_SEGMENT = ".app/Contents/MacOS/";

export function cursorLaunchCommand(
  cursorExecutable: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (
    platform === "darwin" &&
    cursorExecutable.includes(MACOS_BUNDLE_BINARY_SEGMENT)
  ) {
    // Launch the outermost bundle so a helper-binary execPath still reopens
    // the application itself.
    const bundleEnd = cursorExecutable.indexOf(".app/") + ".app".length;
    return {
      command: "open",
      args: ["-a", cursorExecutable.slice(0, bundleEnd)],
    };
  }
  return { command: cursorExecutable, args: [] };
}

export function cursorExecutableForRestart(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): string {
  // An AppImage's FUSE mount (and with it execPath) disappears once the last
  // Cursor process exits, so the helper must relaunch the AppImage itself.
  if (
    platform === "linux" &&
    env.APPIMAGE !== undefined &&
    env.APPIMAGE.length > 0
  ) {
    return env.APPIMAGE;
  }
  return execPath;
}

const DATABASE_BACKED_KINDS = new Set<ResourceKind>([
  "extension",
  "profile",
  "ui-state",
  "cursor-user-rules",
  "chat",
  "chat-store",
  "workspace-storage",
]);

export function isDatabaseBackedKind(kind: ResourceKind): boolean {
  return DATABASE_BACKED_KINDS.has(kind);
}

export function databaseCapabilityBlockReason(
  kind: ResourceKind,
  local: CompatibilityReport,
): string | null {
  const capabilityName = databaseCapabilityForKind(kind);
  if (capabilityName === null) {
    return null;
  }
  const status = local.databaseCapabilities[capabilityName];
  return status.available
    ? null
    : `${capabilityLabel(capabilityName)} synchronization is unavailable: ${status.reasons.join(" ")}`;
}

export function databaseApplyBlockReason(
  kind: ResourceKind,
  producer: EventProducer | undefined,
  local: CompatibilityReport,
): string | null {
  const localBlock = databaseCapabilityBlockReason(kind, local);
  if (localBlock !== null) {
    return localBlock;
  }
  if (!isDatabaseBackedKind(kind)) {
    return null;
  }
  if (producer === undefined) {
    return "The incoming database event has no producer compatibility metadata.";
  }
  for (const [label, incoming, current] of [
    ["Cursor", producer.cursorVersion, local.cursorVersion],
    ["VS Code base", producer.vscodeVersion, local.vscodeVersion],
    ["extension", producer.extensionVersion, local.extensionVersion],
  ] as const) {
    const comparison = compareVersions(incoming, current);
    if (comparison === null) {
      return `Unable to compare the incoming ${label} version (${incoming}) with the local version (${current}).`;
    }
    if (comparison > 0) {
      return `Created by newer ${label} ${incoming}; update the local installation from ${current} before applying it.`;
    }
  }
  return null;
}

export function compareVersions(left: string, right: string): number | null {
  const leftParts = numericVersion(left);
  const rightParts = numericVersion(right);
  if (leftParts === null || rightParts === null) {
    return null;
  }
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return 0;
}

function numericVersion(value: string): number[] | null {
  const match = /^(?:v)?(\d+(?:\.\d+)*)(?:[-+].*)?$/.exec(value.trim());
  if (match?.[1] === undefined) {
    return null;
  }
  const parts = match[1].split(".").map(Number);
  return parts.every((part) => Number.isSafeInteger(part)) ? parts : null;
}

export function inspectGlobalDatabaseSchemaCapabilities(
  databasePath: string,
  warnings: string[] = [],
): Pick<
  CompatibilityReport["databaseCapabilities"],
  "global-item-table" | "global-chat"
> {
  let database: ReturnType<typeof openDatabase>;
  try {
    database = openDatabase(databasePath, { readOnly: true });
  } catch (error) {
    const reason = `Cursor global database could not be opened: ${formatError(error)}`;
    return {
      "global-item-table": capability([reason]),
      "global-chat": capability([reason]),
    };
  }
  try {
    database.exec("PRAGMA query_only=ON");
    const itemReasons = inspectRequiredTables(database, ITEM_TABLE_COLUMNS);
    const chatReasons = inspectRequiredTables(database, CHAT_TABLE_COLUMNS);
    const quickCheck = database.prepare("PRAGMA quick_check").get();
    if (quickCheck === undefined || quickCheck.quick_check !== "ok") {
      const reason = "Cursor global database quick_check did not return ok.";
      itemReasons.push(reason);
      chatReasons.push(reason);
    }
    const journalMode = database.prepare("PRAGMA journal_mode").get();
    if (journalMode?.journal_mode !== "wal") {
      warnings.push(`Unexpected journal mode: ${String(journalMode?.journal_mode)}`);
    }
    return {
      "global-item-table": capability(itemReasons),
      "global-chat": capability(chatReasons),
    };
  } catch (error) {
    const reason = `Cursor global database inspection failed: ${formatError(error)}`;
    return {
      "global-item-table": capability([reason]),
      "global-chat": capability([reason]),
    };
  } finally {
    database.close();
  }
}

function databaseCapabilityForKind(kind: ResourceKind): DatabaseCapability | null {
  if (
    kind === "extension" ||
    kind === "profile" ||
    kind === "ui-state" ||
    kind === "cursor-user-rules"
  ) {
    return "global-item-table";
  }
  if (kind === "chat") {
    return "global-chat";
  }
  if (kind === "chat-store" || kind === "workspace-storage") {
    return "sqlite-files";
  }
  return null;
}

function inspectRequiredTables(
  database: ReturnType<typeof openDatabase>,
  expected: Readonly<Record<string, readonly string[]>>,
): string[] {
  const reasons: string[] = [];
  for (const [table, expectedColumns] of Object.entries(expected)) {
    const tableRow = database
      .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
      .get("table", table);
    if (tableRow === undefined) {
      reasons.push(`Required table is missing: ${table}`);
      continue;
    }
    const columns = database
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((row) => String(row.name));
    const missing = expectedColumns.filter((column) => !columns.includes(column));
    if (missing.length > 0) {
      reasons.push(`Table ${table} is missing columns: ${missing.join(", ")}`);
    }
  }
  return reasons;
}

function capability(reasons: readonly string[]): DatabaseCapabilityStatus {
  const unique = uniqueReasons(reasons);
  return { available: unique.length === 0, reasons: unique };
}

function capabilityLabel(capabilityName: DatabaseCapability): string {
  if (capabilityName === "global-item-table") {
    return "Global settings database";
  }
  if (capabilityName === "global-chat") {
    return "Global chat database";
  }
  return "SQLite file";
}

function uniqueReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons)];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readProduct(appRoot: string): Promise<CursorProduct> {
  const content = await readFile(join(appRoot, "product.json"), "utf8");
  return JSON.parse(content) as CursorProduct;
}
