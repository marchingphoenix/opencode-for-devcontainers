import * as vscode from "vscode";

export interface ExtensionConfig {
  opencodePath: string;
  opencodeConfigPath: string;
  devcontainerPath: string;
  dockerPath: string;
  devcontainerCliPath: string;
  executionMode: "local-with-remote-exec" | "in-container";
  containerWorkspaceFolder: string;
  additionalEnvVars: Record<string, string>;
  forwardEnvVars: string[];
}

export function getConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration("opencode-devcontainer");
  return {
    opencodePath: config.get<string>("opencodePath", "opencode"),
    opencodeConfigPath: config.get<string>("opencodeConfigPath", ""),
    devcontainerPath: config.get<string>("devcontainerPath", ""),
    dockerPath: config.get<string>("dockerPath", "docker"),
    devcontainerCliPath: config.get<string>("devcontainerCliPath", "devcontainer"),
    executionMode: config.get<"local-with-remote-exec" | "in-container">(
      "executionMode",
      "local-with-remote-exec"
    ),
    containerWorkspaceFolder: config.get<string>("containerWorkspaceFolder", ""),
    additionalEnvVars: config.get<Record<string, string>>("additionalEnvVars", {}),
    forwardEnvVars: config.get<string[]>("forwardEnvVars", [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENCODE_*",
    ]),
  };
}

export function getWorkspaceFolder(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return folders[0].uri.fsPath;
}
