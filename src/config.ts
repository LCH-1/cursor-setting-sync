import * as vscode from "vscode";
import {
  DEFAULT_CHAT_POLL_INTERVAL_SECONDS,
  MAX_APPLY_BATCH_BYTES,
  DEFAULT_MAX_PAYLOAD_MIB,
  DEFAULT_POLL_INTERVAL_SECONDS,
} from "./constants";
import { activateRepository } from "./configRepository";

const REPOSITORY_PATH_KEY = "repositoryPath";
const REPOSITORY_ID_KEY = "repositoryId";
const WORKSPACE_MAPPINGS_KEY = "workspaceMappings";

export const CONFIGURATION_SECTION = "cursorSettingSync";
export const LEGACY_CONFIGURATION_SECTION = "cursorSync";

function explicitlySet(
  inspected: ReturnType<vscode.WorkspaceConfiguration["inspect"]> | undefined,
): boolean {
  return (
    inspected !== undefined &&
    (inspected.globalValue !== undefined ||
      inspected.workspaceValue !== undefined ||
      inspected.workspaceFolderValue !== undefined)
  );
}

/**
 * Reads cursorSettingSync.<key>, falling back to a value the user still has
 * under the legacy cursorSync.<key> namespace from before the rename.
 */
function setting<T>(key: string, defaultValue: T): T {
  const current = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  if (explicitlySet(current.inspect<T>(key))) {
    return current.get<T>(key, defaultValue);
  }
  const legacy = vscode.workspace.getConfiguration(LEGACY_CONFIGURATION_SECTION);
  if (explicitlySet(legacy.inspect<T>(key))) {
    return legacy.get<T>(key, defaultValue);
  }
  return current.get<T>(key, defaultValue);
}

export class ExtensionConfiguration {
  constructor(private readonly context: vscode.ExtensionContext) {}

  get repositoryPath(): string | null {
    return this.context.globalState.get<string>(REPOSITORY_PATH_KEY) ?? null;
  }

  get repositoryId(): string | null {
    return this.context.globalState.get<string>(REPOSITORY_ID_KEY) ?? null;
  }

  get workspaceMappings(): Record<string, string> {
    return (
      this.context.globalState.get<Record<string, string>>(
        WORKSPACE_MAPPINGS_KEY,
      ) ?? {}
    );
  }

  get enabled(): boolean {
    return setting<boolean>("enabled", true);
  }

  get pollIntervalSeconds(): number {
    return setting<number>("pollIntervalSeconds", DEFAULT_POLL_INTERVAL_SECONDS);
  }

  get chatPollIntervalSeconds(): number {
    return setting<number>(
      "chatPollIntervalSeconds",
      DEFAULT_CHAT_POLL_INTERVAL_SECONDS,
    );
  }

  get autoApplyFiles(): boolean {
    return setting<boolean>("autoApplyFiles", true);
  }

  get syncChat(): boolean {
    return setting<boolean>("syncChat", true);
  }

  get syncWorkspaceStorage(): boolean {
    return setting<boolean>("syncWorkspaceStorage", true);
  }

  get gitSync(): boolean {
    return setting<boolean>("gitSync", true);
  }

  get ignoredSettings(): string[] {
    return stringArray(setting<string[]>("ignoredSettings", []));
  }

  /**
   * Whether the built-in machine-specific key list is honored. Off means the
   * user takes responsibility for `ignoredSettings` themselves.
   */
  get useDefaultIgnoredSettings(): boolean {
    return setting<boolean>("useDefaultIgnoredSettings", true);
  }

  get ignoredExtensions(): string[] {
    return stringArray(setting<string[]>("ignoredExtensions", []));
  }

  get ignoredUiStateKeys(): string[] {
    return stringArray(setting<string[]>("ignoredUiStateKeys", []));
  }

  get ignoredUserFiles(): string[] {
    return stringArray(setting<string[]>("ignoredUserFiles", []));
  }

  /**
   * Workspace URIs whose workspaceStorage this computer stays out of.
   *
   * Machine-scoped on purpose. Which projects live on this computer is a fact
   * about this computer, and every other `cursorSettingSync.*` key travels with
   * the settings themselves - so a shared list would switch the other machine's
   * backups off as a side effect of curating this one's.
   */
  get ignoredWorkspaces(): string[] {
    return stringArray(setting<string[]>("ignoredWorkspaces", []));
  }

  get maxPayloadBytes(): number {
    const raw = setting<number>("maxPayloadMiB", DEFAULT_MAX_PAYLOAD_MIB);
    const mebibytes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PAYLOAD_MIB;
    return Math.max(
      1024 * 1024,
      Math.min(Math.floor(mebibytes * 1024 * 1024), MAX_APPLY_BATCH_BYTES),
    );
  }

  async setRepository(
    repositoryPath: string,
    repositoryId: string,
    masterKey: Buffer,
  ): Promise<void> {
    await activateRepository(
      {
        currentRepositoryId: this.repositoryId,
        storeMasterKey: async (id, encodedMasterKey) =>
          this.context.secrets.store(masterKeySecret(id), encodedMasterKey),
        clearWorkspaceMappings: async () =>
          this.context.globalState.update(WORKSPACE_MAPPINGS_KEY, undefined),
        setRepositoryPath: async (path) =>
          this.context.globalState.update(REPOSITORY_PATH_KEY, path),
        setRepositoryId: async (id) =>
          this.context.globalState.update(REPOSITORY_ID_KEY, id),
        deleteMasterKey: async (id) =>
          this.context.secrets.delete(masterKeySecret(id)),
      },
      repositoryPath,
      repositoryId,
      masterKey.toString("base64"),
    );
  }

  async getMasterKey(): Promise<Buffer | null> {
    const repositoryId = this.repositoryId;
    if (repositoryId === null) {
      return null;
    }
    const stored = await this.context.secrets.get(masterKeySecret(repositoryId));
    return stored === undefined ? null : Buffer.from(stored, "base64");
  }

  async setWorkspaceMapping(sourceId: string, targetId: string): Promise<void> {
    await this.context.globalState.update(WORKSPACE_MAPPINGS_KEY, {
      ...this.workspaceMappings,
      [sourceId]: targetId,
    });
  }

  async clearRepository(): Promise<void> {
    const repositoryId = this.repositoryId;
    if (repositoryId !== null) {
      await this.context.secrets.delete(masterKeySecret(repositoryId));
    }
    await this.context.globalState.update(REPOSITORY_PATH_KEY, undefined);
    await this.context.globalState.update(REPOSITORY_ID_KEY, undefined);
    await this.context.globalState.update(WORKSPACE_MAPPINGS_KEY, undefined);
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function masterKeySecret(repositoryId: string): string {
  return `repositoryMasterKey:${repositoryId}`;
}
