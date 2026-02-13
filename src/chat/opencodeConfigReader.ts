import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgentConfig } from "./types";

/**
 * Raw shape of an agent entry in `opencode.json` / `opencode.jsonc`.
 *
 * ```jsonc
 * {
 *   "agent": {
 *     "build": {
 *       "model": "anthropic/claude-sonnet-4-20250514",
 *       "description": "Default coding agent",
 *       "mode": "primary"
 *     }
 *   },
 *   "default_agent": "build"
 * }
 * ```
 */
interface RawAgentDef {
  model?: string;
  description?: string;
  mode?: "primary" | "subagent";
  [key: string]: unknown;
}

interface OpenCodeConfig {
  agent?: Record<string, RawAgentDef>;
  default_agent?: string;
  [key: string]: unknown;
}

/** Built-in agents that are always present if not overridden by config. */
const BUILTIN_AGENTS: Record<string, AgentConfig> = {
  build: {
    id: "build",
    name: "Build",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    description: "Default coding agent with all tools enabled",
    mode: "primary",
  },
  plan: {
    id: "plan",
    name: "Plan",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    description: "Planning agent with restricted tool access",
    mode: "primary",
  },
};

/**
 * Parse a `"provider/model"` string into separate provider and model
 * components. If there is no `/`, the whole string is treated as the model
 * and the provider defaults to `"unknown"`.
 */
function parseModelString(raw: string): { provider: string; model: string } {
  const idx = raw.indexOf("/");
  if (idx > 0) {
    return { provider: raw.substring(0, idx), model: raw.substring(idx + 1) };
  }
  return { provider: "unknown", model: raw };
}

/**
 * Convert a kebab-case or snake_case agent id into a display name.
 * e.g. "code-reviewer" → "Code Reviewer"
 */
function prettifyName(id: string): string {
  return id
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Strip JSONC comments (line comments `//` and block comments) so that
 * `JSON.parse` can handle the result. This is intentionally simple — it
 * does not handle comments inside string literals but is sufficient for
 * typical config files.
 */
function stripJsonComments(text: string): string {
  // Remove block comments
  let result = text.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove line comments (only outside of strings — approximation)
  result = result.replace(/(?<=^[^"]*(?:"[^"]*"[^"]*)*)\/\/.*$/gm, "");
  // Remove trailing commas before } or ]
  result = result.replace(/,\s*([}\]])/g, "$1");
  return result;
}

/**
 * Try to read and parse a single file as an OpenCode config.
 * Returns `undefined` if the file does not exist or cannot be parsed.
 */
function tryReadConfigFile(filePath: string): OpenCodeConfig | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const cleaned = stripJsonComments(raw);
    return JSON.parse(cleaned) as OpenCodeConfig;
  } catch {
    return undefined;
  }
}

/**
 * Resolve `~` at the start of a path to the user's home directory.
 */
function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Build the ordered list of directories to search for OpenCode config
 * files.
 *
 * Search order (first match wins):
 *  1. Explicit path from VS Code setting (`opencodeConfigPath`)
 *     — if it points to a file, that file is used directly;
 *     — if it points to a directory, that directory is searched.
 *  2. Workspace root (project-level config)
 *  3. `~/.config/opencode/` (global user config)
 */
export function resolveConfigSearchPaths(
  opencodeConfigPath: string,
  workspaceRoot: string | undefined
): string[] {
  const paths: string[] = [];

  if (opencodeConfigPath) {
    paths.push(expandHome(opencodeConfigPath));
  }

  if (workspaceRoot) {
    paths.push(workspaceRoot);
  }

  paths.push(path.join(os.homedir(), ".config", "opencode"));

  return paths;
}

/**
 * Read and parse an `opencode.json` or `opencode.jsonc` config file,
 * searching the given paths in order.  Returns `undefined` if no
 * config is found in any location.
 *
 * If a search path points directly to a file (has a `.json` or `.jsonc`
 * extension), that specific file is tried.  Otherwise the path is
 * treated as a directory and `opencode.jsonc` / `opencode.json` are
 * tried inside it.
 */
export function readOpenCodeConfig(
  searchPaths: string[]
): OpenCodeConfig | undefined {
  for (const searchPath of searchPaths) {
    // If the path looks like a direct file reference, try it as-is.
    if (searchPath.endsWith(".json") || searchPath.endsWith(".jsonc")) {
      const config = tryReadConfigFile(searchPath);
      if (config) {
        return config;
      }
      continue;
    }

    // Otherwise treat it as a directory — try opencode.jsonc then opencode.json.
    for (const filename of ["opencode.jsonc", "opencode.json"]) {
      const config = tryReadConfigFile(path.join(searchPath, filename));
      if (config) {
        return config;
      }
    }
  }
  return undefined;
}

/**
 * Scan the `.opencode/agents/` directory (and the singular `agent/`
 * variant) for markdown-based agent definitions.
 *
 * The filename (minus `.md`) becomes the agent id.  The first line
 * of the file is used as the description.
 */
export function readMarkdownAgents(workspaceRoot: string): AgentConfig[] {
  const agents: AgentConfig[] = [];
  const dirs = [
    path.join(workspaceRoot, ".opencode", "agents"),
    path.join(workspaceRoot, ".opencode", "agent"),
  ];

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      const id = entry.replace(/\.md$/, "");
      const filePath = path.join(dir, entry);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const firstLine = content.split("\n").find((l) => l.trim().length > 0);
        const description = firstLine
          ? firstLine.replace(/^#+\s*/, "").trim()
          : undefined;

        agents.push({
          id,
          name: prettifyName(id),
          provider: "configured",
          model: "from-prompt",
          description,
          mode: "primary",
        });
      } catch {
        // Skip unreadable files.
      }
    }
  }

  return agents;
}

/**
 * Load all agents from the OpenCode configuration.
 *
 * @param opencodeConfigPath  Explicit config file/directory path from
 *                            VS Code settings (may be empty).
 * @param workspaceRoot       The workspace root directory (may be undefined).
 *
 * Sources (in precedence order, later overrides earlier):
 *  1. Built-in agents (build, plan)
 *  2. `opencode.json` / `opencode.jsonc` agent definitions
 *  3. Markdown agents from `.opencode/agents/`
 *
 * Returns the list of agents and the configured default agent id.
 */
export function loadAgentsFromOpenCodeConfig(
  opencodeConfigPath: string,
  workspaceRoot: string | undefined
): {
  agents: AgentConfig[];
  defaultAgentId: string;
} {
  const agentMap = new Map<string, AgentConfig>();

  // 1. Start with built-in agents.
  for (const [id, agent] of Object.entries(BUILTIN_AGENTS)) {
    agentMap.set(id, agent);
  }

  let defaultAgentId = "build";

  // 2. Read JSON config from the resolved search paths.
  const searchPaths = resolveConfigSearchPaths(opencodeConfigPath, workspaceRoot);
  const config = readOpenCodeConfig(searchPaths);
  if (config) {
    if (config.agent) {
      for (const [id, raw] of Object.entries(config.agent)) {
        const { provider, model } = raw.model
          ? parseModelString(raw.model)
          : { provider: "unknown", model: "unknown" };

        agentMap.set(id, {
          id,
          name: prettifyName(id),
          provider,
          model,
          description: raw.description,
          mode: raw.mode ?? "primary",
        });
      }
    }
    if (config.default_agent) {
      defaultAgentId = config.default_agent;
    }
  }

  // 3. Read markdown-based agents from the workspace (override JSON definitions with same id).
  if (workspaceRoot) {
    for (const mdAgent of readMarkdownAgents(workspaceRoot)) {
      agentMap.set(mdAgent.id, mdAgent);
    }
  }

  return {
    agents: Array.from(agentMap.values()),
    defaultAgentId,
  };
}
