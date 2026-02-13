import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetMocks, __setMockConfig } from "../__mocks__/vscode";
import { AgentRegistry } from "./agentRegistry";

let registry: AgentRegistry;

beforeEach(() => {
  __resetMocks();
  registry = new AgentRegistry();
});

// ---------------------------------------------------------------------------
// Default behavior
// ---------------------------------------------------------------------------

describe("default configuration", () => {
  it("loads the default agent when no config is set", () => {
    const agents = registry.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("default");
    expect(agents[0].name).toBe("Default Agent");
    expect(agents[0].provider).toBe("anthropic");
  });

  it("returns the default agent ID", () => {
    expect(registry.defaultAgentId).toBe("default");
  });

  it("getDefaultAgent returns the default agent", () => {
    const agent = registry.getDefaultAgent();
    expect(agent.id).toBe("default");
    expect(agent.name).toBe("Default Agent");
  });
});

// ---------------------------------------------------------------------------
// Custom configuration
// ---------------------------------------------------------------------------

describe("custom configuration", () => {
  it("loads agents from config", () => {
    __setMockConfig({
      "opencode-devcontainer.agents": [
        { id: "gpt4", name: "GPT-4", provider: "openai", model: "gpt-4" },
        { id: "claude", name: "Claude", provider: "anthropic", model: "claude-3" },
      ],
      "opencode-devcontainer.defaultAgent": "claude",
    });

    registry.loadFromConfig();

    expect(registry.listAgents()).toHaveLength(2);
    expect(registry.defaultAgentId).toBe("claude");
  });

  it("falls back to first agent if default ID is invalid", () => {
    __setMockConfig({
      "opencode-devcontainer.agents": [
        { id: "gpt4", name: "GPT-4", provider: "openai", model: "gpt-4" },
      ],
      "opencode-devcontainer.defaultAgent": "nonexistent",
    });

    registry.loadFromConfig();

    expect(registry.defaultAgentId).toBe("gpt4");
  });
});

// ---------------------------------------------------------------------------
// getAgent
// ---------------------------------------------------------------------------

describe("getAgent", () => {
  it("returns the agent by ID", () => {
    const agent = registry.getAgent("default");
    expect(agent).toBeDefined();
    expect(agent!.id).toBe("default");
  });

  it("returns undefined for unknown ID", () => {
    expect(registry.getAgent("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getDefaultAgent fallback
// ---------------------------------------------------------------------------

describe("getDefaultAgent fallback", () => {
  it("returns a hardcoded default when no agents are configured", () => {
    // Clear agents by loading empty config
    __setMockConfig({
      "opencode-devcontainer.agents": [],
    });
    registry.loadFromConfig();

    const agent = registry.getDefaultAgent();
    expect(agent.id).toBe("default");
    expect(agent.provider).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// setDefaultAgent
// ---------------------------------------------------------------------------

describe("setDefaultAgent", () => {
  beforeEach(() => {
    __setMockConfig({
      "opencode-devcontainer.agents": [
        { id: "a", name: "Agent A", provider: "openai", model: "gpt-4" },
        { id: "b", name: "Agent B", provider: "anthropic", model: "claude-3" },
      ],
    });
    registry.loadFromConfig();
  });

  it("switches the default agent", () => {
    registry.setDefaultAgent("b");
    expect(registry.defaultAgentId).toBe("b");
  });

  it("throws for an unknown agent ID", () => {
    expect(() => registry.setDefaultAgent("nonexistent")).toThrow(
      'Agent "nonexistent" is not configured.'
    );
  });

  it("fires onAgentsChanged event", () => {
    const listener = vi.fn();
    registry.onAgentsChanged(listener);

    registry.setDefaultAgent("b");

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
