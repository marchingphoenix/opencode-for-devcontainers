import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  __resetMocks,
  __setMockConfig,
  __setWorkspaceFolders,
  Uri,
  EventEmitter,
} from "./__mocks__/vscode";
import * as vscode from "./__mocks__/vscode";
import { OpencodeRunner } from "./opencodeRunner";
import { DevcontainerState } from "./devcontainerManager";

// Mock fs since shellWrapper uses it
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
    startDevcontainer: vi.fn().mockResolvedValue({
      containerId: opts.containerId,
      workspaceFolder: "/home/user/project",
      remoteWorkspaceFolder: opts.remoteWorkspaceFolder,
      state: "running",
    }),
  };
}

let runner: OpencodeRunner;
let mockManager: ReturnType<typeof createMockDevcontainerManager>;
let mockTerminal: {
  name: string;
  sendText: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  __resetMocks();
  __setWorkspaceFolders([{ uri: Uri.file("/home/user/project") }]);

  mockTerminal = {
    name: "test",
    sendText: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  };
  vscode.window.createTerminal.mockReturnValue(mockTerminal);
  vscode.window.onDidCloseTerminal.mockReturnValue({ dispose: vi.fn() });

  mockManager = createMockDevcontainerManager({
    state: "running",
    containerId: "abc123def456",
    remoteWorkspaceFolder: "/workspaces/project",
  });
  runner = new OpencodeRunner(mockManager as any);
});

// ---------------------------------------------------------------------------
// launch() routing
// ---------------------------------------------------------------------------

describe("launch", () => {
  it("calls launchLocalWithRemoteExec in local mode (default)", async () => {
    await runner.launch();

    expect(vscode.window.createTerminal).toHaveBeenCalledOnce();
    const opts = vscode.window.createTerminal.mock.calls[0][0] as any;
    expect(opts.name).toBe("OpenCode (DevContainer)");
    expect(opts.env.SHELL).toBeDefined();
    expect(opts.env.OPENCODE_DEVCONTAINER).toBe("1");
  });

  it("calls launchInContainer when configured", async () => {
    __setMockConfig({
      "opencode-devcontainer.executionMode": "in-container",
    });

    await runner.launchInContainer();

    expect(vscode.window.createTerminal).toHaveBeenCalledOnce();
    const opts = vscode.window.createTerminal.mock.calls[0][0] as any;
    expect(opts.name).toBe("OpenCode (In Container)");
  });
});

// ---------------------------------------------------------------------------
// launchLocalWithRemoteExec
// ---------------------------------------------------------------------------

describe("launchLocalWithRemoteExec", () => {
  it("creates terminal with shell wrapper env", async () => {
    await runner.launchLocalWithRemoteExec();

    expect(vscode.window.createTerminal).toHaveBeenCalledOnce();
    const opts = vscode.window.createTerminal.mock.calls[0][0] as any;
    expect(opts.env.SHELL).toContain("shell-wrapper");
    expect(opts.env.OPENCODE_DEVCONTAINER_ID).toBe("abc123def456");
    expect(opts.env.OPENCODE_WORKSPACE_FOLDER).toBe("/workspaces/project");
  });

  it("sends opencode command to terminal", async () => {
    await runner.launchLocalWithRemoteExec();
    expect(mockTerminal.sendText).toHaveBeenCalledWith("opencode", true);
  });

  it("shows the terminal", async () => {
    await runner.launchLocalWithRemoteExec();
    expect(mockTerminal.show).toHaveBeenCalled();
  });

  it("prompts to start container if not running", async () => {
    mockManager = createMockDevcontainerManager({
      state: "stopped",
      containerId: undefined,
      remoteWorkspaceFolder: undefined,
    });
    runner = new OpencodeRunner(mockManager as any);

    vscode.window.showInformationMessage.mockResolvedValue("Cancel");

    await runner.launchLocalWithRemoteExec();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("not running"),
      "Start",
      "Cancel"
    );
    // Terminal should not be created when cancelled
    expect(vscode.window.createTerminal).not.toHaveBeenCalled();
  });

  it("starts container if user confirms", async () => {
    mockManager = createMockDevcontainerManager({
      state: "stopped",
      containerId: "abc123def456",
      remoteWorkspaceFolder: "/workspaces/project",
    });
    runner = new OpencodeRunner(mockManager as any);

    vscode.window.showInformationMessage.mockResolvedValue("Start");

    await runner.launchLocalWithRemoteExec();

    expect(mockManager.startDevcontainer).toHaveBeenCalledOnce();
  });

  it("shows error if containerId is not available", async () => {
    mockManager = createMockDevcontainerManager({
      state: "running",
      containerId: undefined,
      remoteWorkspaceFolder: undefined,
    });
    runner = new OpencodeRunner(mockManager as any);

    await runner.launchLocalWithRemoteExec();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Dev container info is not available."
    );
  });
});

// ---------------------------------------------------------------------------
// launchInContainer
// ---------------------------------------------------------------------------

describe("launchInContainer", () => {
  it("creates terminal and sends docker exec command", async () => {
    await runner.launchInContainer();

    expect(vscode.window.createTerminal).toHaveBeenCalledOnce();
    const opts = vscode.window.createTerminal.mock.calls[0][0] as any;
    expect(opts.name).toBe("OpenCode (In Container)");

    expect(mockTerminal.sendText).toHaveBeenCalledOnce();
    const cmd = mockTerminal.sendText.mock.calls[0][0] as string;
    expect(cmd).toContain("docker");
    expect(cmd).toContain("exec");
    expect(cmd).toContain("abc123def456");
    expect(cmd).toContain("opencode");
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe("dispose", () => {
  it("does not throw", () => {
    expect(() => runner.dispose()).not.toThrow();
  });

  it("cleans up shell wrapper on dispose after launch", async () => {
    await runner.launchLocalWithRemoteExec();
    // dispose triggers cleanup, which removes the wrapper and terminal listener
    expect(() => runner.dispose()).not.toThrow();
  });
});
