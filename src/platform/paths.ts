import { homedir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";

export interface CursorPaths {
  appRoot: string;
  userDataRoot: string;
  globalStorageRoot: string;
  globalDatabase: string;
  workspaceStorageRoot: string;
  profilesRoot: string;
  snippetsRoot: string;
  promptsRoot: string;
  userTasks: string;
  userMcp: string;
  cursorHome: string;
  cursorMcp: string;
  cursorCliConfig: string;
  cursorCommands: string;
  cursorSkills: string;
  cursorRules: string;
  cursorProjects: string;
  cursorChats: string;
  cursorAcpSessions: string;
  cursorExtensionsManifest: string;
  extensionStorage: string;
  helperScript: string;
}

export interface PlatformEnvironment {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export function resolveUserDataRoot(
  environment: PlatformEnvironment = {},
): string {
  const platform = environment.platform ?? process.platform;
  const env = environment.env ?? process.env;
  if (platform === "win32") {
    const appData = env.APPDATA;
    if (appData === undefined || appData.length === 0) {
      throw new Error("APPDATA is required on Windows.");
    }
    return join(appData, "Cursor", "User");
  }
  const home = environment.home ?? homedir();
  if (home.length === 0) {
    throw new Error("A home directory is required to locate Cursor user data.");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Cursor", "User");
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME;
  const configRoot =
    xdgConfigHome === undefined || xdgConfigHome.length === 0
      ? join(home, ".config")
      : xdgConfigHome;
  return join(configRoot, "Cursor", "User");
}

export function resolveCursorPaths(
  context: vscode.ExtensionContext,
  appRoot: string,
  environment: PlatformEnvironment = {},
): CursorPaths {
  const userDataRoot = resolveUserDataRoot(environment);
  const globalStorageRoot = join(userDataRoot, "globalStorage");
  const cursorHome = join(environment.home ?? homedir(), ".cursor");

  return {
    appRoot,
    userDataRoot,
    globalStorageRoot,
    globalDatabase: join(globalStorageRoot, "state.vscdb"),
    workspaceStorageRoot: join(userDataRoot, "workspaceStorage"),
    profilesRoot: join(userDataRoot, "profiles"),
    snippetsRoot: join(userDataRoot, "snippets"),
    promptsRoot: join(userDataRoot, "prompts"),
    userTasks: join(userDataRoot, "tasks.json"),
    userMcp: join(userDataRoot, "mcp.json"),
    cursorHome,
    cursorMcp: join(cursorHome, "mcp.json"),
    cursorCliConfig: join(cursorHome, "cli-config.json"),
    cursorCommands: join(cursorHome, "commands"),
    cursorSkills: join(cursorHome, "skills"),
    cursorRules: join(cursorHome, "rules"),
    cursorProjects: join(cursorHome, "projects"),
    cursorChats: join(cursorHome, "chats"),
    cursorAcpSessions: join(cursorHome, "acp-sessions"),
    cursorExtensionsManifest: join(cursorHome, "extensions", "extensions.json"),
    extensionStorage: context.globalStorageUri.fsPath,
    helperScript: join(context.extensionPath, "dist", "helper.js"),
  };
}
