import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetMocks, __setMockConfig } from "../__mocks__/vscode";

// Mock the config module to control getWorkspaceFolder.
vi.mock("../config", () => ({
  getWorkspaceFolder: vi.fn(() => "/fake/workspace"),
  getConfig: vi.fn(() => ({})),
}));

// Mock the opencodeConfigReader module.
vi.mock("./opencodeConfigReader", () => ({
  loadAgentsFromOpenCodeConfig: vi.fn(
    (_configPath: string, _workspaceRoot: string | undefined) => ({
      agents: [
        {
          id: "build",
          name: "Build",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          description: "Default coding agent with all tools enabled",
          mode: "primary",
        },
        {
          id: "plan",
          name: "Plan",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          description: "Planning agent with restricted tool access",
          mode: "primary",
        },
      ],
      defaultAgentId: "build",
    })
  ),
}));

import { AgentRegistry } from "./agentRegistry";
import { getWorkspaceFolder } from "../config";
import { loadAgentsFromOpenCodeConfig } from "./opencodeConfigReader";

const mockGetWorkspaceFolder = vi.mocked(getWorkspaceFolder);
const mockLoadAgents = vi.mocked(loadAgentsFromOpenCodeConfig);

let registry: AgentRegistry;

beforeEach(() => {
  __resetMocks();
  vi.clearAllMocks();

  // Reset to default mock return values.
  mockGetWorkspaceFolder.mockReturnValue("/fake/workspace");
  mockLoadAgents.mockReturnValue({
    agents: [
      {
        id: "build",
        name: "Build",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        description: "Default coding agent with all tools enabled",
        mode: "primary",
      },
      {
        id: "plan",
        name: "Plan",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        description: "Planning agent with restricted tool access",
        mode: "primary",
      },
    ],
    defaultAgentId: "build",
  });

  registry = new AgentRegistry();
});

// ---------------------------------------------------------------------------
// Default behavior (built-in agents)
// ---------------------------------------------------------------------------

describe("default configuration", () => {
  it("loads built-in agents when opencode config has defaults", () => {
    const agents = registry.listAgents();
    expect(agents).toHaveLength(2);
    expect(agents[0].id).toBe("build");
    expect(agents[1].id).toBe("plan");
  });

  it("returns the default agent ID as build", () => {
    expect(registry.defaultAgentId).toBe("build");
  });

  it("getDefaultAgent returns the build agent", () => {
    const agent = registry.getDefaultAgent();
    expect(agent.id).toBe("build");
    expect(agent.name).toBe("Build");
  });
});

// ---------------------------------------------------------------------------
// Custom configuration from opencode.json
// ---------------------------------------------------------------------------

describe("custom configuration", () => {
  it("loads agents from opencode config", () => {
    mockLoadAgents.mockReturnValue({
      agents: [
        { id: "build", name: "Build", provider: "anthropic", model: "claude-sonnet-4-20250514", mode: "primary" },
        { id: "plan", name: "Plan", provider: "anthropic", model: "claude-sonnet-4-20250514", mode: "primary" },
        { id: "code-reviewer", name: "Code Reviewer", provider: "anthropic", model: "claude-sonnet-4-20250514", description: "Reviews code", mode: "subagent" },
      ],
      defaultAgentId: "build",
    });

    registry.loadFromConfig();

    expect(registry.listAgents()).toHaveLength(3);
    expect(registry.defaultAgentId).toBe("build");
    expect(registry.getAgent("code-reviewer")?.description).toBe("Reviews code");
  });

  it("respects default_agent from opencode config", () => {
    mockLoadAgents.mockReturnValue({
      agents: [
        { id: "build", name: "Build", provider: "anthropic", model: "claude-sonnet-4-20250514", mode: "primary" },
        { id: "plan", name: "Plan", provider: "anthropic", model: "claude-sonnet-4-20250514", mode: "primary" },
      ],
      defaultAgentId: "plan",
    });

    registry.loadFromConfig();

    expect(registry.defaultAgentId).toBe("plan");
  });

  it("falls back to first agent if default ID is invalid", () => {
    mockLoadAgents.mockReturnValue({
      agents: [
        { id: "build", name: "Build", provider: "openai", model: "gpt-4", mode: "primary" },
      ],
      defaultAgentId: "nonexistent",
    });

    registry.loadFromConfig();

    expect(registry.defaultAgentId).toBe("build");
  });
});

// ---------------------------------------------------------------------------
// opencodeConfigPath setting
// ---------------------------------------------------------------------------

describe("opencodeConfigPath setting", () => {
  it("passes opencodeConfigPath from VS Code settings to the config reader", () => {
    __setMockConfig({
      "opencode-devcontainer.opencodeConfigPath": "/my/custom/opencode.json",
    });
    mockLoadAgents.mockClear();

    registry.loadFromConfig();

    expect(mockLoadAgents).toHaveBeenCalledWith(
      "/my/custom/opencode.json",
      "/fake/workspace"
    );
  });

  it("passes empty string when no opencodeConfigPath is set", () => {
    mockLoadAgents.mockClear();

    registry.loadFromConfig();

    expect(mockLoadAgents).toHaveBeenCalledWith("", "/fake/workspace");
  });
});

// ---------------------------------------------------------------------------
// No workspace fallback
// ---------------------------------------------------------------------------

describe("no workspace fallback", () => {
  it("still loads agents when no workspace is open (global config)", () => {
    mockGetWorkspaceFolder.mockReturnValue(undefined);

    registry.loadFromConfig();

    // loadAgentsFromOpenCodeConfig should still be called (it searches ~/.config/opencode/)
    expect(mockLoadAgents).toHaveBeenCalledWith("", undefined);
  });
});

// ---------------------------------------------------------------------------
// getAgent
// ---------------------------------------------------------------------------

describe("getAgent", () => {
  it("returns the agent by ID", () => {
    const agent = registry.getAgent("build");
    expect(agent).toBeDefined();
    expect(agent!.id).toBe("build");
  });

  it("returns undefined for unknown ID", () => {
    expect(registry.getAgent("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getDefaultAgent fallback
// ---------------------------------------------------------------------------

describe("getDefaultAgent fallback", () => {
  it("returns a hardcoded default when no agents are loaded", () => {
    mockLoadAgents.mockReturnValue({
      agents: [],
      defaultAgentId: "build",
    });
    registry.loadFromConfig();

    const agent = registry.getDefaultAgent();
    expect(agent.id).toBe("build");
    expect(agent.provider).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// setDefaultAgent
// ---------------------------------------------------------------------------

describe("setDefaultAgent", () => {
  it("switches the default agent", () => {
    registry.setDefaultAgent("plan");
    expect(registry.defaultAgentId).toBe("plan");
  });

  it("throws for an unknown agent ID", () => {
    expect(() => registry.setDefaultAgent("nonexistent")).toThrow(
      'Agent "nonexistent" is not configured.'
    );
  });

  it("fires onAgentsChanged event", () => {
    const listener = vi.fn();
    registry.onAgentsChanged(listener);

    registry.setDefaultAgent("plan");

    expect(listener).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// loadFromConfig fires event
// ---------------------------------------------------------------------------

describe("loadFromConfig", () => {
  it("fires onAgentsChanged event", () => {
    const listener = vi.fn();
    registry.onAgentsChanged(listener);

    registry.loadFromConfig();

    expect(listener).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe("dispose", () => {
  it("does not throw", () => {
    expect(() => registry.dispose()).not.toThrow();
  });
});
