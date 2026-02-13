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
// start — local-with-remote-exec
// ---------------------------------------------------------------------------

describe("start — local-with-remote-exec", () => {
  it("spawns opencode process with --format json", async () => {
    await bridge.start();

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe("opencode");
    expect(args).toContain("--format");
    expect(args).toContain("json");
  });

  it("sets SHELL env to shell wrapper path", async () => {
    await bridge.start();

    const opts = mockSpawn.mock.calls[0][2];
    expect(opts.env.SHELL).toContain("shell-wrapper");
  });

  it("sets OPENCODE_DEVCONTAINER env vars", async () => {
    await bridge.start();

    const opts = mockSpawn.mock.calls[0][2];
    expect(opts.env.OPENCODE_DEVCONTAINER).toBe("1");
    expect(opts.env.OPENCODE_DEVCONTAINER_ID).toBe("abc123def456");
    expect(opts.env.OPENCODE_WORKSPACE_FOLDER).toBe("/workspaces/project");
  });

  it("transitions to idle state after spawn", async () => {
    await bridge.start();
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
    await bridge.start();
    await bridge.start();

    expect(mockSpawn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// start — in-container
// ---------------------------------------------------------------------------

describe("start — in-container", () => {
  it("spawns docker exec with the container ID", async () => {
    __setMockConfig({
      "opencode-devcontainer.executionMode": "in-container",
    });

    await bridge.start();

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe("docker");
    expect(args).toContain("exec");
    expect(args).toContain("abc123def456");
    expect(args).toContain("opencode");
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
    await bridge.start();
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
    await bridge.start();
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
    await bridge.start();

    bridge.sendPrompt("hello");
    expect(bridge.state).toBe("busy");
  });

  it("cancelCurrentRequest writes cancel command", async () => {
    await bridge.start();
    const writeSpy = vi.spyOn(mockProcess.stdin, "write");

    bridge.cancelCurrentRequest();

    expect(writeSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse((writeSpy.mock.calls[0][0] as string).trim());
    expect(parsed.type).toBe("cancel");
  });

  it("sendConfig writes config command", async () => {
    await bridge.start();
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

    await bridge.start();

    // Should have fired with "idle" at minimum
    expect(listener).toHaveBeenCalledWith("idle");
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe("dispose", () => {
  it("stops the bridge and disposes resources", async () => {
    await bridge.start();
    expect(() => bridge.dispose()).not.toThrow();
    expect(bridge.state).toBe("stopped");
  });

  it("is safe to call multiple times", () => {
    bridge.dispose();
    bridge.dispose();
  });
});
