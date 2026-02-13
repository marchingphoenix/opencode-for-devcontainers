import * as vscode from "vscode";
import { ChildProcess, spawn } from "child_process";
import { createInterface } from "readline";
import { DevcontainerManager } from "../devcontainerManager";
import { getConfig, getWorkspaceFolder } from "../config";
import { writeShellWrapper, removeShellWrapper } from "../shellWrapper";
import { OpenCodeEvent, OpenCodeCommand } from "./types";
import { OpenCodeAdapter } from "./opencodeAdapter";

export type BridgeState = "idle" | "busy" | "error" | "stopped";

/**
 * Manages an OpenCode child process and exposes an event-driven
 * interface for the chat participant.
 *
 * CRITICAL: In `local-with-remote-exec` mode the bridge creates a
 * shell wrapper (via {@link writeShellWrapper}) and sets `SHELL` on the
 * child process environment so that every tool call that spawns a
 * sub-shell is routed through `docker exec` into the devcontainer —
 * exactly matching the existing terminal-based flow in OpencodeRunner.
 */
export class OpenCodeBridge implements vscode.Disposable {
  private process: ChildProcess | null = null;
  private shellWrapperPath: string | undefined;
  private _state: BridgeState = "stopped";
  private adapter: OpenCodeAdapter;
  private useJsonMode = true;

  private readonly _onEvent = new vscode.EventEmitter<OpenCodeEvent>();
  public readonly onEvent = this._onEvent.event;

  private readonly _onStateChanged = new vscode.EventEmitter<BridgeState>();
  public readonly onStateChanged = this._onStateChanged.event;

  constructor(private devcontainerManager: DevcontainerManager) {
    this.adapter = new OpenCodeAdapter();

    // Forward adapter events (used when JSON mode is unavailable).
    this.adapter.onEvent((event) => {
      this._onEvent.fire(event);
    });
  }

  get state(): BridgeState {
    return this._state;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.process) {
      return; // already running
    }

    const config = getConfig();

    if (config.executionMode === "in-container") {
      this.startInContainer();
    } else {
      this.startLocalWithRemoteExec();
    }
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.cleanupShellWrapper();
    this.setState("stopped");
  }

  isRunning(): boolean {
    return this.process !== null && this._state !== "stopped";
  }

  // -----------------------------------------------------------------------
  // Commands → OpenCode (stdin)
  // -----------------------------------------------------------------------

  sendPrompt(text: string, agent?: string, references?: string[]): void {
    const cmd: OpenCodeCommand = { type: "prompt", text, agent, references };
    this.sendCommand(cmd);
    this.setState("busy");
  }

  cancelCurrentRequest(): void {
    this.sendCommand({ type: "cancel" });
  }

  sendConfig(agent: string, provider: string, model: string): void {
    this.sendCommand({ type: "config", agent, provider, model });
  }

  // -----------------------------------------------------------------------
  // Spawn strategies
  // -----------------------------------------------------------------------

  /**
   * Local-with-remote-exec mode.
   *
   * OpenCode runs on the host.  We set SHELL to a wrapper script that
   * routes every `sh -c …` invocation through `docker exec`, ensuring
   * all tool calls execute inside the devcontainer.
   */
  private startLocalWithRemoteExec(): void {
    const config = getConfig();
    const workspaceFolder = getWorkspaceFolder();

    const containerId = this.devcontainerManager.containerId;
    const remoteWorkspace = this.devcontainerManager.remoteWorkspaceFolder;

    if (!containerId || !remoteWorkspace) {
      this.setState("error");
      this._onEvent.fire({
        type: "error",
        message: "Dev container is not running. Start it first.",
      });
      return;
    }

    // Resolve env vars to forward into the container.
    const envToForward = this.resolveForwardedEnvVars();

    // Create the shell wrapper — CRITICAL for routing tool calls.
    this.shellWrapperPath = writeShellWrapper(
      containerId,
      remoteWorkspace,
      envToForward
    );

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      SHELL: this.shellWrapperPath,
      OPENCODE_DEVCONTAINER: "1",
      OPENCODE_DEVCONTAINER_ID: containerId,
      OPENCODE_WORKSPACE_FOLDER: remoteWorkspace,
      ...config.additionalEnvVars,
    };

    const args = this.buildOpenCodeArgs();
    this.spawnProcess(config.opencodePath, args, {
      cwd: workspaceFolder,
      env,
    });
  }

  /**
   * In-container mode.
   *
   * OpenCode runs entirely inside the devcontainer.  No shell wrapper
   * is needed because commands already execute in-container.
   */
  private startInContainer(): void {
    const config = getConfig();
    const containerId = this.devcontainerManager.containerId;
    const remoteWorkspace =
      this.devcontainerManager.remoteWorkspaceFolder || "/workspaces";

    if (!containerId) {
      this.setState("error");
      this._onEvent.fire({
        type: "error",
        message: "Dev container is not running. Start it first.",
      });
      return;
    }

    const envToForward = this.resolveForwardedEnvVars();
    const envFlags: string[] = [];
    for (const [key, value] of Object.entries(envToForward)) {
      envFlags.push("-e", `${key}=${value}`);
    }

    const args = [
      "exec",
      "-w",
      remoteWorkspace,
      ...envFlags,
      containerId,
      "opencode",
      ...this.buildOpenCodeArgs(),
    ];

    this.spawnProcess(config.dockerPath, args, {});
  }

  // -----------------------------------------------------------------------
  // Process management
  // -----------------------------------------------------------------------

  private buildOpenCodeArgs(): string[] {
    // Attempt JSON output mode.  If the flag is unsupported, the adapter
    // will handle raw output.
    return this.useJsonMode ? ["--format", "json"] : [];
  }

  private spawnProcess(
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string> }
  ): void {
    this.process = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.setState("idle");

    // --- stdout: line-delimited JSON events --------------------------
    const rl = createInterface({ input: this.process.stdout! });
    rl.on("line", (line) => this.handleStdoutLine(line));

    // --- stderr: informational / errors ------------------------------
    this.process.stderr?.on("data", (data: Buffer) =>
      this.handleStderr(data.toString("utf-8"))
    );

    // --- exit --------------------------------------------------------
    this.process.on("exit", (code) => this.handleExit(code));

    this.process.on("error", (err) => {
      this._onEvent.fire({ type: "error", message: err.message });
      this.setState("error");
    });
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    // Try to parse as structured JSON first.
    if (trimmed.startsWith("{")) {
      try {
        const event = JSON.parse(trimmed) as OpenCodeEvent;
        if (event && typeof event.type === "string") {
          if (event.type === "done") {
            this.setState("idle");
          }
          this._onEvent.fire(event);
          return;
        }
      } catch {
        // Not valid JSON — fall through to adapter.
      }
    }

    // If the first non-JSON line arrives we switch off JSON mode for
    // this session and let the adapter handle all subsequent output.
    if (this.useJsonMode) {
      this.useJsonMode = false;
    }
    this.adapter.processLine(trimmed);
  }

  private handleStderr(data: string): void {
    const trimmed = data.trim();
    if (trimmed) {
      this._onEvent.fire({ type: "error", message: trimmed });
    }
  }

  private handleExit(code: number | null): void {
    this.process = null;
    this.cleanupShellWrapper();

    if (code !== 0 && code !== null) {
      this._onEvent.fire({
        type: "error",
        message: `OpenCode exited with code ${code}`,
      });
      this.setState("error");
    } else {
      this._onEvent.fire({
        type: "error",
        message: "OpenCode process exited unexpectedly",
      });
      this.setState("stopped");
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private sendCommand(cmd: OpenCodeCommand): void {
    if (!this.process?.stdin?.writable) {
      return;
    }
    this.process.stdin.write(JSON.stringify(cmd) + "\n");
  }

  private setState(state: BridgeState): void {
    this._state = state;
    this._onStateChanged.fire(state);
  }

  /** Forward env vars matching configured patterns into the container. */
  private resolveForwardedEnvVars(): Record<string, string> {
    const config = getConfig();
    const result: Record<string, string> = {};

    for (const pattern of config.forwardEnvVars) {
      if (pattern.includes("*")) {
        const prefix = pattern.replace("*", "");
        for (const [key, value] of Object.entries(process.env)) {
          if (key.startsWith(prefix) && value !== undefined) {
            result[key] = value;
          }
        }
      } else {
        const value = process.env[pattern];
        if (value !== undefined) {
          result[pattern] = value;
        }
      }
    }

    return result;
  }

  private cleanupShellWrapper(): void {
    if (this.shellWrapperPath) {
      removeShellWrapper(this.shellWrapperPath);
      this.shellWrapperPath = undefined;
    }
  }

  dispose(): void {
    this.stop();
    this.adapter.dispose();
    this._onEvent.dispose();
    this._onStateChanged.dispose();
  }
}
