import { describe, it, expect, beforeEach } from "vitest";
import { __resetMocks, __setMockConfig, __setWorkspaceFolders, Uri } from "./__mocks__/vscode";
import { getConfig, getWorkspaceFolder } from "./config";

beforeEach(() => {
  __resetMocks();
});

// ---------------------------------------------------------------------------
// getConfig()
// ---------------------------------------------------------------------------

describe("getConfig", () => {
  it("returns defaults when no settings are configured", () => {
    const cfg = getConfig();
    expect(cfg.opencodePath).toBe("opencode");
    expect(cfg.devcontainerPath).toBe("");
    expect(cfg.dockerPath).toBe("docker");
    expect(cfg.devcontainerCliPath).toBe("devcontainer");
    expect(cfg.executionMode).toBe("local-with-remote-exec");
    expect(cfg.containerWorkspaceFolder).toBe("");
    expect(cfg.additionalEnvVars).toEqual({});
    expect(cfg.forwardEnvVars).toEqual([
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENCODE_*",
    ]);
  });

  it("reads overridden settings", () => {
    __setMockConfig({
      "opencode-devcontainer.opencodePath": "/usr/local/bin/opencode",
      "opencode-devcontainer.dockerPath": "/usr/bin/docker",
      "opencode-devcontainer.executionMode": "in-container",
      "opencode-devcontainer.additionalEnvVars": { FOO: "bar" },
    });

    const cfg = getConfig();
    expect(cfg.opencodePath).toBe("/usr/local/bin/opencode");
    expect(cfg.dockerPath).toBe("/usr/bin/docker");
    expect(cfg.executionMode).toBe("in-container");
    expect(cfg.additionalEnvVars).toEqual({ FOO: "bar" });
  });
});

// ---------------------------------------------------------------------------
// getWorkspaceFolder()
// ---------------------------------------------------------------------------

describe("getWorkspaceFolder", () => {
  it("returns undefined when no workspace folders exist", () => {
    __setWorkspaceFolders(undefined);
    expect(getWorkspaceFolder()).toBeUndefined();
  });

  it("returns undefined when workspace folders array is empty", () => {
    __setWorkspaceFolders([]);
    expect(getWorkspaceFolder()).toBeUndefined();
  });

  it("returns the fsPath of the first workspace folder", () => {
    __setWorkspaceFolders([{ uri: Uri.file("/home/user/project") }]);
    expect(getWorkspaceFolder()).toBe("/home/user/project");
  });

  it("returns the first folder when multiple are present", () => {
    __setWorkspaceFolders([
      { uri: Uri.file("/home/user/first") },
      { uri: Uri.file("/home/user/second") },
    ]);
    expect(getWorkspaceFolder()).toBe("/home/user/first");
  });
});
