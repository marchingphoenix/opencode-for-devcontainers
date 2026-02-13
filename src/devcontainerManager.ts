import * as vscode from "vscode";
import { exec } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { getConfig, getWorkspaceFolder } from "./config";

export interface DevcontainerInfo {
  containerId: string;
  workspaceFolder: string;
  remoteWorkspaceFolder: string;
  state: "running" | "stopped" | "not-found";
}

export type DevcontainerState = "running" | "stopped" | "starting" | "not-found" | "error";

export class DevcontainerManager {
  private _state: DevcontainerState = "not-found";
  private _containerId: string | undefined;
  private _remoteWorkspaceFolder: string | undefined;
  private _onStateChanged = new vscode.EventEmitter<DevcontainerState>();
  public readonly onStateChanged = this._onStateChanged.event;

  get state(): DevcontainerState {
    return this._state;
  }

  get containerId(): string | undefined {
    return this._containerId;
  }

  get remoteWorkspaceFolder(): string | undefined {
    return this._remoteWorkspaceFolder;
  }

  private setState(state: DevcontainerState): void {
    this._state = state;
    this._onStateChanged.fire(state);
  }

  /**
   * Detect if a devcontainer.json exists in the workspace.
   */
  async detectDevcontainerConfig(): Promise<string | undefined> {
    const workspaceFolder = getWorkspaceFolder();
    if (!workspaceFolder) {
      return undefined;
    }

    const config = getConfig();
    if (config.devcontainerPath) {
      const customPath = path.resolve(workspaceFolder, config.devcontainerPath);
      if (fs.existsSync(path.join(customPath, "devcontainer.json"))) {
        return customPath;
      }
      if (fs.existsSync(customPath) && customPath.endsWith("devcontainer.json")) {
        return path.dirname(customPath);
      }
    }

    // Standard locations
    const devcontainerDir = path.join(workspaceFolder, ".devcontainer");
    if (fs.existsSync(path.join(devcontainerDir, "devcontainer.json"))) {
      return devcontainerDir;
    }

    // Root-level devcontainer.json
    if (fs.existsSync(path.join(workspaceFolder, "devcontainer.json"))) {
      return workspaceFolder;
    }

    return undefined;
  }

  /**
   * Parse the devcontainer.json to extract the workspace folder mount.
   */
  async parseWorkspaceFolder(): Promise<string> {
    const config = getConfig();
    if (config.containerWorkspaceFolder) {
      return config.containerWorkspaceFolder;
    }

    const workspaceFolder = getWorkspaceFolder();
    if (!workspaceFolder) {
      return "/workspaces/project";
    }

    const configDir = await this.detectDevcontainerConfig();
    if (!configDir) {
      return `/workspaces/${path.basename(workspaceFolder)}`;
    }

    try {
      const devcontainerJsonPath = configDir.endsWith("devcontainer.json")
        ? configDir
        : path.join(configDir, "devcontainer.json");
      const content = fs.readFileSync(devcontainerJsonPath, "utf-8");
      // Strip comments (JSON with comments support)
      const stripped = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const parsed = JSON.parse(stripped);

      if (parsed.workspaceFolder) {
        return parsed.workspaceFolder;
      }
    } catch {
      // Fall through to default
    }

    return `/workspaces/${path.basename(workspaceFolder)}`;
  }

  /**
   * Start the devcontainer using the devcontainer CLI.
   */
  async startDevcontainer(): Promise<DevcontainerInfo | undefined> {
    const workspaceFolder = getWorkspaceFolder();
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("No workspace folder open.");
      return undefined;
    }

    const configDir = await this.detectDevcontainerConfig();
    if (!configDir) {
      vscode.window.showErrorMessage(
        "No devcontainer.json found in the workspace. Create one in .devcontainer/ first."
      );
      return undefined;
    }

    this.setState("starting");
    const config = getConfig();

    try {
      const result = await this.execCommand(
        `${config.devcontainerCliPath} up --workspace-folder "${workspaceFolder}"`,
        { cwd: workspaceFolder }
      );

      // Parse the output to get container ID
      // devcontainer up outputs JSON with containerId
      const lines = result.stdout.split("\n");
      let containerId: string | undefined;

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed.containerId) {
            containerId = parsed.containerId;
            break;
          }
        } catch {
          // Not a JSON line, skip
        }
      }

      if (!containerId) {
        // Try to find the container by label
        containerId = await this.findContainerByLabel(workspaceFolder);
      }

      if (!containerId) {
        this.setState("error");
        vscode.window.showErrorMessage(
          "Dev container started but could not determine container ID."
        );
        return undefined;
      }

      const remoteWorkspaceFolder = await this.parseWorkspaceFolder();
      this._containerId = containerId;
      this._remoteWorkspaceFolder = remoteWorkspaceFolder;
      this.setState("running");

      return {
        containerId,
        workspaceFolder,
        remoteWorkspaceFolder,
        state: "running",
      };
    } catch (err) {
      this.setState("error");
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to start dev container: ${message}`);
      return undefined;
    }
  }

  /**
   * Stop the devcontainer.
   */
  async stopDevcontainer(): Promise<void> {
    if (!this._containerId) {
      vscode.window.showWarningMessage("No dev container is currently tracked.");
      return;
    }

    const config = getConfig();
    try {
      await this.execCommand(`${config.dockerPath} stop ${this._containerId}`);
      this._containerId = undefined;
      this._remoteWorkspaceFolder = undefined;
      this.setState("stopped");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to stop dev container: ${message}`);
    }
  }

  /**
   * Refresh the container status by checking if it's still running.
   */
  async refreshStatus(): Promise<void> {
    if (!this._containerId) {
      // Try to find a running devcontainer for this workspace
      const workspaceFolder = getWorkspaceFolder();
      if (workspaceFolder) {
        const containerId = await this.findContainerByLabel(workspaceFolder);
        if (containerId) {
          this._containerId = containerId;
          this._remoteWorkspaceFolder = await this.parseWorkspaceFolder();
          this.setState("running");
          return;
        }
      }
      this.setState("not-found");
      return;
    }

    const config = getConfig();
    try {
      const result = await this.execCommand(
        `${config.dockerPath} inspect -f "{{.State.Running}}" ${this._containerId}`
      );
      if (result.stdout.trim() === "true") {
        this.setState("running");
      } else {
        this.setState("stopped");
      }
    } catch {
      this._containerId = undefined;
      this.setState("not-found");
    }
  }

  /**
   * Execute a command inside the devcontainer.
   */
  async execInContainer(command: string): Promise<{ stdout: string; stderr: string }> {
    if (!this._containerId) {
      throw new Error("No dev container is running.");
    }

    const config = getConfig();
    const workDir = this._remoteWorkspaceFolder || "/workspaces";
    return this.execCommand(
      `${config.dockerPath} exec -w "${workDir}" ${this._containerId} sh -c ${this.shellEscape(command)}`
    );
  }

  /**
   * Find a running devcontainer by its label.
   */
  private async findContainerByLabel(workspaceFolder: string): Promise<string | undefined> {
    const config = getConfig();
    try {
      // devcontainer CLI labels containers with the workspace folder
      const result = await this.execCommand(
        `${config.dockerPath} ps -q --filter "label=devcontainer.local_folder=${workspaceFolder}"`
      );
      const containerId = result.stdout.trim().split("\n")[0];
      return containerId || undefined;
    } catch {
      return undefined;
    }
  }

  private shellEscape(cmd: string): string {
    return `'${cmd.replace(/'/g, "'\\''")}'`;
  }

  private execCommand(
    command: string,
    options?: { cwd?: string }
  ): Promise<{ stdout: string; stderr: string }> {
    // When the command binary is an absolute path, ensure its parent directory
    // is on PATH. This fixes environments where node is managed by nvm and the
    // devcontainer CLI (a #!/usr/bin/env node script) lives in the same bin
    // directory as the node binary, but that directory isn't on the default
    // PATH inherited by child processes (common when VS Code is launched from
    // the OS application launcher rather than a terminal).
    const env = { ...process.env };
    const binaryPath = command.split(" ")[0];
    if (path.isAbsolute(binaryPath)) {
      const binDir = path.dirname(binaryPath);
      env.PATH = binDir + path.delimiter + (env.PATH || "");
    }

    return new Promise((resolve, reject) => {
      exec(command, { cwd: options?.cwd, timeout: 120000, env }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Command failed: ${command}\n${stderr || error.message}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  dispose(): void {
    this._onStateChanged.dispose();
  }
}
