import * as vscode from "vscode";
import { OpenCodeEvent, SubagentInfo, AgentConfig } from "./types";

/**
 * Maps {@link OpenCodeEvent} objects to VS Code ChatResponseStream
 * calls (progress spinners, markdown blocks, buttons, etc.).
 */
export class ResponseRenderer {
  private showToolCalls: boolean;

  constructor() {
    this.showToolCalls = vscode.workspace
      .getConfiguration("opencode-devcontainer")
      .get<boolean>("chat.showToolCalls", true);
  }

  /** Render a single event into the chat response stream. */
  renderEvent(
    event: OpenCodeEvent,
    stream: vscode.ChatResponseStream
  ): void {
    switch (event.type) {
      case "status":
        stream.progress(event.message);
        break;

      case "text":
        stream.markdown(event.content);
        break;

      case "tool_start":
        if (this.showToolCalls) {
          this.renderToolStart(event, stream);
        }
        stream.progress(`Running ${event.tool}...`);
        break;

      case "tool_end":
        if (this.showToolCalls) {
          this.renderToolEnd(event, stream);
        }
        break;

      case "subagent_start":
        stream.progress(`Subagent **${event.name}** started`);
        break;

      case "subagent_end":
        if (event.status === "failed") {
          stream.markdown(
            `\n> **Subagent ${event.id}** failed.\n`
          );
        }
        break;

      case "error":
        stream.markdown(
          `\n\`\`\`\nError: ${event.message}\n\`\`\`\n`
        );
        break;

      case "done":
        // Rendered by the chat participant after collecting subagent summary.
        break;
    }
  }

  /** Render an agent header at the start of a response. */
  renderAgentHeader(
    agent: AgentConfig,
    stream: vscode.ChatResponseStream
  ): void {
    stream.markdown(
      `**${agent.name}** _(${agent.provider}/${agent.model})_\n\n`
    );
  }

  /** Render a summary of subagent activity at the end of a response. */
  renderSubagentSummary(
    subagents: SubagentInfo[],
    stream: vscode.ChatResponseStream
  ): void {
    if (subagents.length === 0) {
      return;
    }

    const lines: string[] = ["\n---\n**Subagent summary:**\n"];
    for (const sa of subagents) {
      const duration = sa.completedAt
        ? `${((sa.completedAt - sa.startedAt) / 1000).toFixed(1)}s`
        : "running";
      const icon = sa.status === "completed" ? "pass" : sa.status === "failed" ? "fail" : "pending";
      lines.push(
        `- $(testing-${icon}-icon) **${sa.name}** — ${sa.status} (${duration}, ${sa.toolCalls.length} tool calls)`
      );
    }
    stream.markdown(lines.join("\n") + "\n");
  }

  // -----------------------------------------------------------------------
  // Tool-call rendering
  // -----------------------------------------------------------------------

  private renderToolStart(
    event: Extract<OpenCodeEvent, { type: "tool_start" }>,
    stream: vscode.ChatResponseStream
  ): void {
    const summary = this.toolArgsSummary(event.tool, event.args);
    stream.markdown(`\n> **${event.tool}**: \`${summary}\`\n`);
  }

  private renderToolEnd(
    event: Extract<OpenCodeEvent, { type: "tool_end" }>,
    stream: vscode.ChatResponseStream
  ): void {
    if (!event.result) {
      return;
    }
    // Show a truncated result in a code block.
    const preview =
      event.result.length > 500
        ? event.result.substring(0, 500) + "\n... (truncated)"
        : event.result;
    stream.markdown(`\n\`\`\`\n${preview}\n\`\`\`\n`);
  }

  private toolArgsSummary(
    tool: string,
    args: Record<string, unknown>
  ): string {
    if (args.command) {
      return String(args.command);
    }
    if (args.path) {
      return String(args.path);
    }
    return JSON.stringify(args);
  }
}
