import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { __resetMocks } from "../__mocks__/vscode";
import { OpenCodeAdapter } from "./opencodeAdapter";

let adapter: OpenCodeAdapter;

beforeEach(() => {
  __resetMocks();
  adapter = new OpenCodeAdapter();
});

afterEach(() => {
  adapter.dispose();
});

// ---------------------------------------------------------------------------
// JSON passthrough
// ---------------------------------------------------------------------------

describe("processLine — JSON passthrough", () => {
  it("parses a valid JSON event and returns it", () => {
    const event = adapter.processLine(
      '{"type":"text","content":"hello","agent":"default"}'
    );

    expect(event).toEqual({
      type: "text",
      content: "hello",
      agent: "default",
    });
  });

  it("fires onEvent for valid JSON", () => {
    const listener = vi.fn();
    adapter.onEvent(listener);

    adapter.processLine('{"type":"done","agent":"default"}');

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toEqual({
      type: "done",
      agent: "default",
    });
  });

  it("ignores non-JSON lines starting with {", () => {
    // This is invalid JSON that starts with {
    const event = adapter.processLine("{not valid json");
    expect(event).toBeNull();
  });

  it("ignores JSON objects without a type field", () => {
    const event = adapter.processLine('{"foo":"bar"}');
    expect(event).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Status line detection
// ---------------------------------------------------------------------------

describe("processLine — status detection", () => {
  it("detects spinner character prefixed lines", () => {
    const event = adapter.processLine("\u280B Thinking...");
    expect(event).toEqual({
      type: "status",
      message: "Thinking...",
      agent: "default",
    });
  });

  it("detects [status] prefixed lines", () => {
    const event = adapter.processLine("[status] Processing request");
    expect(event).toEqual({
      type: "status",
      message: "Processing request",
      agent: "default",
    });
  });

  it("is case-insensitive for [status] prefix", () => {
    const event = adapter.processLine("[Status] Loading files");
    expect(event).toEqual({
      type: "status",
      message: "Loading files",
      agent: "default",
    });
  });
});

// ---------------------------------------------------------------------------
// Tool call detection
// ---------------------------------------------------------------------------

describe("processLine — tool call detection", () => {
  it("detects 'Running: <command>' as shell tool_start", () => {
    const event = adapter.processLine("Running: npm test");
    expect(event).toEqual({
      type: "tool_start",
      tool: "shell",
      args: { command: "npm test" },
    });
  });

  it("detects 'Executing: <command>' as shell tool_start", () => {
    const event = adapter.processLine("Executing: ls -la");
    expect(event).toEqual({
      type: "tool_start",
      tool: "shell",
      args: { command: "ls -la" },
    });
  });

  it("detects 'Reading: <path>' as file_read tool_start", () => {
    const event = adapter.processLine("Reading: src/app.ts");
    expect(event).toEqual({
      type: "tool_start",
      tool: "file_read",
      args: { path: "src/app.ts" },
    });
  });

  it("detects 'Editing: <path>' as file_edit tool_start", () => {
    const event = adapter.processLine("Editing: src/app.ts");
    expect(event).toEqual({
      type: "tool_start",
      tool: "file_edit",
      args: { path: "src/app.ts" },
    });
  });

  it("detects 'Writing: <path>' as file_edit tool_start", () => {
    const event = adapter.processLine("Writing: src/new-file.ts");
    expect(event).toEqual({
      type: "tool_start",
      tool: "file_edit",
      args: { path: "src/new-file.ts" },
    });
  });
});

// ---------------------------------------------------------------------------
// Subagent detection
// ---------------------------------------------------------------------------

describe("processLine — subagent detection", () => {
  it("detects subagent start pattern", () => {
    const event = adapter.processLine("[agent:sa-1] Starting coding-agent...");
    expect(event).toEqual({
      type: "subagent_start",
      id: "sa-1",
      name: "coding-agent",
      parent: "default",
    });
  });

  it("detects subagent start with 'Spawning'", () => {
    const event = adapter.processLine("[agent:sa-2] Spawning test-runner");
    expect(event).toEqual({
      type: "subagent_start",
      id: "sa-2",
      name: "test-runner",
      parent: "default",
    });
  });

  it("detects subagent end - Completed", () => {
    const event = adapter.processLine("[agent:sa-1] Completed");
    expect(event).toEqual({
      type: "subagent_end",
      id: "sa-1",
      status: "completed",
    });
  });

  it("detects subagent end - Failed", () => {
    const event = adapter.processLine("[agent:sa-1] Failed");
    expect(event).toEqual({
      type: "subagent_end",
      id: "sa-1",
      status: "failed",
    });
  });

  it("detects subagent end - Cancelled", () => {
    const event = adapter.processLine("[agent:sa-1] Cancelled");
    expect(event).toEqual({
      type: "subagent_end",
      id: "sa-1",
      status: "cancelled",
    });
  });
});

// ---------------------------------------------------------------------------
// Completion detection
// ---------------------------------------------------------------------------

describe("processLine — completion detection", () => {
  it("detects 'Done' as a done event", () => {
    const event = adapter.processLine("Done");
    expect(event).toEqual({ type: "done", agent: "default" });
  });

  it("detects 'Finished.' as a done event", () => {
    const event = adapter.processLine("Finished.");
    expect(event).toEqual({ type: "done", agent: "default" });
  });

  it("detects 'Complete!' as a done event", () => {
    const event = adapter.processLine("Complete!");
    expect(event).toEqual({ type: "done", agent: "default" });
  });
});

// ---------------------------------------------------------------------------
// Error detection
// ---------------------------------------------------------------------------

describe("processLine — error detection", () => {
  it("detects 'Error: <message>' lines", () => {
    const event = adapter.processLine("Error: something went wrong");
    expect(event).toEqual({
      type: "error",
      message: "something went wrong",
    });
  });

  it("detects 'ERROR: <message>' lines", () => {
    const event = adapter.processLine("ERROR: timeout exceeded");
    expect(event).toEqual({
      type: "error",
      message: "timeout exceeded",
    });
  });
});

// ---------------------------------------------------------------------------
// Text accumulation
// ---------------------------------------------------------------------------

describe("processLine — text accumulation", () => {
  it("returns null for plain text (buffered)", () => {
    const event = adapter.processLine("This is some output text");
    expect(event).toBeNull();
  });

  it("returns null for empty lines", () => {
    const event = adapter.processLine("");
    expect(event).toBeNull();
  });

  it("returns null for whitespace-only lines", () => {
    const event = adapter.processLine("   ");
    expect(event).toBeNull();
  });

  it("flushes buffered text when a structured event arrives", () => {
    const listener = vi.fn();
    adapter.onEvent(listener);

    // Accumulate text
    adapter.processLine("Some output");
    adapter.processLine("More output");

    // Now trigger a structured event which should flush
    adapter.processLine("Done");

    // Should have received: text event (flushed), then done event
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0][0]).toEqual({
      type: "text",
      content: "Some output\nMore output",
      agent: "default",
    });
    expect(listener.mock.calls[1][0]).toEqual({
      type: "done",
      agent: "default",
    });
  });
});

// ---------------------------------------------------------------------------
// processChunk
// ---------------------------------------------------------------------------

describe("processChunk", () => {
  it("processes multiple lines from a buffer", () => {
    const listener = vi.fn();
    adapter.onEvent(listener);

    const data = Buffer.from("Running: npm test\nDone\n");
    adapter.processChunk(data);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0][0].type).toBe("tool_start");
    expect(listener.mock.calls[1][0].type).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe("dispose", () => {
  it("flushes remaining text on dispose", () => {
    const listener = vi.fn();
    adapter.onEvent(listener);

    adapter.processLine("buffered text");
    adapter.dispose();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toEqual({
      type: "text",
      content: "buffered text",
      agent: "default",
    });
  });
});
