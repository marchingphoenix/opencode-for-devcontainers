import { describe, it, expect, beforeEach, vi } from "vitest";
import * as childProcess from "child_process";
import {
  __resetMocks,
  __setMockConfig,
  __setWorkspaceFolders,
  Uri,
  EventEmitter,
} from "../__mocks__/vscode";
import { OpenCodeBridge } from "./opencodeBridge";
import { DevcontainerState } from "../devcontainerManager";
import { Readable, Writable } from "stream";

// Mock child_process.spawn and fs (used by shellWrapper)
vi.mock("child_process", async () => {
  const actual = await vi.importActual("child_process");
  return {
    ...actual,
    spawn: vi.fn(),
    exec: vi.fn(),
  };
});

vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

const mockSpawn = childProcess.spawn as unknown as ReturnType<typeof vi.fn>;

// Minimal mock DevcontainerManager
function createMockDevcontainerManager(opts: {
  state: DevcontainerState;
  containerId: string | undefined;
  remoteWorkspaceFolder: string | undefined;
}) {
  const stateEmitter = new EventEmitter<DevcontainerState>();
  return {
    state: opts.state,
    containerId: opts.containerId,
    remoteWorkspaceFolder: opts.remoteWorkspaceFolder,
    onStateChanged: stateEmitter.event,
  };
}

// Create a mock child process
function createMockProcess() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const proc = {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    on: vi.fn(),
    pid: 12345,
  };
  return proc;
}

/**
 * Helper: flush Node.js stream/readline async processing.
 * Stream `data` and readline `line` events fire asynchronously after push().
 */
function flushStreams(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

let bridge: OpenCodeBridge;
let mockManager: ReturnType<typeof createMockDevcontainerManager>;
let mockProcess: ReturnType<typeof createMockProcess>;

beforeEach(() => {
  __resetMocks();
  __setWorkspaceFolders([{ uri: Uri.file("/home/user/project") }]);

  mockProcess = createMockProcess();
  mockSpawn.mockReset();
  mockSpawn.mockReturnValue(mockProcess);

  mockManager = createMockDevcontainerManager({
    state: "running",
    containerId: "abc123def456",
    remoteWorkspaceFolder: "/workspaces/project",
  });
  bridge = new OpenCodeBridge(mockManager as any);
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("initial state", () => {
  it("starts in stopped state", () => {
    expect(bridge.state).toBe("stopped");
  });

  it("is not running", () => {
    expect(bridge.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// start — prepares the bridge without spawning a process
// ---------------------------------------------------------------------------

describe("start — local-with-remote-exec", () => {
  it("transitions to idle state (no process spawned)", async () => {
    await bridge.start();

    // start() only prepares env / shell wrapper — no process yet.
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(bridge.state).toBe("idle");
    expect(bridge.isRunning()).toBe(true);
  });

  it("sets up SHELL env with shell wrapper", async () => {
    await bridge.start();

    // Now trigger a prompt to verify the env is passed.
    bridge.sendPrompt("hello");

    expect(mockSpawn).toHaveBeenCalledOnce();
    const opts = mockSpawn.mock.calls[0][2];
    expect(opts.env.SHELL).toContain("shell-wrapper");
    expect(opts.env.OPENCODE_DEVCONTAINER).toBe("1");
    expect(opts.env.OPENCODE_DEVCONTAINER_ID).toBe("abc123def456");
    expect(opts.env.OPENCODE_WORKSPACE_FOLDER).toBe("/workspaces/project");
  });

  it("fires error event when container info is unavailable", async () => {
    mockManager = createMockDevcontainerManager({
      state: "running",
      containerId: undefined,
      remoteWorkspaceFolder: undefined,
    });
    bridge = new OpenCodeBridge(mockManager as any);

    const listener = vi.fn();
    bridge.onEvent(listener);

    await bridge.start();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("not running"),
      })
    );
    expect(bridge.state).toBe("error");
    expect(bridge.isRunning()).toBe(false);
  });

  it("is idempotent when already idle", async () => {
    await bridge.start();
    await bridge.start();

    // Should not error or re-prepare.
    expect(bridge.state).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// start — in-container
// ---------------------------------------------------------------------------

describe("start — in-container", () => {
  it("transitions to idle without spawning", async () => {
    __setMockConfig({
      "opencode-devcontainer.executionMode": "in-container",
    });

    await bridge.start();

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(bridge.state).toBe("idle");
  });

  it("fires error when no containerId", async () => {
    __setMockConfig({
      "opencode-devcontainer.executionMode": "in-container",
    });
    mockManager = createMockDevcontainerManager({
      state: "running",
      containerId: undefined,
      remoteWorkspaceFolder: "/workspaces/project",
    });
    bridge = new OpenCodeBridge(mockManager as any);

    const listener = vi.fn();
    bridge.onEvent(listener);

    await bridge.start();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" })
    );
    expect(bridge.state).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// sendPrompt — per-prompt spawning
// ---------------------------------------------------------------------------

describe("sendPrompt", () => {
  it("spawns opencode run --format json -q with the prompt", async () => {
    await bridge.start();
    bridge.sendPrompt("Fix the bug");

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe("opencode");
    expect(args).toContain("run");
    expect(args).toContain("--format");
    expect(args).toContain("json");
    expect(args).toContain("-q");
    expect(args).toContain("Fix the bug");
  });

  it("transitions to busy state", async () => {
    await bridge.start();
    bridge.sendPrompt("hello");
    expect(bridge.state).toBe("busy");
  });

  it("includes file references in prompt text", async () => {
    await bridge.start();
    bridge.sendPrompt("Fix the bug", "default", ["/src/app.ts", "/src/lib.ts"]);

    const args = mockSpawn.mock.calls[0][1] as string[];
    const promptArg = args[args.length - 1];
    expect(promptArg).toContain("@/src/app.ts");
    expect(promptArg).toContain("@/src/lib.ts");
    expect(promptArg).toContain("Fix the bug");
  });

  it("spawns docker exec with -i in in-container mode", async () => {
    __setMockConfig({
      "opencode-devcontainer.executionMode": "in-container",
    });

    await bridge.start();
    bridge.sendPrompt("Fix the bug");

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe("docker");
    expect(args).toContain("exec");
    expect(args).toContain("-i");
    expect(args).toContain("abc123def456");
    expect(args).toContain("opencode");
    expect(args).toContain("run");
    expect(args).toContain("Fix the bug");
  });

  it("kills existing process before spawning new one", async () => {
    await bridge.start();
    bridge.sendPrompt("first prompt");

    const firstProcess = mockProcess;
    mockProcess = createMockProcess();
    mockSpawn.mockReturnValue(mockProcess);

    bridge.sendPrompt("second prompt");

    expect(firstProcess.kill).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe("stop", () => {
  it("kills any active process and transitions to stopped", async () => {
    await bridge.start();
    bridge.sendPrompt("hello");
    bridge.stop();

    expect(mockProcess.kill).toHaveBeenCalled();
    expect(bridge.state).toBe("stopped");
    expect(bridge.isRunning()).toBe(false);
  });

  it("is safe to call when not running", () => {
    expect(() => bridge.stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// cancelCurrentRequest
// ---------------------------------------------------------------------------

describe("cancelCurrentRequest", () => {
  it("kills the active process", async () => {
    await bridge.start();
    bridge.sendPrompt("hello");
    bridge.cancelCurrentRequest();

    expect(mockProcess.kill).toHaveBeenCalled();
  });

  it("is safe to call with no active process", async () => {
    await bridge.start();
    expect(() => bridge.cancelCurrentRequest()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// onStateChanged
// ---------------------------------------------------------------------------

describe("onStateChanged", () => {
  it("fires when state transitions", async () => {
    const listener = vi.fn();
    bridge.onStateChanged(listener);

    await bridge.start();

    expect(listener).toHaveBeenCalledWith("idle");
  });
});

// ---------------------------------------------------------------------------
// NDJSON event mapping
// ---------------------------------------------------------------------------

describe("NDJSON event mapping", () => {
  it("maps text events (text → content field)", async () => {
    await bridge.start();
    const listener = vi.fn();
    bridge.onEvent(listener);
    bridge.sendPrompt("hello");

    // Simulate OpenCode emitting a text event.
    mockProcess.stdout.push('{"type":"text","text":"Hello world"}\n');
    await flushStreams();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "text",
        content: "Hello world",
        agent: "default",
      })
    );
  });

  it("maps step_start to status event", async () => {
    await bridge.start();
    const listener = vi.fn();
    bridge.onEvent(listener);
    bridge.sendPrompt("hello");

    mockProcess.stdout.push(
      '{"type":"step_start","message":"Analyzing code..."}\n'
    );
    await flushStreams();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "status",
        message: "Analyzing code...",
      })
    );
  });

  it("maps step_finish to done event", async () => {
    await bridge.start();
    const listener = vi.fn();
    bridge.onEvent(listener);
    bridge.sendPrompt("hello");

    mockProcess.stdout.push('{"type":"step_finish"}\n');
    await flushStreams();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "done" })
    );
    expect(bridge.state).toBe("idle");
  });

  it("passes through tool_start events", async () => {
    await bridge.start();
    const listener = vi.fn();
    bridge.onEvent(listener);
    bridge.sendPrompt("hello");

    mockProcess.stdout.push(
      '{"type":"tool_start","tool":"bash","args":{"command":"ls"}}\n'
    );
    await flushStreams();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool_start",
        tool: "bash",
        args: { command: "ls" },
      })
    );
  });

  it("passes through error events", async () => {
    await bridge.start();
    const listener = vi.fn();
    bridge.onEvent(listener);
    bridge.sendPrompt("hello");

    mockProcess.stdout.push(
      '{"type":"error","message":"Something broke"}\n'
    );
    await flushStreams();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "Something broke",
      })
    );
  });

  it("extracts text from unknown event types", async () => {
    await bridge.start();
    const listener = vi.fn();
    bridge.onEvent(listener);
    bridge.sendPrompt("hello");

    mockProcess.stdout.push(
      '{"type":"unknown_event","text":"Some text content"}\n'
    );
    await flushStreams();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "text",
        content: "Some text content",
      })
    );
  });
});

// ---------------------------------------------------------------------------
// stderr handling
// ---------------------------------------------------------------------------

describe("stderr handling", () => {
  it("fires error event for lines that look like real errors", async () => {
    await bridge.start();
    const listener = vi.fn();
    bridge.onEvent(listener);
    bridge.sendPrompt("hello");

    mockProcess.stderr.push("Error: something went wrong\n");
    await flushStreams();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "Error: something went wrong",
      })
    );
  });

  it("fires status event for informational stderr lines", async () => {
    await bridge.start();
    const listener = vi.fn();
    bridge.onEvent(listener);
    bridge.sendPrompt("hello");

    mockProcess.stderr.push("Loading configuration...\n");
    await flushStreams();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "status",
        message: "Loading configuration...",
        agent: "system",
      })
    );
  });

  it("treats FATAL lines as errors", async () => {
    await bridge.start();
    const listener = vi.fn();
    bridge.onEvent(listener);
    bridge.sendPrompt("hello");

    mockProcess.stderr.push("FATAL: could not bind port\n");
    await flushStreams();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" })
    );
  });

  it("does not fire events for empty stderr", async () => {
    await bridge.start();
    const listener = vi.fn();
    bridge.onEvent(listener);
    bridge.sendPrompt("hello");

    mockProcess.stderr.push("  \n");
    await flushStreams();

    expect(listener).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// process exit — event notification
// ---------------------------------------------------------------------------

describe("process exit", () => {
  function getExitHandler() {
    const exitCall = mockProcess.on.mock.calls.find(
      ([event]: [string]) => event === "exit"
    );
    return exitCall?.[1] as ((code: number | null) => void) | undefined;
  }

  it("emits done event on clean exit (code 0) when still busy", async () => {
    await bridge.start();
    const listener = vi.fn();
    bridge.onEvent(listener);
    bridge.sendPrompt("hello");

    const exitHandler = getExitHandler();
    expect(exitHandler).toBeDefined();
    exitHandler!(0);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "done" })
    );
    expect(bridge.state).toBe("idle");
  });

  it("emits done event on clean exit (code null) when still busy", async () => {
    await bridge.start();
    const listener = vi.fn();
    bridge.onEvent(listener);
    bridge.sendPrompt("hello");

    const exitHandler = getExitHandler();
    exitHandler!(null);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "done" })
    );
    expect(bridge.state).toBe("idle");
  });

  it("does not double-emit done if step_finish already fired", async () => {
    await bridge.start();
    const listener = vi.fn();
    bridge.onEvent(listener);
    bridge.sendPrompt("hello");

    // Simulate step_finish (maps to done) setting state to idle.
    mockProcess.stdout.push('{"type":"step_finish"}\n');
    await flushStreams();

    // Now the process exits — should NOT emit another done.
    const exitHandler = getExitHandler();
    exitHandler!(0);

    const doneEvents = listener.mock.calls.filter(
      ([e]: [{ type: string }]) => e.type === "done"
    );
    expect(doneEvents).toHaveLength(1);
  });

  it("fires error event on non-zero exit", async () => {
    await bridge.start();
    const listener = vi.fn();
    bridge.onEvent(listener);
    bridge.sendPrompt("hello");

    const exitHandler = getExitHandler();
    exitHandler!(1);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("exited with code 1"),
      })
    );
    // Bridge stays idle — ready for next prompt.
    expect(bridge.state).toBe("idle");
  });

  it("stays idle after non-zero exit (ready for next prompt)", async () => {
    await bridge.start();
    bridge.sendPrompt("hello");

    const exitHandler = getExitHandler();
    exitHandler!(1);

    expect(bridge.isRunning()).toBe(true);
    expect(bridge.state).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// buildPromptText
// ---------------------------------------------------------------------------

describe("prompt text building", () => {
  it("passes plain prompt when no references", async () => {
    await bridge.start();
    bridge.sendPrompt("Fix the bug");

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[args.length - 1]).toBe("Fix the bug");
  });

  it("prepends @file references to prompt", async () => {
    await bridge.start();
    bridge.sendPrompt("Fix it", undefined, ["/a.ts", "/b.ts"]);

    const args = mockSpawn.mock.calls[0][1] as string[];
    const promptArg = args[args.length - 1];
    expect(promptArg).toBe("@/a.ts @/b.ts\n\nFix it");
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe("dispose", () => {
  it("stops the bridge and disposes resources", async () => {
    await bridge.start();
    bridge.sendPrompt("hello");
    expect(() => bridge.dispose()).not.toThrow();
    expect(bridge.state).toBe("stopped");
  });

  it("is safe to call multiple times", () => {
    bridge.dispose();
    bridge.dispose();
  });
});
