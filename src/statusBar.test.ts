import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetMocks, EventEmitter } from "./__mocks__/vscode";
import * as vscode from "./__mocks__/vscode";
import { StatusBarManager } from "./statusBar";
import { DevcontainerState } from "./devcontainerManager";

// Minimal mock of DevcontainerManager for StatusBarManager testing
function createMockDevcontainerManager(initialState: DevcontainerState = "not-found") {
  const stateEmitter = new EventEmitter<DevcontainerState>();
  return {
    state: initialState,
    onStateChanged: stateEmitter.event,
    _fireState(state: DevcontainerState) {
      stateEmitter.fire(state);
    },
    _dispose() {
      stateEmitter.dispose();
    },
  };
}

let statusBarItem: {
  text: string;
  tooltip: string;
  command: string | undefined;
  backgroundColor: unknown;
  show: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  __resetMocks();
  // Capture the created status bar item
  statusBarItem = {
    text: "",
    tooltip: "",
    command: undefined,
    backgroundColor: undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  } as any;
  vscode.window.createStatusBarItem.mockReturnValue(statusBarItem);
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("StatusBarManager constructor", () => {
  it("creates a status bar item", () => {
    const mgr = createMockDevcontainerManager();
    new StatusBarManager(mgr as any);

    expect(vscode.window.createStatusBarItem).toHaveBeenCalledOnce();
  });

  it("sets the command to showStatus", () => {
    const mgr = createMockDevcontainerManager();
    new StatusBarManager(mgr as any);

    expect(statusBarItem.command).toBe("opencode-devcontainer.showStatus");
  });

  it("updates the status bar with the initial state", () => {
    const mgr = createMockDevcontainerManager("not-found");
    new StatusBarManager(mgr as any);

    expect(statusBarItem.text).toContain("OpenCode DevContainer");
    expect(statusBarItem.show).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// State updates
// ---------------------------------------------------------------------------

describe("state updates", () => {
  it("shows running state", () => {
    const mgr = createMockDevcontainerManager("not-found");
    new StatusBarManager(mgr as any);

    mgr._fireState("running");

    expect(statusBarItem.text).toContain("$(vm-running)");
    expect(statusBarItem.tooltip).toContain("running");
  });

  it("shows starting state", () => {
    const mgr = createMockDevcontainerManager("not-found");
    new StatusBarManager(mgr as any);

    mgr._fireState("starting");

    expect(statusBarItem.text).toContain("$(loading~spin)");
    expect(statusBarItem.tooltip).toContain("starting");
  });

  it("shows stopped state", () => {
    const mgr = createMockDevcontainerManager("not-found");
    new StatusBarManager(mgr as any);

    mgr._fireState("stopped");

    expect(statusBarItem.text).toContain("$(vm-outline)");
    expect(statusBarItem.tooltip).toContain("stopped");
  });

  it("shows error state with error background", () => {
    const mgr = createMockDevcontainerManager("not-found");
    new StatusBarManager(mgr as any);

    mgr._fireState("error");

    expect(statusBarItem.text).toContain("$(error)");
    expect(statusBarItem.tooltip).toContain("error");
    expect(statusBarItem.backgroundColor).toBeDefined();
  });

  it("shows not-found state", () => {
    const mgr = createMockDevcontainerManager("running");
    new StatusBarManager(mgr as any);

    mgr._fireState("not-found");

    expect(statusBarItem.text).toContain("$(vm-outline)");
    expect(statusBarItem.tooltip).toContain("No dev container found");
  });

  it("calls show() on every update", () => {
    const mgr = createMockDevcontainerManager("not-found");
    new StatusBarManager(mgr as any);

    statusBarItem.show.mockClear();
    mgr._fireState("running");

    expect(statusBarItem.show).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe("dispose", () => {
  it("disposes the status bar item", () => {
    const mgr = createMockDevcontainerManager();
    const sbm = new StatusBarManager(mgr as any);

    sbm.dispose();

    expect(statusBarItem.dispose).toHaveBeenCalled();
  });
});
