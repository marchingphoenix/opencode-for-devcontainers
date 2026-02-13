import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetMocks } from "../__mocks__/vscode";
import { SubagentTracker } from "./subagentTracker";
import { OpenCodeEvent } from "./types";

let tracker: SubagentTracker;

beforeEach(() => {
  __resetMocks();
  tracker = new SubagentTracker();
});

// ---------------------------------------------------------------------------
// subagent_start
// ---------------------------------------------------------------------------

describe("handleEvent — subagent_start", () => {
  it("creates a new subagent entry with running status", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "coding-agent",
      parent: "default",
    });

    const sa = tracker.getSubagent("sa-1");
    expect(sa).toBeDefined();
    expect(sa!.id).toBe("sa-1");
    expect(sa!.name).toBe("coding-agent");
    expect(sa!.parent).toBe("default");
    expect(sa!.status).toBe("running");
    expect(sa!.toolCalls).toEqual([]);
    expect(sa!.startedAt).toBeGreaterThan(0);
  });

  it("shows up in getActiveSubagents()", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "agent-a",
      parent: "default",
    });

    expect(tracker.getActiveSubagents()).toHaveLength(1);
    expect(tracker.getActiveSubagents()[0].id).toBe("sa-1");
  });

  it("shows up in getAllSubagents()", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "agent-a",
      parent: "default",
    });

    expect(tracker.getAllSubagents()).toHaveLength(1);
  });

  it("fires onSubagentChanged event", () => {
    const listener = vi.fn();
    tracker.onSubagentChanged(listener);

    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "agent-a",
      parent: "default",
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].id).toBe("sa-1");
  });
});

// ---------------------------------------------------------------------------
// subagent_end
// ---------------------------------------------------------------------------

describe("handleEvent — subagent_end", () => {
  it("marks a running subagent as completed", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "agent-a",
      parent: "default",
    });

    tracker.handleEvent({
      type: "subagent_end",
      id: "sa-1",
      status: "completed",
    });

    const sa = tracker.getSubagent("sa-1");
    expect(sa!.status).toBe("completed");
    expect(sa!.completedAt).toBeGreaterThan(0);
    expect(sa!.currentTool).toBeUndefined();
  });

  it("marks a subagent as failed", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "agent-a",
      parent: "default",
    });

    tracker.handleEvent({
      type: "subagent_end",
      id: "sa-1",
      status: "failed",
    });

    expect(tracker.getSubagent("sa-1")!.status).toBe("failed");
  });

  it("removes from active subagents after completion", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "agent-a",
      parent: "default",
    });

    tracker.handleEvent({
      type: "subagent_end",
      id: "sa-1",
      status: "completed",
    });

    expect(tracker.getActiveSubagents()).toHaveLength(0);
    expect(tracker.getAllSubagents()).toHaveLength(1);
  });

  it("ignores end events for unknown subagent IDs", () => {
    // Should not throw
    tracker.handleEvent({
      type: "subagent_end",
      id: "unknown",
      status: "completed",
    });

    expect(tracker.getAllSubagents()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// tool_start / tool_end
// ---------------------------------------------------------------------------

describe("handleEvent — tool_start / tool_end", () => {
  beforeEach(() => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "agent-a",
      parent: "default",
    });
  });

  it("records a tool call on the subagent", () => {
    tracker.handleEvent({
      type: "tool_start",
      tool: "shell",
      args: { command: "npm test" },
      subagentId: "sa-1",
    });

    const sa = tracker.getSubagent("sa-1")!;
    expect(sa.toolCalls).toHaveLength(1);
    expect(sa.toolCalls[0].tool).toBe("shell");
    expect(sa.toolCalls[0].args).toEqual({ command: "npm test" });
    expect(sa.currentTool).toBe("shell");
  });

  it("completes a tool call on tool_end", () => {
    tracker.handleEvent({
      type: "tool_start",
      tool: "shell",
      args: { command: "npm test" },
      subagentId: "sa-1",
    });

    tracker.handleEvent({
      type: "tool_end",
      tool: "shell",
      result: "All tests passed",
      subagentId: "sa-1",
    });

    const sa = tracker.getSubagent("sa-1")!;
    expect(sa.toolCalls[0].result).toBe("All tests passed");
    expect(sa.toolCalls[0].completedAt).toBeGreaterThan(0);
    expect(sa.currentTool).toBeUndefined();
  });

  it("matches the last open tool call for tool_end", () => {
    // Start two shell tool calls
    tracker.handleEvent({
      type: "tool_start",
      tool: "shell",
      args: { command: "first" },
      subagentId: "sa-1",
    });
    tracker.handleEvent({
      type: "tool_start",
      tool: "shell",
      args: { command: "second" },
      subagentId: "sa-1",
    });

    // End one — should match the LAST open shell call
    tracker.handleEvent({
      type: "tool_end",
      tool: "shell",
      result: "done",
      subagentId: "sa-1",
    });

    const sa = tracker.getSubagent("sa-1")!;
    expect(sa.toolCalls[0].completedAt).toBeUndefined();
    expect(sa.toolCalls[1].result).toBe("done");
    expect(sa.toolCalls[1].completedAt).toBeDefined();
  });

  it("ignores tool_start without subagentId", () => {
    tracker.handleEvent({
      type: "tool_start",
      tool: "shell",
      args: { command: "npm test" },
    });

    // sa-1 should have no tool calls
    expect(tracker.getSubagent("sa-1")!.toolCalls).toHaveLength(0);
  });

  it("ignores tool events for unknown subagent IDs", () => {
    tracker.handleEvent({
      type: "tool_start",
      tool: "shell",
      args: { command: "npm test" },
      subagentId: "unknown",
    });

    // No crash, sa-1 unaffected
    expect(tracker.getSubagent("sa-1")!.toolCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// done event
// ---------------------------------------------------------------------------

describe("handleEvent — done", () => {
  it("marks all running subagents as completed", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "agent-a",
      parent: "default",
    });
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-2",
      name: "agent-b",
      parent: "default",
    });

    tracker.handleEvent({ type: "done", agent: "default" });

    expect(tracker.getSubagent("sa-1")!.status).toBe("completed");
    expect(tracker.getSubagent("sa-2")!.status).toBe("completed");
    expect(tracker.getActiveSubagents()).toHaveLength(0);
  });

  it("does not re-mark already completed subagents", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "agent-a",
      parent: "default",
    });
    tracker.handleEvent({
      type: "subagent_end",
      id: "sa-1",
      status: "failed",
    });

    tracker.handleEvent({ type: "done", agent: "default" });

    // Should remain "failed", not be changed to "completed"
    expect(tracker.getSubagent("sa-1")!.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe("reset", () => {
  it("clears all subagents", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "agent-a",
      parent: "default",
    });

    tracker.reset();

    expect(tracker.getAllSubagents()).toHaveLength(0);
    expect(tracker.getSubagent("sa-1")).toBeUndefined();
  });

  it("fires onSubagentsReset event", () => {
    const listener = vi.fn();
    tracker.onSubagentsReset(listener);

    tracker.reset();

    expect(listener).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

describe("dispose", () => {
  it("does not throw", () => {
    expect(() => tracker.dispose()).not.toThrow();
  });
});
