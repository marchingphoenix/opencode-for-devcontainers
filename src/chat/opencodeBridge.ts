import * as vscode from "vscode";
import { ChildProcess, spawn } from "child_process";
import { createInterface } from "readline";
import { DevcontainerManager } from "../devcontainerManager";
import { getConfig, getWorkspaceFolder } from "../config";
import { writeShellWrapper, removeShellWrapper } from "../shellWrapper";
import { OpenCodeEvent } from "./types";
import { OpenCodeAdapter } from "./opencodeAdapter";

export type BridgeState = "idle" | "busy" | "error" | "stopped";

/**
 * Manages OpenCode child processes and exposes an event-driven
 * interface for the chat participant.
 *
 * Each prompt spawns a new `opencode run --format json -q "prompt"`
 * process.  OpenCode's non-interactive mode accepts the prompt as a
 * CLI argument and streams NDJSON events to stdout until the task
 * completes, then exits.
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

  /** Pre-computed environment for local-with-remote-exec mode. */
  private preparedEnv: Record<string, string> | undefined;

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

  /**
   * Prepare the bridge for accepting prompts.
   *
   * Validates that the devcontainer is available and, in
   * local-with-remote-exec mode, creates the shell wrapper.
   * Does NOT spawn a process — that happens per-prompt in
   * {@link sendPrompt}.
   */
  async start(): Promise<void> {
    if (this._state === "idle" || this._state === "busy") {
      return; // already prepared
    }

    const config = getConfig();

    if (config.executionMode === "in-container") {
      this.prepareInContainer();
    } else {
      this.prepareLocalWithRemoteExec();
    }
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.cleanupShellWrapper();
    this.preparedEnv = undefined;
    this.setState("stopped");
  }

  isRunning(): boolean {
    // The bridge is "running" when it has been prepared (idle) or is
    // actively processing a prompt (busy).  No long-lived process is
    // required — processes are spawned per-prompt.
    return this._state === "idle" || this._state === "busy";
  }

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  /**
   * Send a prompt to OpenCode.
   *
   * Spawns `opencode run --format json -q "<prompt>"` as a new child
   * process.  Events are streamed via {@link onEvent} until the process
   * exits.
   */
  sendPrompt(text: string, _agent?: string, references?: string[]): void {
    // Kill any in-flight request.
    if (this.process) {
      this.process.kill();
      this.process = null;
    }

    const promptText = this.buildPromptText(text, references);
    const config = getConfig();

    if (config.executionMode === "in-container") {
      this.spawnInContainer(promptText);
    } else {
      this.spawnLocalWithRemoteExec(promptText);
    }

    this.setState("busy");
  }

  cancelCurrentRequest(): void {
    if (this.process) {
      this.process.kill();
      // handleExit will fire and emit an error/done event.
    }
  }

  sendConfig(_agent: string, _provider: string, _model: string): void {
    // No-op: per-prompt spawning does not support mid-session config
    // changes.  Agent selection is handled via the prompt arguments.
  }

  // -----------------------------------------------------------------------
  // Preparation (called by start())
  // -----------------------------------------------------------------------

  /**
   * Prepare local-with-remote-exec mode.
   *
   * Validates the container, creates the shell wrapper, and caches the
   * environment variables so that each per-prompt spawn is fast.
   */
  private prepareLocalWithRemoteExec(): void {
    const config = getConfig();
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

    this.preparedEnv = {
      ...process.env as Record<string, string>,
      SHELL: this.shellWrapperPath,
      OPENCODE_DEVCONTAINER: "1",
      OPENCODE_DEVCONTAINER_ID: containerId,
      OPENCODE_WORKSPACE_FOLDER: remoteWorkspace,
      ...config.additionalEnvVars,
    };

    this.setState("idle");
  }

  /**
   * Prepare in-container mode.
   *
   * Just validates that the container ID is available.
   */
  private prepareInContainer(): void {
    const containerId = this.devcontainerManager.containerId;

    if (!containerId) {
      this.setState("error");
      this._onEvent.fire({
        type: "error",
        message: "Dev container is not running. Start it first.",
      });
      return;
    }

    this.setState("idle");
  }

  // -----------------------------------------------------------------------
  // Per-prompt spawn strategies
  // -----------------------------------------------------------------------

  private spawnLocalWithRemoteExec(prompt: string): void {
    const config = getConfig();
    const workspaceFolder = getWorkspaceFolder();

    const args = ["run", "--format", "json", "-q", prompt];

    this.spawnProcess(config.opencodePath, args, {
      cwd: workspaceFolder,
      env: this.preparedEnv,
    });
  }

  private spawnInContainer(prompt: string): void {
    const config = getConfig();
    const containerId = this.devcontainerManager.containerId;
    const remoteWorkspace =
      this.devcontainerManager.remoteWorkspaceFolder || "/workspaces";

    if (!containerId) {
      this._onEvent.fire({
        type: "error",
        message: "Dev container is not running.",
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
      "-i",
      "-w",
      remoteWorkspace,
      ...envFlags,
      containerId,
      "opencode",
      "run",
      "--format",
      "json",
      "-q",
      prompt,
    ];

    this.spawnProcess(config.dockerPath, args, {});
  }

  // -----------------------------------------------------------------------
  // Process management
  // -----------------------------------------------------------------------

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
        const raw = JSON.parse(trimmed) as Record<string, unknown>;
        if (raw && typeof raw.type === "string") {
          const event = this.mapEvent(raw);
          if (event) {
            if (event.type === "done") {
              this.setState("idle");
            }
            this._onEvent.fire(event);
            return;
          }
        }
      } catch {
        // Not valid JSON — fall through to adapter.
      }
    }

    // Fall back to the adapter for non-JSON output.
    this.adapter.processLine(trimmed);
  }

  /**
   * Map an NDJSON object from the OpenCode process into our internal
   * {@link OpenCodeEvent} type.
   *
   * OpenCode emits events like:
   *   { "type": "text", "text": "...", ... }
   *   { "type": "step_start", ... }
   *   { "type": "step_finish", ... }
   *
   * These are normalised to our event schema.
   */
  private mapEvent(raw: Record<string, unknown>): OpenCodeEvent | null {
    const type = raw.type as string;

    switch (type) {
      // ------ Direct matches with our event schema --------------------
      case "text":
        // OpenCode uses `text`, our schema uses `content`.
        return {
          type: "text",
          content: (raw.text ?? raw.content ?? "") as string,
          agent: (raw.agent ?? "default") as string,
        };

      case "status":
        return {
          type: "status",
          message: (raw.message ?? "") as string,
          agent: (raw.agent ?? "default") as string,
        };

      case "done":
        return { type: "done", agent: (raw.agent ?? "default") as string };

      case "error":
        return {
          type: "error",
          message: (raw.message ?? "Unknown error") as string,
        };

      case "tool_start":
        return {
          type: "tool_start",
          tool: (raw.tool ?? raw.name ?? "unknown") as string,
          args: (raw.args ?? {}) as Record<string, unknown>,
          subagentId: raw.subagentId as string | undefined,
        };

      case "tool_end":
        return {
          type: "tool_end",
          tool: (raw.tool ?? raw.name ?? "unknown") as string,
          result: (raw.result ?? "") as string,
          subagentId: raw.subagentId as string | undefined,
        };

      case "subagent_start":
        return {
          type: "subagent_start",
          id: (raw.id ?? "") as string,
          name: (raw.name ?? "") as string,
          parent: (raw.parent ?? "default") as string,
        };

      case "subagent_end":
        return {
          type: "subagent_end",
          id: (raw.id ?? "") as string,
          status: (raw.status ?? "completed") as
            | "completed"
            | "failed"
            | "cancelled",
        };

      // ------ OpenCode-specific events → mapped to our schema ---------
      case "step_start":
        return {
          type: "status",
          message: (raw.message ?? "Processing...") as string,
          agent: (raw.agent ?? "default") as string,
        };

      case "step_finish":
        return { type: "done", agent: (raw.agent ?? "default") as string };

      default:
        // Unknown event — try to extract text content.
        if (typeof raw.text === "string") {
          return { type: "text", content: raw.text, agent: "default" };
        }
        if (typeof raw.content === "string") {
          return { type: "text", content: raw.content, agent: "default" };
        }
        return null;
    }
  }

  private handleStderr(data: string): void {
    const trimmed = data.trim();
    if (!trimmed) {
      return;
    }

    // Many CLI tools (including OpenCode and Docker) write informational
    // messages to stderr.  Only treat lines that look like genuine errors
    // as error events — everything else is surfaced as status.
    if (this.isStderrError(trimmed)) {
      this._onEvent.fire({ type: "error", message: trimmed });
    } else {
      this._onEvent.fire({
        type: "status",
        message: trimmed,
        agent: "system",
      });
    }
  }

  /**
   * Heuristic: does a stderr line look like a real error?
   */
  private isStderrError(line: string): boolean {
    return /^(?:Error|ERROR|FATAL|fatal|panic|PANIC|Traceback)[\s:]/i.test(
      line
    );
  }

  private handleExit(code: number | null): void {
    this.process = null;

    if (code === 0 || code === null) {
      // Normal completion.  Emit "done" only if one hasn't already been
      // emitted by the NDJSON stream (which would have set state to "idle").
      if (this._state === "busy") {
        this._onEvent.fire({ type: "done", agent: "default" });
      }
      this.setState("idle");
    } else {
      this._onEvent.fire({
        type: "error",
        message: `OpenCode exited with code ${code}`,
      });
      // Stay idle so the bridge can accept the next prompt.
      this.setState("idle");
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Build the full prompt text, prepending any file references so that
   * OpenCode can see them as context.
   */
  private buildPromptText(
    text: string,
    references?: string[]
  ): string {
    if (!references || references.length === 0) {
      return text;
    }
    const refList = references.map((r) => `@${r}`).join(" ");
    return `${refList}\n\n${text}`;
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
