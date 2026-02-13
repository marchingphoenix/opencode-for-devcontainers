/**
 * Shared types for the chat subsystem.
 *
 * Defines the line-delimited JSON protocol between the VS Code chat
 * participant and the OpenCode process, plus data structures for
 * tracking agent and subagent activity.
 */

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export interface AgentConfig {
  id: string;
  name: string;
  provider: string;
  model: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Events FROM OpenCode (stdout, one JSON object per line)
// ---------------------------------------------------------------------------

export type OpenCodeEvent =
  | { type: "status"; message: string; agent: string }
  | { type: "text"; content: string; agent: string }
  | { type: "tool_start"; tool: string; args: Record<string, unknown>; subagentId?: string }
  | { type: "tool_end"; tool: string; result: string; subagentId?: string }
  | { type: "subagent_start"; id: string; name: string; parent: string }
  | { type: "subagent_end"; id: string; status: "completed" | "failed" | "cancelled" }
  | { type: "done"; agent: string }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Commands TO OpenCode (stdin, one JSON object per line)
// ---------------------------------------------------------------------------

export type OpenCodeCommand =
  | { type: "prompt"; text: string; agent?: string; references?: string[] }
  | { type: "cancel" }
  | { type: "config"; agent: string; provider: string; model: string };

// ---------------------------------------------------------------------------
// Subagent / tool-call tracking
// ---------------------------------------------------------------------------

export interface SubagentInfo {
  id: string;
  name: string;
  parent: string;
  status: "running" | "completed" | "failed" | "cancelled";
  currentTool?: string;
  startedAt: number;
  completedAt?: number;
  toolCalls: ToolCallInfo[];
}

export interface ToolCallInfo {
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  startedAt: number;
  completedAt?: number;
}
