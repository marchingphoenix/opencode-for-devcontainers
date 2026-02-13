import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
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
 * Helper: start the bridge and advance fake timers so `waitForReady`
 * resolves (the 5 s readiness timeout).
 */
async function startBridge(bridge: OpenCodeBridge): Promise<void> {
  const p = bridge.start();
  // Advance past the SPAWN_READY_TIMEOUT_MS (5 000 ms).
  await vi.advanceTimersByTimeAsync(5_000);
  await p;
}

let bridge: OpenCodeBridge;
let mockManager: ReturnType<typeof createMockDevcontainerManager>;
let mockProcess: ReturnType<typeof createMockProcess>;

beforeEach(() => {
  vi.useFakeTimers();

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

afterEach(() => {
  vi.useRealTimers();
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
// start — local-with-remote-exec
// ---------------------------------------------------------------------------

describe("start — local-with-remote-exec", () => {
  it("spawns opencode process with --format json", async () => {
    await startBridge(bridge);

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe("opencode");
    expect(args).toContain("--format");
    expect(args).toContain("json");
  });

  it("sets SHELL env to shell wrapper path", async () => {
    await startBridge(bridge);

    const opts = mockSpawn.mock.calls[0][2];
    expect(opts.env.SHELL).toContain("shell-wrapper");
  });

  it("sets OPENCODE_DEVCONTAINER env vars", async () => {
    await startBridge(bridge);

    const opts = mockSpawn.mock.calls[0][2];
    expect(opts.env.OPENCODE_DEVCONTAINER).toBe("1");
    expect(opts.env.OPENCODE_DEVCONTAINER_ID).toBe("abc123def456");
    expect(opts.env.OPENCODE_WORKSPACE_FOLDER).toBe("/workspaces/project");
  });

  it("transitions to idle state after spawn", async () => {
    await startBridge(bridge);
    expect(bridge.state).toBe("idle");
    expect(bridge.isRunning()).toBe(true);
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

    // No process is spawned so waitForReady is skipped — resolves immediately.
    await bridge.start();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("not running"),
      })
    );
    expect(bridge.state).toBe("error");
  });

  it("does not spawn a second process if already running", async () => {
    await startBridge(bridge);
    await startBridge(bridge);

    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it("resolves start() early when process errors during startup", async () => {
    const p = bridge.start();

    // Simulate process error event firing before the readiness timeout.
    const errorCall = mockProcess.on.mock.calls.find(
      ([event]: [string]) => event === "error"
    );
    expect(errorCall).toBeDefined();
    const errorHandler = errorCall![1] as (err: Error) => void;
    errorHandler(new Error("spawn ENOENT"));

    // Advance a small amount — should resolve immediately via state listener.
    await vi.advanceTimersByTimeAsync(10);
    await p;

    expect(bridge.state).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// start — in-container
// ---------------------------------------------------------------------------

describe("start — in-container", () => {
  it("spawns docker exec with -i flag and the container ID", async () => {
    __setMockConfig({
      "opencode-devcontainer.executionMode": "in-container",
    });

    await startBridge(bridge);

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe("docker");
    expect(args).toContain("exec");
    expect(args).toContain("-i");
    expect(args).toContain("abc123def456");
    expect(args).toContain("opencode");
  });

  it("places -i flag before other exec arguments", async () => {
    __setMockConfig({
      "opencode-devcontainer.executionMode": "in-container",
    });

    await startBridge(bridge);

    const args = mockSpawn.mock.calls[0][1] as string[];
    const execIdx = args.indexOf("exec");
    const iIdx = args.indexOf("-i");
    const containerIdx = args.indexOf("abc123def456");
    expect(iIdx).toBeGreaterThan(execIdx);
    expect(iIdx).toBeLessThan(containerIdx);
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
  });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe("stop", () => {
  it("kills the process and transitions to stopped", async () => {
    await startBridge(bridge);
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
// sendPrompt / cancelCurrentRequest / sendConfig
// ---------------------------------------------------------------------------

describe("commands", () => {
  it("sendPrompt writes JSON to stdin", async () => {
    await startBridge(bridge);
    const writeSpy = vi.spyOn(mockProcess.stdin, "write");

    bridge.sendPrompt("Fix the bug", "default", ["/src/app.ts"]);

    expect(writeSpy).toHaveBeenCalledOnce();
    const written = writeSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe("prompt");
    expect(parsed.text).toBe("Fix the bug");
    expect(parsed.agent).toBe("default");
    expect(parsed.references).toEqual(["/src/app.ts"]);
  });

  it("sendPrompt transitions to busy state", async () => {
    await startBridge(bridge);

    bridge.sendPrompt("hello");
    expect(bridge.state).toBe("busy");
  });

  it("cancelCurrentRequest writes cancel command", async () => {
    await startBridge(bridge);
    const writeSpy = vi.spyOn(mockProcess.stdin, "write");

    bridge.cancelCurrentRequest();

    expect(writeSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse((writeSpy.mock.calls[0][0] as string).trim());
    expect(parsed.type).toBe("cancel");
  });

  it("sendConfig writes config command", async () => {
    await startBridge(bridge);
    const writeSpy = vi.spyOn(mockProcess.stdin, "write");

    bridge.sendConfig("gpt4", "openai", "gpt-4");

    const parsed = JSON.parse((writeSpy.mock.calls[0][0] as string).trim());
    expect(parsed.type).toBe("config");
    expect(parsed.agent).toBe("gpt4");
    expect(parsed.provider).toBe("openai");
    expect(parsed.model).toBe("gpt-4");
  });

  it("does not write when process is not running", () => {
    // Don't start the bridge
    bridge.sendPrompt("hello");
    // No crash, just silently ignored
  });
});

// ---------------------------------------------------------------------------
// onStateChanged
// ---------------------------------------------------------------------------

describe("onStateChanged", () => {
  it("fires when state transitions", async () => {
    const listener = vi.fn();
    bridge.onStateChanged(listener);

    await startBridge(bridge);

    // Should have fired with "idle" at minimum
    expect(listener).toHaveBeenCalledWith("idle");
  });
});

// ---------------------------------------------------------------------------
// stderr handling
// ---------------------------------------------------------------------------

describe("stderr handling", () => {
  it("fires error event for lines that look like real errors", async () => {
    await startBridge(bridge);
    const listener = vi.fn();
    bridge.onEvent(listener);

    // Push an error-like line through stderr.
    mockProcess.stderr.push("Error: something went wrong\n");

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "Error: something went wrong",
      })
    );
  });

  it("fires status event for informational stderr lines", async () => {
    await startBridge(bridge);
    const listener = vi.fn();
    bridge.onEvent(listener);

    // Push a non-error line through stderr (e.g. a warning or progress).
    mockProcess.stderr.push("Loading configuration...\n");

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "status",
        message: "Loading configuration...",
        agent: "system",
      })
    );
  });

  it("treats FATAL lines as errors", async () => {
    await startBridge(bridge);
    const listener = vi.fn();
    bridge.onEvent(listener);

    mockProcess.stderr.push("FATAL: could not bind port\n");

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" })
    );
  });

  it("treats panic lines as errors", async () => {
    await startBridge(bridge);
    const listener = vi.fn();
    bridge.onEvent(listener);

    mockProcess.stderr.push("panic: runtime error\n");

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" })
    );
  });

  it("does not fire events for empty stderr", async () => {
    await startBridge(bridge);
    const listener = vi.fn();
    bridge.onEvent(listener);

    mockProcess.stderr.push("  \n");

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

  it("fires error event on clean exit (code 0)", async () => {
    await startBridge(bridge);
    const listener = vi.fn();
    bridge.onEvent(listener);

    const exitHandler = getExitHandler();
    expect(exitHandler).toBeDefined();
    exitHandler!(0);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("exited unexpectedly"),
      })
    );
    expect(bridge.state).toBe("stopped");
  });

  it("fires error event on clean exit (code null)", async () => {
    await startBridge(bridge);
    const listener = vi.fn();
    bridge.onEvent(listener);

    const exitHandler = getExitHandler();
    exitHandler!(null);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("exited unexpectedly"),
      })
    );
    expect(bridge.state).toBe("stopped");
  });

  it("fires error event on non-zero exit", async () => {
    await startBridge(bridge);
    const listener = vi.fn();
    bridge.onEvent(listener);

    const exitHandler = getExitHandler();
    exitHandler!(1);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("exited with code 1"),
      })
    );
    expect(bridge.state).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe("dispose", () => {
  it("stops the bridge and disposes resources", async () => {
    await startBridge(bridge);
    expect(() => bridge.dispose()).not.toThrow();
    expect(bridge.state).toBe("stopped");
  });

  it("is safe to call multiple times", () => {
    bridge.dispose();
    bridge.dispose();
  });
});
