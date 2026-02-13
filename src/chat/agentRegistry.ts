import * as vscode from "vscode";
import { AgentConfig } from "./types";
import { getWorkspaceFolder } from "../config";
import { loadAgentsFromOpenCodeConfig } from "./opencodeConfigReader";

/**
 * Manages the set of configured OpenCode agents.
 *
 * Reads agent definitions from OpenCode configuration files, searching
 * (in order):
 *  1. The explicit path set via `opencode-devcontainer.opencodeConfigPath`
 *  2. The workspace root (`opencode.json` / `opencode.jsonc`)
 *  3. `~/.config/opencode/`
 *
 * Also picks up markdown-based agents from `.opencode/agents/` in the
 * workspace.
 *
 * Falls back to built-in defaults (build + plan) when no config is found.
 */
export class AgentRegistry implements vscode.Disposable {
  private agents = new Map<string, AgentConfig>();
  private _defaultAgentId = "build";

  private readonly _onAgentsChanged = new vscode.EventEmitter<void>();
  public readonly onAgentsChanged = this._onAgentsChanged.event;

  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private configListener: vscode.Disposable;

  constructor() {
    this.loadFromConfig();

    // Watch for changes to opencode config files in the workspace.
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      "**/opencode.{json,jsonc}"
    );
    this.fileWatcher.onDidChange(() => this.loadFromConfig());
    this.fileWatcher.onDidCreate(() => this.loadFromConfig());
    this.fileWatcher.onDidDelete(() => this.loadFromConfig());

    // Reload when the user changes the opencodeConfigPath setting.
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("opencode-devcontainer.opencodeConfigPath")) {
        this.loadFromConfig();
      }
    });
  }

  /** Reload agents from the OpenCode configuration files. */
  loadFromConfig(): void {
    const workspaceRoot = getWorkspaceFolder();
    const opencodeConfigPath = vscode.workspace
      .getConfiguration("opencode-devcontainer")
      .get<string>("opencodeConfigPath", "");

    const { agents, defaultAgentId } = loadAgentsFromOpenCodeConfig(
      opencodeConfigPath,
      workspaceRoot
    );

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
    this.configListener.dispose();
    this._onAgentsChanged.dispose();
  }
}
