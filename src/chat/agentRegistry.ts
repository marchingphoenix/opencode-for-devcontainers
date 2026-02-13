import * as vscode from "vscode";
import { AgentConfig } from "./types";
import { getWorkspaceFolder } from "../config";
import { loadAgentsFromOpenCodeConfig } from "./opencodeConfigReader";

/**
 * Manages the set of configured OpenCode agents.
 *
 * Reads agent definitions from the workspace's OpenCode configuration
 * files (`opencode.json` / `opencode.jsonc` and `.opencode/agents/`
 * markdown files), matching the same sources that the OpenCode CLI
 * itself uses.
 *
 * Falls back to built-in defaults (build + plan) when no config is found.
 */
export class AgentRegistry implements vscode.Disposable {
  private agents = new Map<string, AgentConfig>();
  private _defaultAgentId = "build";

  private readonly _onAgentsChanged = new vscode.EventEmitter<void>();
  public readonly onAgentsChanged = this._onAgentsChanged.event;

  private fileWatcher: vscode.FileSystemWatcher | undefined;

  constructor() {
    this.loadFromConfig();

    // Watch for changes to opencode config files in the workspace.
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      "**/opencode.{json,jsonc}"
    );
    this.fileWatcher.onDidChange(() => this.loadFromConfig());
    this.fileWatcher.onDidCreate(() => this.loadFromConfig());
    this.fileWatcher.onDidDelete(() => this.loadFromConfig());
  }

  /** Reload agents from the workspace's OpenCode configuration files. */
  loadFromConfig(): void {
    const workspaceRoot = getWorkspaceFolder();

    if (!workspaceRoot) {
      // No workspace — use built-in defaults.
      this.agents.clear();
      this.agents.set("build", {
        id: "build",
        name: "Build",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        description: "Default coding agent with all tools enabled",
        mode: "primary",
      });
      this.agents.set("plan", {
        id: "plan",
        name: "Plan",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        description: "Planning agent with restricted tool access",
        mode: "primary",
      });
      this._defaultAgentId = "build";
      this._onAgentsChanged.fire();
      return;
    }

    const { agents, defaultAgentId } =
      loadAgentsFromOpenCodeConfig(workspaceRoot);

    this.agents.clear();
    for (const agent of agents) {
      this.agents.set(agent.id, agent);
    }

    this._defaultAgentId = defaultAgentId;

    // Ensure the configured default exists; fall back to the first entry.
    if (!this.agents.has(this._defaultAgentId) && this.agents.size > 0) {
      this._defaultAgentId = this.agents.keys().next().value!;
    }

    this._onAgentsChanged.fire();
  }

  getAgent(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  getDefaultAgent(): AgentConfig {
    return (
      this.agents.get(this._defaultAgentId) ?? {
        id: "build",
        name: "Build",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        description: "Default coding agent with all tools enabled",
        mode: "primary" as const,
      }
    );
  }

  listAgents(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  setDefaultAgent(id: string): void {
    if (!this.agents.has(id)) {
      throw new Error(`Agent "${id}" is not configured.`);
    }
    this._defaultAgentId = id;
    this._onAgentsChanged.fire();
  }

  get defaultAgentId(): string {
    return this._defaultAgentId;
  }

  dispose(): void {
    this.fileWatcher?.dispose();
    this._onAgentsChanged.dispose();
  }
}
