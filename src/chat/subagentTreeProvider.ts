import * as vscode from "vscode";
import { SubagentTracker } from "./subagentTracker";
import { SubagentInfo, ToolCallInfo } from "./types";

// ---------------------------------------------------------------------------
// Tree item types
// ---------------------------------------------------------------------------

type SubagentTreeItem =
  | { kind: "subagent"; info: SubagentInfo }
  | { kind: "toolcall"; info: SubagentInfo; toolCall: ToolCallInfo };

// ---------------------------------------------------------------------------
// Tree data provider
// ---------------------------------------------------------------------------

/**
 * Displays subagent activity in a VS Code tree view.
 *
 * ```
 * OPENCODE AGENTS
 * ├── coding-agent (running)
 * │   ├── shell: npm test (completed, 1.2s)
 * │   └── file_edit: src/app.ts (running)
 * └── test-runner (completed, 12s)
 *     └── shell: jest --coverage (completed, 8.1s)
 * ```
 */
export class SubagentTreeProvider
  implements vscode.TreeDataProvider<SubagentTreeItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<SubagentTreeItem | undefined | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private disposables: vscode.Disposable[] = [];

  constructor(private tracker: SubagentTracker) {
    this.disposables.push(
      tracker.onSubagentChanged(() => this.refresh()),
      tracker.onSubagentsReset(() => this.refresh())
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  // -----------------------------------------------------------------------
  // TreeDataProvider implementation
  // -----------------------------------------------------------------------

  getTreeItem(element: SubagentTreeItem): vscode.TreeItem {
    if (element.kind === "subagent") {
      return this.buildSubagentItem(element.info);
    }
    return this.buildToolCallItem(element.toolCall);
  }

  getChildren(element?: SubagentTreeItem): SubagentTreeItem[] {
    if (!element) {
      // Root: list all subagents.
      return this.tracker.getAllSubagents().map((info) => ({
        kind: "subagent" as const,
        info,
      }));
    }

    if (element.kind === "subagent") {
      // Children of a subagent: its tool calls.
      return element.info.toolCalls.map((toolCall) => ({
        kind: "toolcall" as const,
        info: element.info,
        toolCall,
      }));
    }

    return [];
  }

  // -----------------------------------------------------------------------
  // Item builders
  // -----------------------------------------------------------------------

  private buildSubagentItem(info: SubagentInfo): vscode.TreeItem {
    const hasChildren = info.toolCalls.length > 0;
    const item = new vscode.TreeItem(
      this.subagentLabel(info),
      hasChildren
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );

    item.iconPath = this.statusIcon(info.status);
    item.description = this.subagentDescription(info);
    item.tooltip = this.subagentTooltip(info);
    return item;
  }

  private buildToolCallItem(tc: ToolCallInfo): vscode.TreeItem {
    const label = this.toolCallLabel(tc);
    const item = new vscode.TreeItem(
      label,
      vscode.TreeItemCollapsibleState.None
    );

    item.iconPath = tc.completedAt
      ? new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed"))
      : new vscode.ThemeIcon("loading~spin");
    item.description = this.toolCallDescription(tc);
    item.tooltip = this.toolCallTooltip(tc);
    return item;
  }

  // -----------------------------------------------------------------------
  // Formatting helpers
  // -----------------------------------------------------------------------

  private subagentLabel(info: SubagentInfo): string {
    return info.name;
  }

  private subagentDescription(info: SubagentInfo): string {
    const parts: string[] = [info.status];
    if (info.completedAt) {
      parts.push(this.formatDuration(info.completedAt - info.startedAt));
    }
    if (info.toolCalls.length > 0) {
      parts.push(`${info.toolCalls.length} tool call${info.toolCalls.length === 1 ? "" : "s"}`);
    }
    return parts.join(", ");
  }

  private subagentTooltip(info: SubagentInfo): string {
    const lines = [`Subagent: ${info.name}`, `Status: ${info.status}`];
    if (info.currentTool) {
      lines.push(`Current tool: ${info.currentTool}`);
    }
    if (info.completedAt) {
      lines.push(
        `Duration: ${this.formatDuration(info.completedAt - info.startedAt)}`
      );
    }
    return lines.join("\n");
  }

  private toolCallLabel(tc: ToolCallInfo): string {
    const summary = this.toolCallSummary(tc);
    return `${tc.tool}: ${summary}`;
  }

  private toolCallDescription(tc: ToolCallInfo): string {
    if (tc.completedAt) {
      return this.formatDuration(tc.completedAt - tc.startedAt);
    }
    return "running";
  }

  private toolCallTooltip(tc: ToolCallInfo): string {
    const lines = [`Tool: ${tc.tool}`, `Args: ${JSON.stringify(tc.args)}`];
    if (tc.result) {
      const preview =
        tc.result.length > 200
          ? tc.result.substring(0, 200) + "..."
          : tc.result;
      lines.push(`Result: ${preview}`);
    }
    return lines.join("\n");
  }

  /** Extract a short summary from tool-call args. */
  private toolCallSummary(tc: ToolCallInfo): string {
    if (tc.args.command) {
      return String(tc.args.command);
    }
    if (tc.args.path) {
      return String(tc.args.path);
    }
    const keys = Object.keys(tc.args);
    if (keys.length > 0) {
      return String(tc.args[keys[0]]);
    }
    return "(no args)";
  }

  private statusIcon(
    status: SubagentInfo["status"]
  ): vscode.ThemeIcon {
    switch (status) {
      case "running":
        return new vscode.ThemeIcon(
          "loading~spin",
          new vscode.ThemeColor("charts.blue")
        );
      case "completed":
        return new vscode.ThemeIcon(
          "check",
          new vscode.ThemeColor("testing.iconPassed")
        );
      case "failed":
        return new vscode.ThemeIcon(
          "error",
          new vscode.ThemeColor("testing.iconFailed")
        );
      case "cancelled":
        return new vscode.ThemeIcon(
          "circle-slash",
          new vscode.ThemeColor("disabledForeground")
        );
    }
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    return `${(ms / 1000).toFixed(1)}s`;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}
