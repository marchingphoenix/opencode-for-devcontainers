import { describe, it, expect, beforeEach } from "vitest";
import { __resetMocks, TreeItemCollapsibleState } from "../__mocks__/vscode";
import { SubagentTracker } from "./subagentTracker";
import { SubagentTreeProvider } from "./subagentTreeProvider";

let tracker: SubagentTracker;
let provider: SubagentTreeProvider;

beforeEach(() => {
  __resetMocks();
  tracker = new SubagentTracker();
  provider = new SubagentTreeProvider(tracker);
});

// ---------------------------------------------------------------------------
// getChildren — root
// ---------------------------------------------------------------------------

describe("getChildren — root", () => {
  it("returns empty array when no subagents exist", () => {
    const children = provider.getChildren();
    expect(children).toHaveLength(0);
  });

  it("returns subagent items for all tracked subagents", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "coding-agent",
      parent: "default",
    });
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-2",
      name: "test-runner",
      parent: "default",
    });

    const children = provider.getChildren();
    expect(children).toHaveLength(2);
    expect(children[0].kind).toBe("subagent");
    expect(children[1].kind).toBe("subagent");
  });
});

// ---------------------------------------------------------------------------
// getChildren — subagent children (tool calls)
// ---------------------------------------------------------------------------

describe("getChildren — subagent children", () => {
  it("returns tool call items for a subagent", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "coding-agent",
      parent: "default",
    });
    tracker.handleEvent({
      type: "tool_start",
      tool: "shell",
      args: { command: "npm test" },
      subagentId: "sa-1",
    });

    const root = provider.getChildren();
    const children = provider.getChildren(root[0]);

    expect(children).toHaveLength(1);
    expect(children[0].kind).toBe("toolcall");
    expect(children[0].toolCall.tool).toBe("shell");
  });

  it("returns empty array for subagent with no tool calls", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "coding-agent",
      parent: "default",
    });

    const root = provider.getChildren();
    const children = provider.getChildren(root[0]);
    expect(children).toHaveLength(0);
  });

  it("returns empty array for toolcall items", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "coding-agent",
      parent: "default",
    });
    tracker.handleEvent({
      type: "tool_start",
      tool: "shell",
      args: { command: "npm test" },
      subagentId: "sa-1",
    });

    const root = provider.getChildren();
    const toolItems = provider.getChildren(root[0]);
    const subChildren = provider.getChildren(toolItems[0]);
    expect(subChildren).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getTreeItem — subagent
// ---------------------------------------------------------------------------

describe("getTreeItem — subagent", () => {
  it("returns tree item with agent name as label", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "coding-agent",
      parent: "default",
    });

    const root = provider.getChildren();
    const item = provider.getTreeItem(root[0]);

    expect(item.label).toBe("coding-agent");
  });

  it("has expanded state when there are tool calls", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "coding-agent",
      parent: "default",
    });
    tracker.handleEvent({
      type: "tool_start",
      tool: "shell",
      args: { command: "ls" },
      subagentId: "sa-1",
    });

    const root = provider.getChildren();
    const item = provider.getTreeItem(root[0]);

    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
  });

  it("has none state when there are no tool calls", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "coding-agent",
      parent: "default",
    });

    const root = provider.getChildren();
    const item = provider.getTreeItem(root[0]);

    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
  });

  it("includes status in description", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "coding-agent",
      parent: "default",
    });

    const root = provider.getChildren();
    const item = provider.getTreeItem(root[0]);

    expect(item.description).toContain("running");
  });

  it("includes duration for completed subagents", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "coding-agent",
      parent: "default",
    });
    tracker.handleEvent({
      type: "subagent_end",
      id: "sa-1",
      status: "completed",
    });

    const root = provider.getChildren();
    const item = provider.getTreeItem(root[0]);

    expect(item.description).toContain("completed");
  });
});

// ---------------------------------------------------------------------------
// getTreeItem — tool call
// ---------------------------------------------------------------------------

describe("getTreeItem — tool call", () => {
  it("shows tool name and command in label", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "coding-agent",
      parent: "default",
    });
    tracker.handleEvent({
      type: "tool_start",
      tool: "shell",
      args: { command: "npm test" },
      subagentId: "sa-1",
    });

    const root = provider.getChildren();
    const tools = provider.getChildren(root[0]);
    const item = provider.getTreeItem(tools[0]);

    expect(item.label).toContain("shell");
    expect(item.label).toContain("npm test");
  });

  it("shows path for file tool calls", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "coding-agent",
      parent: "default",
    });
    tracker.handleEvent({
      type: "tool_start",
      tool: "file_read",
      args: { path: "src/app.ts" },
      subagentId: "sa-1",
    });

    const root = provider.getChildren();
    const tools = provider.getChildren(root[0]);
    const item = provider.getTreeItem(tools[0]);

    expect(item.label).toContain("src/app.ts");
  });

  it("shows (no args) for tool calls without recognized args", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "coding-agent",
      parent: "default",
    });
    tracker.handleEvent({
      type: "tool_start",
      tool: "custom",
      args: {},
      subagentId: "sa-1",
    });

    const root = provider.getChildren();
    const tools = provider.getChildren(root[0]);
    const item = provider.getTreeItem(tools[0]);

    expect(item.label).toContain("(no args)");
  });

  it("shows 'running' description for in-progress tool calls", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "coding-agent",
      parent: "default",
    });
    tracker.handleEvent({
      type: "tool_start",
      tool: "shell",
      args: { command: "npm test" },
      subagentId: "sa-1",
    });

    const root = provider.getChildren();
    const tools = provider.getChildren(root[0]);
    const item = provider.getTreeItem(tools[0]);

    expect(item.description).toBe("running");
  });

  it("shows duration for completed tool calls", () => {
    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "coding-agent",
      parent: "default",
    });
    tracker.handleEvent({
      type: "tool_start",
      tool: "shell",
      args: { command: "npm test" },
      subagentId: "sa-1",
    });
    tracker.handleEvent({
      type: "tool_end",
      tool: "shell",
      result: "passed",
      subagentId: "sa-1",
    });

    const root = provider.getChildren();
    const tools = provider.getChildren(root[0]);
    const item = provider.getTreeItem(tools[0]);

    // Should be a duration like "0ms" or "0.0s"
    expect(item.description).not.toBe("running");
  });
});

// ---------------------------------------------------------------------------
// refresh / onDidChangeTreeData
// ---------------------------------------------------------------------------

describe("refresh", () => {
  it("fires onDidChangeTreeData", () => {
    let fired = false;
    provider.onDidChangeTreeData(() => {
      fired = true;
    });

    provider.refresh();
    expect(fired).toBe(true);
  });

  it("auto-refreshes when tracker fires subagent changed", () => {
    let fired = false;
    provider.onDidChangeTreeData(() => {
      fired = true;
    });

    tracker.handleEvent({
      type: "subagent_start",
      id: "sa-1",
      name: "agent-a",
      parent: "default",
    });

    expect(fired).toBe(true);
  });

  it("auto-refreshes when tracker resets", () => {
    let fireCount = 0;
    provider.onDidChangeTreeData(() => {
      fireCount++;
    });

    tracker.reset();
    expect(fireCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe("dispose", () => {
  it("does not throw", () => {
    expect(() => provider.dispose()).not.toThrow();
  });
});
