import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readOpenCodeConfig,
  readMarkdownAgents,
  loadAgentsFromOpenCodeConfig,
  resolveConfigSearchPaths,
} from "./opencodeConfigReader";

vi.mock("fs");
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: vi.fn(() => "/home/testuser") };
});

const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockHomedir = vi.mocked(os.homedir);

const WORKSPACE = "/fake/workspace";

beforeEach(() => {
  vi.clearAllMocks();
  mockHomedir.mockReturnValue("/home/testuser");
  // By default, all file reads throw ENOENT.
  mockReadFileSync.mockImplementation(() => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
  mockReaddirSync.mockImplementation(() => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
});

// ---------------------------------------------------------------------------
// resolveConfigSearchPaths
// ---------------------------------------------------------------------------

describe("resolveConfigSearchPaths", () => {
  it("includes only global config when no custom path or workspace", () => {
    const paths = resolveConfigSearchPaths("", undefined);
    expect(paths).toEqual(["/home/testuser/.config/opencode"]);
  });

  it("includes workspace root before global config", () => {
    const paths = resolveConfigSearchPaths("", WORKSPACE);
    expect(paths).toEqual([
      WORKSPACE,
      "/home/testuser/.config/opencode",
    ]);
  });

  it("includes custom path first", () => {
    const paths = resolveConfigSearchPaths("/custom/path", WORKSPACE);
    expect(paths).toEqual([
      "/custom/path",
      WORKSPACE,
      "/home/testuser/.config/opencode",
    ]);
  });

  it("expands ~ in custom path", () => {
    const paths = resolveConfigSearchPaths("~/my-config", WORKSPACE);
    expect(paths).toEqual([
      "/home/testuser/my-config",
      WORKSPACE,
      "/home/testuser/.config/opencode",
    ]);
  });

  it("handles direct file path with ~ expansion", () => {
    const paths = resolveConfigSearchPaths("~/opencode.json", undefined);
    expect(paths).toEqual([
      "/home/testuser/opencode.json",
      "/home/testuser/.config/opencode",
    ]);
  });
});

// ---------------------------------------------------------------------------
// readOpenCodeConfig
// ---------------------------------------------------------------------------

describe("readOpenCodeConfig", () => {
  it("returns undefined when no config file exists", () => {
    expect(readOpenCodeConfig([WORKSPACE])).toBeUndefined();
  });

  it("reads opencode.jsonc first in a directory", () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath) === path.join(WORKSPACE, "opencode.jsonc")) {
        return '{ "default_agent": "plan" }';
      }
      throw new Error("ENOENT");
    });

    const config = readOpenCodeConfig([WORKSPACE]);
    expect(config).toBeDefined();
    expect(config!.default_agent).toBe("plan");
  });

  it("falls back to opencode.json in a directory", () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath) === path.join(WORKSPACE, "opencode.json")) {
        return '{ "default_agent": "build" }';
      }
      throw new Error("ENOENT");
    });

    const config = readOpenCodeConfig([WORKSPACE]);
    expect(config).toBeDefined();
    expect(config!.default_agent).toBe("build");
  });

  it("reads a direct file path", () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath) === "/custom/opencode.json") {
        return '{ "default_agent": "plan" }';
      }
      throw new Error("ENOENT");
    });

    const config = readOpenCodeConfig(["/custom/opencode.json"]);
    expect(config).toBeDefined();
    expect(config!.default_agent).toBe("plan");
  });

  it("searches paths in order and returns first match", () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath) === "/first/opencode.json") {
        return '{ "default_agent": "from-first" }';
      }
      if (String(filePath) === "/second/opencode.json") {
        return '{ "default_agent": "from-second" }';
      }
      throw new Error("ENOENT");
    });

    const config = readOpenCodeConfig(["/first", "/second"]);
    expect(config).toBeDefined();
    expect(config!.default_agent).toBe("from-first");
  });

  it("falls back to second path when first has no config", () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath) === "/second/opencode.json") {
        return '{ "default_agent": "from-second" }';
      }
      throw new Error("ENOENT");
    });

    const config = readOpenCodeConfig(["/first", "/second"]);
    expect(config).toBeDefined();
    expect(config!.default_agent).toBe("from-second");
  });

  it("strips JSONC comments", () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath) === path.join(WORKSPACE, "opencode.jsonc")) {
        return `{
          // This is a comment
          "default_agent": "plan",
          "agent": {
            /* block comment */
            "build": {
              "model": "anthropic/claude-sonnet-4-20250514",
            }
          }
        }`;
      }
      throw new Error("ENOENT");
    });

    const config = readOpenCodeConfig([WORKSPACE]);
    expect(config).toBeDefined();
    expect(config!.default_agent).toBe("plan");
    expect(config!.agent).toBeDefined();
    expect(config!.agent!.build.model).toBe("anthropic/claude-sonnet-4-20250514");
  });

  it("parses agent definitions with provider/model format", () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath) === path.join(WORKSPACE, "opencode.json")) {
        return JSON.stringify({
          agent: {
            "code-reviewer": {
              model: "openai/gpt-4",
              description: "Reviews code",
              mode: "subagent",
            },
          },
        });
      }
      throw new Error("ENOENT");
    });

    const config = readOpenCodeConfig([WORKSPACE]);
    expect(config).toBeDefined();
    expect(config!.agent!["code-reviewer"].model).toBe("openai/gpt-4");
    expect(config!.agent!["code-reviewer"].description).toBe("Reviews code");
  });
});

// ---------------------------------------------------------------------------
// readMarkdownAgents
// ---------------------------------------------------------------------------

describe("readMarkdownAgents", () => {
  it("returns empty array when no agent directories exist", () => {
    expect(readMarkdownAgents(WORKSPACE)).toEqual([]);
  });

  it("reads markdown agents from .opencode/agents/", () => {
    mockReaddirSync.mockImplementation((dirPath) => {
      if (String(dirPath) === path.join(WORKSPACE, ".opencode", "agents")) {
        return ["review.md", "deploy.md"] as unknown as fs.Dirent[];
      }
      throw new Error("ENOENT");
    });

    mockReadFileSync.mockImplementation((filePath) => {
      const p = String(filePath);
      if (p.endsWith("review.md")) {
        return "# Code Review Agent\nReviews code for best practices.";
      }
      if (p.endsWith("deploy.md")) {
        return "Deploy helper\nHelps with deployment tasks.";
      }
      throw new Error("ENOENT");
    });

    const agents = readMarkdownAgents(WORKSPACE);
    expect(agents).toHaveLength(2);
    expect(agents[0].id).toBe("review");
    expect(agents[0].name).toBe("Review");
    expect(agents[0].description).toBe("Code Review Agent");
    expect(agents[1].id).toBe("deploy");
    expect(agents[1].name).toBe("Deploy");
    expect(agents[1].description).toBe("Deploy helper");
  });

  it("skips non-markdown files", () => {
    mockReaddirSync.mockImplementation((dirPath) => {
      if (String(dirPath) === path.join(WORKSPACE, ".opencode", "agents")) {
        return ["review.md", "readme.txt"] as unknown as fs.Dirent[];
      }
      throw new Error("ENOENT");
    });

    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath).endsWith("review.md")) {
        return "Review agent";
      }
      throw new Error("ENOENT");
    });

    const agents = readMarkdownAgents(WORKSPACE);
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// loadAgentsFromOpenCodeConfig
// ---------------------------------------------------------------------------

describe("loadAgentsFromOpenCodeConfig", () => {
  it("returns built-in agents when no config exists", () => {
    const { agents, defaultAgentId } = loadAgentsFromOpenCodeConfig("", WORKSPACE);
    expect(defaultAgentId).toBe("build");
    expect(agents.length).toBeGreaterThanOrEqual(2);
    expect(agents.find((a) => a.id === "build")).toBeDefined();
    expect(agents.find((a) => a.id === "plan")).toBeDefined();
  });

  it("merges JSON config agents with built-ins", () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath) === path.join(WORKSPACE, "opencode.json")) {
        return JSON.stringify({
          agent: {
            "code-reviewer": {
              model: "anthropic/claude-sonnet-4-20250514",
              description: "Reviews code",
              mode: "subagent",
            },
          },
          default_agent: "build",
        });
      }
      throw new Error("ENOENT");
    });

    const { agents, defaultAgentId } = loadAgentsFromOpenCodeConfig("", WORKSPACE);
    expect(defaultAgentId).toBe("build");
    expect(agents.find((a) => a.id === "build")).toBeDefined();
    expect(agents.find((a) => a.id === "plan")).toBeDefined();
    expect(agents.find((a) => a.id === "code-reviewer")).toBeDefined();
    expect(agents.find((a) => a.id === "code-reviewer")!.provider).toBe("anthropic");
    expect(agents.find((a) => a.id === "code-reviewer")!.model).toBe("claude-sonnet-4-20250514");
  });

  it("overrides built-in agent with custom config", () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath) === path.join(WORKSPACE, "opencode.json")) {
        return JSON.stringify({
          agent: {
            build: {
              model: "openai/gpt-4",
              description: "Custom build agent",
            },
          },
        });
      }
      throw new Error("ENOENT");
    });

    const { agents } = loadAgentsFromOpenCodeConfig("", WORKSPACE);
    const build = agents.find((a) => a.id === "build");
    expect(build).toBeDefined();
    expect(build!.provider).toBe("openai");
    expect(build!.model).toBe("gpt-4");
    expect(build!.description).toBe("Custom build agent");
  });

  it("parses model string without provider prefix", () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath) === path.join(WORKSPACE, "opencode.json")) {
        return JSON.stringify({
          agent: {
            "local-agent": {
              model: "llama-3",
              description: "Local model",
            },
          },
        });
      }
      throw new Error("ENOENT");
    });

    const { agents } = loadAgentsFromOpenCodeConfig("", WORKSPACE);
    const localAgent = agents.find((a) => a.id === "local-agent");
    expect(localAgent).toBeDefined();
    expect(localAgent!.provider).toBe("unknown");
    expect(localAgent!.model).toBe("llama-3");
  });

  it("respects default_agent from config", () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath) === path.join(WORKSPACE, "opencode.json")) {
        return JSON.stringify({
          default_agent: "plan",
        });
      }
      throw new Error("ENOENT");
    });

    const { defaultAgentId } = loadAgentsFromOpenCodeConfig("", WORKSPACE);
    expect(defaultAgentId).toBe("plan");
  });

  it("reads from custom config path first", () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath) === "/custom/opencode.json") {
        return JSON.stringify({
          agent: {
            "custom-agent": {
              model: "openai/o1",
              description: "Custom agent from explicit path",
            },
          },
          default_agent: "custom-agent",
        });
      }
      throw new Error("ENOENT");
    });

    const { agents, defaultAgentId } = loadAgentsFromOpenCodeConfig(
      "/custom/opencode.json",
      WORKSPACE
    );
    expect(defaultAgentId).toBe("custom-agent");
    expect(agents.find((a) => a.id === "custom-agent")).toBeDefined();
  });

  it("falls back to ~/.config/opencode/ when no workspace or custom path", () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (
        String(filePath) ===
        path.join("/home/testuser", ".config", "opencode", "opencode.json")
      ) {
        return JSON.stringify({
          agent: {
            "global-agent": {
              model: "anthropic/claude-sonnet-4-20250514",
              description: "Global user agent",
            },
          },
        });
      }
      throw new Error("ENOENT");
    });

    const { agents } = loadAgentsFromOpenCodeConfig("", undefined);
    expect(agents.find((a) => a.id === "global-agent")).toBeDefined();
    expect(agents.find((a) => a.id === "global-agent")!.description).toBe(
      "Global user agent"
    );
  });
});
