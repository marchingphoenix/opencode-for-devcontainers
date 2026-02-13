import * as vscode from "vscode";
import { DevcontainerManager } from "./devcontainerManager";
import { getConfig, getWorkspaceFolder } from "./config";
import { writeShellWrapper, removeShellWrapper } from "./shellWrapper";

export class OpencodeRunner {
  private activeTerminal: vscode.Terminal | undefined;
  private shellWrapperPath: string | undefined;
  private terminalCloseListener: vscode.Disposable | undefined;

  constructor(private devcontainerManager: DevcontainerManager) {}

  /**
   * Launch OpenCode in "local with remote exec" mode.
   * OpenCode runs on the host, but SHELL is set to a wrapper that
   * routes commands to the devcontainer.
   */
  async launchLocalWithRemoteExec(): Promise<void> {
    if (this.devcontainerManager.state !== "running") {
      const start = await vscode.window.showInformationMessage(
        "Dev container is not running. Start it now?",
        "Start",
        "Cancel"
      );
      if (start !== "Start") {
        return;
      }
      const info = await this.devcontainerManager.startDevcontainer();
      if (!info) {
        return;
      }
    }

    const containerId = this.devcontainerManager.containerId;
    const remoteWorkspace = this.devcontainerManager.remoteWorkspaceFolder;
    if (!containerId || !remoteWorkspace) {
      vscode.window.showErrorMessage("Dev container info is not available.");
      return;
    }

    // Resolve environment variables to forward to the container
    const envToForward = this.resolveForwardedEnvVars();

    // Create the shell wrapper
    this.shellWrapperPath = writeShellWrapper(containerId, remoteWorkspace, envToForward);

    const config = getConfig();
    const workspaceFolder = getWorkspaceFolder();

    // Build environment for the OpenCode process
    const env: Record<string, string> = {
      SHELL: this.shellWrapperPath,
      OPENCODE_DEVCONTAINER: "1",
      OPENCODE_DEVCONTAINER_ID: containerId,
      OPENCODE_WORKSPACE_FOLDER: remoteWorkspace,
      ...config.additionalEnvVars,
    };

    // Dispose previous terminal if it exists
    this.disposeTerminal();

    this.activeTerminal = vscode.window.createTerminal({
      name: "OpenCode (DevContainer)",
      cwd: workspaceFolder,
      env,
      iconPath: new vscode.ThemeIcon("remote"),
    });

    // Send the command to start OpenCode
    this.activeTerminal.sendText(`${config.opencodePath}`, true);
    this.activeTerminal.show();

    // Listen for terminal close to clean up the wrapper
    this.terminalCloseListener = vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === this.activeTerminal) {
        this.cleanup();
      }
    });
  }

  /**
   * Launch OpenCode entirely inside the devcontainer.
   * The OpenCode binary must be available in the container.
   */
  async launchInContainer(): Promise<void> {
    if (this.devcontainerManager.state !== "running") {
      const start = await vscode.window.showInformationMessage(
        "Dev container is not running. Start it now?",
        "Start",
        "Cancel"
      );
      if (start !== "Start") {
        return;
      }
      const info = await this.devcontainerManager.startDevcontainer();
      if (!info) {
        return;
      }
    }

    const containerId = this.devcontainerManager.containerId;
    const remoteWorkspace = this.devcontainerManager.remoteWorkspaceFolder;
    if (!containerId || !remoteWorkspace) {
      vscode.window.showErrorMessage("Dev container info is not available.");
      return;
    }

    const config = getConfig();

    // Build env flags for forwarding API keys etc.
    const envToForward = this.resolveForwardedEnvVars();
    const envFlags = Object.entries(envToForward)
      .map(([key, value]) => `-e ${key}="${value.replace(/"/g, '\\"')}"`)
      .join(" ");

    // Dispose previous terminal if it exists
    this.disposeTerminal();

    this.activeTerminal = vscode.window.createTerminal({
      name: "OpenCode (In Container)",
      iconPath: new vscode.ThemeIcon("remote"),
    });

    // Run OpenCode inside the container via docker exec
    const dockerCmd = [
      config.dockerPath,
      "exec",
      "-it",
      `-w "${remoteWorkspace}"`,
      envFlags,
      containerId,
      "opencode",
    ]
      .filter(Boolean)
      .join(" ");

    this.activeTerminal.sendText(dockerCmd, true);
    this.activeTerminal.show();

    this.terminalCloseListener = vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === this.activeTerminal) {
        this.cleanup();
      }
    });
  }

  /**
   * Launch OpenCode based on the configured execution mode.
   */
  async launch(): Promise<void> {
    const config = getConfig();
    if (config.executionMode === "in-container") {
      await this.launchInContainer();
    } else {
      await this.launchLocalWithRemoteExec();
    }
  }

  /**
   * Resolve environment variables that should be forwarded to the container.
   * Supports glob patterns like "OPENCODE_*".
   */
  private resolveForwardedEnvVars(): Record<string, string> {
    const config = getConfig();
    const result: Record<string, string> = {};

    for (const pattern of config.forwardEnvVars) {
      if (pattern.includes("*")) {
        // Glob pattern: match against current env
        const prefix = pattern.replace("*", "");
        for (const [key, value] of Object.entries(process.env)) {
          if (key.startsWith(prefix) && value !== undefined) {
            result[key] = value;
          }
        }
      } else {
        // Exact match
        const value = process.env[pattern];
        if (value !== undefined) {
          result[pattern] = value;
        }
      }
    }

    return result;
  }

  private disposeTerminal(): void {
    if (this.activeTerminal) {
      this.activeTerminal.dispose();
      this.activeTerminal = undefined;
    }
    if (this.terminalCloseListener) {
      this.terminalCloseListener.dispose();
      this.terminalCloseListener = undefined;
    }
  }

  private cleanup(): void {
    if (this.shellWrapperPath) {
      removeShellWrapper(this.shellWrapperPath);
      this.shellWrapperPath = undefined;
    }
    this.activeTerminal = undefined;
    if (this.terminalCloseListener) {
      this.terminalCloseListener.dispose();
      this.terminalCloseListener = undefined;
    }
  }

  dispose(): void {
    this.cleanup();
    this.disposeTerminal();
  }
}
