import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  __resetMocks,
  __setMockConfig,
  __setWorkspaceFolders,
  Uri,
} from "./__mocks__/vscode";
import * as vscode from "./__mocks__/vscode";
import { DevcontainerManager } from "./devcontainerManager";

// Mock both fs and child_process at module level so properties are configurable
vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    statSync: vi.fn(() => ({ mode: 0o755 })),
  };
});

vi.mock("child_process", async () => {
  const actual = await vi.importActual("child_process");
  return {
    ...actual,
    exec: vi.fn(),
    spawn: vi.fn(),
  };
});

// Import after mocking
import * as fs from "fs";
import { exec } from "child_process";

const mockExistsSync = fs.existsSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = fs.readFileSync as ReturnType<typeof vi.fn>;
const mockExec = exec as unknown as ReturnType<typeof vi.fn>;

let manager: DevcontainerManager;

beforeEach(() => {
  __resetMocks();
  __setWorkspaceFolders([{ uri: Uri.file("/home/user/project") }]);
  manager = new DevcontainerManager();
  mockExistsSync.mockReset().mockReturnValue(false);
  mockReadFileSync.mockReset().mockReturnValue("");
});

// ---------------------------------------------------------------------------
// state / containerId / remoteWorkspaceFolder
// ---------------------------------------------------------------------------

describe("initial state", () => {
  it("starts with not-found state", () => {
    expect(manager.state).toBe("not-found");
  });

  it("has no containerId", () => {
    expect(manager.containerId).toBeUndefined();
  });

  it("has no remoteWorkspaceFolder", () => {
    expect(manager.remoteWorkspaceFolder).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detectDevcontainerConfig
// ---------------------------------------------------------------------------

describe("detectDevcontainerConfig", () => {
  it("returns undefined when no workspace folder", async () => {
    __setWorkspaceFolders(undefined);
    const result = await manager.detectDevcontainerConfig();
    expect(result).toBeUndefined();
  });

  it("checks custom devcontainer path from config", async () => {
    __setMockConfig({
      "opencode-devcontainer.devcontainerPath": "custom/.devcontainer",
    });

    mockExistsSync.mockImplementation((p: unknown) => {
      return String(p) === "/home/user/project/custom/.devcontainer/devcontainer.json";
    });

    const result = await manager.detectDevcontainerConfig();
    expect(result).toBe("/home/user/project/custom/.devcontainer");
  });

  it("detects .devcontainer/devcontainer.json", async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      return String(p) === "/home/user/project/.devcontainer/devcontainer.json";
    });

    const result = await manager.detectDevcontainerConfig();
    expect(result).toBe("/home/user/project/.devcontainer");
  });

  it("detects root-level devcontainer.json", async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      return String(p) === "/home/user/project/devcontainer.json";
    });

    const result = await manager.detectDevcontainerConfig();
    expect(result).toBe("/home/user/project");
  });

  it("returns undefined when no config file found", async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await manager.detectDevcontainerConfig();
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseWorkspaceFolder
// ---------------------------------------------------------------------------

describe("parseWorkspaceFolder", () => {
  it("returns config value if set", async () => {
    __setMockConfig({
      "opencode-devcontainer.containerWorkspaceFolder": "/custom/workspace",
    });

    const result = await manager.parseWorkspaceFolder();
    expect(result).toBe("/custom/workspace");
  });

  it("returns /workspaces/project when no config and no workspace folder", async () => {
    __setWorkspaceFolders(undefined);
    const result = await manager.parseWorkspaceFolder();
    expect(result).toBe("/workspaces/project");
  });

  it("returns /workspaces/<basename> when no devcontainer config found", async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await manager.parseWorkspaceFolder();
    expect(result).toBe("/workspaces/project");
  });

  it("parses workspaceFolder from devcontainer.json", async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      return String(p) === "/home/user/project/.devcontainer/devcontainer.json";
    });

    mockReadFileSync.mockImplementation(() => {
      return '{ "workspaceFolder": "/workspace/custom" }';
    });

    const result = await manager.parseWorkspaceFolder();
    expect(result).toBe("/workspace/custom");
  });

  it("handles JSON with comments in devcontainer.json", async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      return String(p) === "/home/user/project/.devcontainer/devcontainer.json";
    });

    mockReadFileSync.mockImplementation(() => {
      return `{
        // This is a comment
        "workspaceFolder": "/workspace/commented",
        /* block comment */
        "image": "node:18"
      }`;
    });

    const result = await manager.parseWorkspaceFolder();
    expect(result).toBe("/workspace/commented");
  });
});

// ---------------------------------------------------------------------------
// onStateChanged events
// ---------------------------------------------------------------------------

describe("onStateChanged", () => {
  it("fires when state changes via refreshStatus", async () => {
    const listener = vi.fn();
    manager.onStateChanged(listener);

    __setWorkspaceFolders(undefined);
    await manager.refreshStatus();

    expect(listener).toHaveBeenCalledWith("not-found");
  });
});

// ---------------------------------------------------------------------------
// execInContainer
// ---------------------------------------------------------------------------

describe("execInContainer", () => {
  it("throws when no container is running", async () => {
    await expect(manager.execInContainer("ls")).rejects.toThrow(
      "No dev container is running."
    );
  });
});

// ---------------------------------------------------------------------------
// stopDevcontainer
// ---------------------------------------------------------------------------

describe("stopDevcontainer", () => {
  it("shows warning when no container is tracked", async () => {
    await manager.stopDevcontainer();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      "No dev container is currently tracked."
    );
  });
});

// ---------------------------------------------------------------------------
// startDevcontainer – PATH augmentation
// ---------------------------------------------------------------------------

describe("startDevcontainer PATH handling", () => {
  beforeEach(() => {
    mockExistsSync.mockImplementation((p: unknown) => {
      return String(p) === "/home/user/project/.devcontainer/devcontainer.json";
    });
  });

  it("prepends bin directory to PATH when devcontainerCliPath is absolute", async () => {
    __setMockConfig({
      "opencode-devcontainer.devcontainerCliPath": "/usr/local/nvm/versions/node/v20/bin/devcontainer",
    });

    // Make exec call succeed with a container ID
    mockExec.mockImplementation(
      (
        cmd: string,
        opts: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (cmd.includes("devcontainer up")) {
          // Verify that the env.PATH starts with the binary's directory
          const env = opts.env as Record<string, string>;
          expect(env).toBeDefined();
          expect(env.PATH).toMatch(/^\/usr\/local\/nvm\/versions\/node\/v20\/bin/);
          cb(null, JSON.stringify({ containerId: "abc123" }), "");
        } else {
          cb(null, "", "");
        }
      }
    );

    await manager.startDevcontainer();
    expect(mockExec).toHaveBeenCalled();
  });

  it("does not modify PATH when devcontainerCliPath is a bare command", async () => {
    __setMockConfig({
      "opencode-devcontainer.devcontainerCliPath": "devcontainer",
    });

    const originalPath = process.env.PATH;

    mockExec.mockImplementation(
      (
        cmd: string,
        opts: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (cmd.includes("devcontainer up")) {
          const env = opts.env as Record<string, string>;
          expect(env.PATH).toBe(originalPath);
          cb(null, JSON.stringify({ containerId: "abc123" }), "");
        } else {
          cb(null, "", "");
        }
      }
    );

    await manager.startDevcontainer();
    expect(mockExec).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe("dispose", () => {
  it("does not throw", () => {
    expect(() => manager.dispose()).not.toThrow();
  });
});
