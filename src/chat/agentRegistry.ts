import * as vscode from "vscode";
import { AgentConfig } from "./types";

/**
 * Manages the set of configured OpenCode agents.
 *
 * Reads agent definitions from VS Code settings
 * (`opencode-devcontainer.agents`) and exposes helpers for
 * listing, looking-up, and switching the active default agent.
 */
export class AgentRegistry implements vscode.Disposable {
  private agents = new Map<string, AgentConfig>();
  private _defaultAgentId = "default";

  private readonly _onAgentsChanged = new vscode.EventEmitter<void>();
  public readonly onAgentsChanged = this._onAgentsChanged.event;

  private configListener: vscode.Disposable;

  constructor() {
    this.loadFromConfig();

    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("opencode-devcontainer.agents") ||
        e.affectsConfiguration("opencode-devcontainer.defaultAgent")
      ) {
        this.loadFromConfig();
      }
    });
  }

  /** Reload agents from VS Code settings. */
  loadFromConfig(): void {
    const config = vscode.workspace.getConfiguration("opencode-devcontainer");
    const agentDefs = config.get<AgentConfig[]>("agents", [
      {
        id: "default",
        name: "Default Agent",
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
      },
    ]);

    this.agents.clear();
    for (const agent of agentDefs) {
      this.agents.set(agent.id, agent);
    }

    this._defaultAgentId = config.get<string>("defaultAgent", "default");

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
        id: "default",
        name: "Default Agent",
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
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
    this.configListener.dispose();
    this._onAgentsChanged.dispose();
  }
}
