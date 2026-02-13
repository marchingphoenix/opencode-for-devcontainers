import * as vscode from "vscode";
import { OpenCodeEvent, SubagentInfo, ToolCallInfo } from "./types";

/**
 * Tracks subagent lifecycle and tool-call activity.
 *
 * Consumes {@link OpenCodeEvent} objects emitted by the bridge and
 * maintains an in-memory model of all active and completed subagents
 * plus their individual tool calls.  Fires change events so that
 * the tree-view provider can refresh.
 */
export class SubagentTracker implements vscode.Disposable {
  private subagents = new Map<string, SubagentInfo>();

  private readonly _onSubagentChanged = new vscode.EventEmitter<SubagentInfo>();
  public readonly onSubagentChanged = this._onSubagentChanged.event;

  private readonly _onSubagentsReset = new vscode.EventEmitter<void>();
  public readonly onSubagentsReset = this._onSubagentsReset.event;

  /** Feed an event from the bridge into the tracker. */
  handleEvent(event: OpenCodeEvent): void {
    switch (event.type) {
      case "subagent_start":
        this.handleSubagentStart(event);
        break;
      case "subagent_end":
        this.handleSubagentEnd(event);
        break;
      case "tool_start":
        if (event.subagentId) {
          this.handleToolStart(event.subagentId, event.tool, event.args);
        }
        break;
      case "tool_end":
        if (event.subagentId) {
          this.handleToolEnd(event.subagentId, event.tool, event.result);
        }
        break;
      case "done":
        this.markAllCompleted();
        break;
    }
  }

  getSubagent(id: string): SubagentInfo | undefined {
    return this.subagents.get(id);
  }

  getActiveSubagents(): SubagentInfo[] {
    return Array.from(this.subagents.values()).filter(
      (s) => s.status === "running"
    );
  }

  getAllSubagents(): SubagentInfo[] {
    return Array.from(this.subagents.values());
  }

  reset(): void {
    this.subagents.clear();
    this._onSubagentsReset.fire();
  }

  // -----------------------------------------------------------------------
  // Internal handlers
  // -----------------------------------------------------------------------

  private handleSubagentStart(event: Extract<OpenCodeEvent, { type: "subagent_start" }>): void {
    const info: SubagentInfo = {
      id: event.id,
      name: event.name,
      parent: event.parent,
      status: "running",
      startedAt: Date.now(),
      toolCalls: [],
    };
    this.subagents.set(event.id, info);
    this._onSubagentChanged.fire(info);
  }

  private handleSubagentEnd(event: Extract<OpenCodeEvent, { type: "subagent_end" }>): void {
    const info = this.subagents.get(event.id);
    if (!info) {
      return;
    }
    info.status = event.status;
    info.completedAt = Date.now();
    info.currentTool = undefined;
    this._onSubagentChanged.fire(info);
  }

  private handleToolStart(
    subagentId: string,
    tool: string,
    args: Record<string, unknown>
  ): void {
    const info = this.subagents.get(subagentId);
    if (!info) {
      return;
    }

    const toolCall: ToolCallInfo = {
      tool,
      args,
      startedAt: Date.now(),
    };
    info.toolCalls.push(toolCall);
    info.currentTool = tool;
    this._onSubagentChanged.fire(info);
  }

  private handleToolEnd(
    subagentId: string,
    tool: string,
    result: string
  ): void {
    const info = this.subagents.get(subagentId);
    if (!info) {
      return;
    }

    // Find the matching open tool call (last one with this tool name
    // that hasn't completed yet).
    const tc = [...info.toolCalls]
      .reverse()
      .find((t) => t.tool === tool && !t.completedAt);
    if (tc) {
      tc.result = result;
      tc.completedAt = Date.now();
    }

    info.currentTool = undefined;
    this._onSubagentChanged.fire(info);
  }

  /** When a top-level "done" arrives, mark any still-running subagents. */
  private markAllCompleted(): void {
    for (const info of this.subagents.values()) {
      if (info.status === "running") {
        info.status = "completed";
        info.completedAt = Date.now();
        info.currentTool = undefined;
        this._onSubagentChanged.fire(info);
      }
    }
  }

  dispose(): void {
    this._onSubagentChanged.dispose();
    this._onSubagentsReset.dispose();
  }
}
