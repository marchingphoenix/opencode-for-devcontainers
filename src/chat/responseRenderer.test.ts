import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetMocks, __setMockConfig } from "../__mocks__/vscode";
import { ResponseRenderer } from "./responseRenderer";
import { OpenCodeEvent, SubagentInfo, AgentConfig } from "./types";

let renderer: ResponseRenderer;
let stream: {
  progress: ReturnType<typeof vi.fn>;
  markdown: ReturnType<typeof vi.fn>;
  button: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  __resetMocks();
  __setMockConfig({
    "opencode-devcontainer.chat.showToolCalls": true,
  });
  renderer = new ResponseRenderer();

  stream = {
    progress: vi.fn(),
    markdown: vi.fn(),
    button: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// renderEvent — status
// ---------------------------------------------------------------------------

describe("renderEvent — status", () => {
  it("renders a progress message", () => {
    renderer.renderEvent(
      { type: "status", message: "Thinking...", agent: "default" },
      stream as any
    );

    expect(stream.progress).toHaveBeenCalledWith("Thinking...");
  });
});

// ---------------------------------------------------------------------------
// renderEvent — text
// ---------------------------------------------------------------------------

describe("renderEvent — text", () => {
  it("renders markdown content", () => {
    renderer.renderEvent(
      { type: "text", content: "Hello **world**", agent: "default" },
      stream as any
    );

    expect(stream.markdown).toHaveBeenCalledWith("Hello **world**");
  });
});

// ---------------------------------------------------------------------------
// renderEvent — tool_start
// ---------------------------------------------------------------------------

describe("renderEvent — tool_start", () => {
  it("renders tool name with command arg summary", () => {
    renderer.renderEvent(
      {
        type: "tool_start",
        tool: "shell",
        args: { command: "npm test" },
      },
      stream as any
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining("**shell**")
    );
    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining("npm test")
    );
    expect(stream.progress).toHaveBeenCalledWith("Running shell...");
  });

  it("renders tool name with path arg summary", () => {
    renderer.renderEvent(
      {
        type: "tool_start",
        tool: "file_read",
        args: { path: "src/app.ts" },
      },
      stream as any
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining("src/app.ts")
    );
  });

  it("renders JSON args when no command/path", () => {
    renderer.renderEvent(
      {
        type: "tool_start",
        tool: "custom",
        args: { foo: "bar" },
      },
      stream as any
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('{"foo":"bar"}')
    );
  });

  it("does not render tool detail when showToolCalls is false", () => {
    __setMockConfig({
      "opencode-devcontainer.chat.showToolCalls": false,
    });
    renderer = new ResponseRenderer();

    renderer.renderEvent(
      {
        type: "tool_start",
        tool: "shell",
        args: { command: "npm test" },
      },
      stream as any
    );

    // Progress should still be called
    expect(stream.progress).toHaveBeenCalledWith("Running shell...");
    // But markdown tool detail should not
    expect(stream.markdown).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// renderEvent — tool_end
// ---------------------------------------------------------------------------

describe("renderEvent — tool_end", () => {
  it("renders the result in a code block", () => {
    renderer.renderEvent(
      {
        type: "tool_end",
        tool: "shell",
        result: "All tests passed",
      },
      stream as any
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining("All tests passed")
    );
    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining("```")
    );
  });

  it("truncates long results", () => {
    const longResult = "x".repeat(600);

    renderer.renderEvent(
      {
        type: "tool_end",
        tool: "shell",
        result: longResult,
      },
      stream as any
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining("... (truncated)")
    );
  });

  it("does not render empty results", () => {
    renderer.renderEvent(
      {
        type: "tool_end",
        tool: "shell",
        result: "",
      },
      stream as any
    );

    expect(stream.markdown).not.toHaveBeenCalled();
  });

  it("does not render tool_end when showToolCalls is false", () => {
    __setMockConfig({
      "opencode-devcontainer.chat.showToolCalls": false,
    });
    renderer = new ResponseRenderer();

    renderer.renderEvent(
      {
        type: "tool_end",
        tool: "shell",
        result: "output",
      },
      stream as any
    );

    expect(stream.markdown).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// renderEvent — subagent_start
// ---------------------------------------------------------------------------

describe("renderEvent — subagent_start", () => {
  it("shows progress message", () => {
    renderer.renderEvent(
      {
        type: "subagent_start",
        id: "sa-1",
        name: "coding-agent",
        parent: "default",
      },
      stream as any
    );

    expect(stream.progress).toHaveBeenCalledWith(
      "Subagent **coding-agent** started"
    );
  });
});

// ---------------------------------------------------------------------------
// renderEvent — subagent_end
// ---------------------------------------------------------------------------

describe("renderEvent — subagent_end", () => {
  it("renders failure message for failed subagent", () => {
    renderer.renderEvent(
      {
        type: "subagent_end",
        id: "sa-1",
        status: "failed",
      },
      stream as any
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining("failed")
    );
  });

  it("does not render anything for completed subagent", () => {
    renderer.renderEvent(
      {
        type: "subagent_end",
        id: "sa-1",
        status: "completed",
      },
      stream as any
    );

    expect(stream.markdown).not.toHaveBeenCalled();
    expect(stream.progress).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// renderEvent — error
// ---------------------------------------------------------------------------

describe("renderEvent — error", () => {
  it("renders the error in a code block", () => {
    renderer.renderEvent(
      { type: "error", message: "Something went wrong" },
      stream as any
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining("Error: Something went wrong")
    );
  });
});

// ---------------------------------------------------------------------------
// renderEvent — done
// ---------------------------------------------------------------------------

describe("renderEvent — done", () => {
  it("does not render anything for done events", () => {
    renderer.renderEvent(
      { type: "done", agent: "default" },
      stream as any
    );

    expect(stream.markdown).not.toHaveBeenCalled();
    expect(stream.progress).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// renderAgentHeader
// ---------------------------------------------------------------------------

describe("renderAgentHeader", () => {
  it("renders agent name and model info", () => {
    const agent: AgentConfig = {
      id: "default",
      name: "Default Agent",
      provider: "anthropic",
      model: "claude-3",
    };

    renderer.renderAgentHeader(agent, stream as any);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining("Default Agent")
    );
    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining("anthropic/claude-3")
    );
  });
});

// ---------------------------------------------------------------------------
// renderSubagentSummary
// ---------------------------------------------------------------------------

describe("renderSubagentSummary", () => {
  it("renders nothing when there are no subagents", () => {
    renderer.renderSubagentSummary([], stream as any);
    expect(stream.markdown).not.toHaveBeenCalled();
  });

  it("renders a summary for completed subagents", () => {
    const now = Date.now();
    const subagents: SubagentInfo[] = [
      {
        id: "sa-1",
        name: "coding-agent",
        parent: "default",
        status: "completed",
        startedAt: now - 5000,
        completedAt: now,
        toolCalls: [
          { tool: "shell", args: {}, startedAt: now - 4000, completedAt: now - 3000 },
        ],
      },
    ];

    renderer.renderSubagentSummary(subagents, stream as any);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining("Subagent summary")
    );
    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining("coding-agent")
    );
    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining("1 tool call")
    );
  });

  it("shows 'running' for uncompleted subagents", () => {
    const now = Date.now();
    const subagents: SubagentInfo[] = [
      {
        id: "sa-1",
        name: "agent-a",
        parent: "default",
        status: "running",
        startedAt: now - 2000,
        toolCalls: [],
      },
    ];

    renderer.renderSubagentSummary(subagents, stream as any);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining("running")
    );
  });
});
