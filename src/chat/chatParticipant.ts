import * as vscode from "vscode";
import { DevcontainerManager } from "../devcontainerManager";
import { OpenCodeBridge } from "./opencodeBridge";
import { AgentRegistry } from "./agentRegistry";
import { SubagentTracker } from "./subagentTracker";
import { ResponseRenderer } from "./responseRenderer";
import { OpenCodeEvent } from "./types";

const PARTICIPANT_ID = "opencode-devcontainer.opencode";

/**
 * Register the `@opencode` chat participant in VS Code's chat window.
 *
 * Slash commands:
 *  - /ask     — Send a prompt to the active agent
 *  - /exec    — Execute a command directly in the devcontainer
 *  - /status  — Show devcontainer + agent status
 *  - /agents  — List / switch agents
 *  - /config  — Show current configuration
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  devcontainerManager: DevcontainerManager,
  bridge: OpenCodeBridge,
  agentRegistry: AgentRegistry,
  subagentTracker: SubagentTracker
): vscode.ChatParticipant {
  const renderer = new ResponseRenderer();

  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    async (
      request: vscode.ChatRequest,
      _context: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> => {
      const command = request.command;

      try {
        switch (command) {
          case "status":
            return handleStatus(
              stream,
              devcontainerManager,
              agentRegistry,
              subagentTracker
            );

          case "agents":
            return handleAgents(stream, agentRegistry);

          case "config":
            return handleConfig(stream, agentRegistry);

          case "exec":
            return await handleExec(
              request,
              stream,
              devcontainerManager
            );

          case "ask":
          default:
            return await handleAsk(
              request,
              stream,
              token,
              bridge,
              agentRegistry,
              subagentTracker,
              renderer
            );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stream.markdown(`\n\`\`\`\nError: ${message}\n\`\`\`\n`);
        return { metadata: { error: message } };
      }
    }
  );

  participant.iconPath = new vscode.ThemeIcon("remote");

  // Follow-up provider
  participant.followupProvider = {
    provideFollowups(
      result: vscode.ChatResult,
      _context: vscode.ChatContext,
      _token: vscode.CancellationToken
    ): vscode.ChatFollowup[] {
      const meta = result.metadata as Record<string, unknown> | undefined;
      if (!meta) {
        return [];
      }

      const followups: vscode.ChatFollowup[] = [];

      if (meta.commandRan) {
        followups.push(
          { prompt: "Run tests", command: "exec" },
          { prompt: "Show the diff", command: "ask" }
        );
      }
      if (meta.error) {
        followups.push(
          { prompt: "Try a different approach", command: "ask" },
          { prompt: "Show logs", command: "exec" }
        );
      }
      if (meta.completed) {
        followups.push(
          { prompt: "Run tests", command: "exec" },
          { prompt: "Explain the changes", command: "ask" }
        );
      }
      if (meta.status) {
        followups.push(
          { prompt: "Launch OpenCode", command: "ask" },
          { prompt: "Switch agent", command: "agents" }
        );
      }

      return followups;
    },
  };

  return participant;
}

// ---------------------------------------------------------------------------
// /ask (default) — send prompt to OpenCode
// ---------------------------------------------------------------------------

async function handleAsk(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  bridge: OpenCodeBridge,
  agentRegistry: AgentRegistry,
  subagentTracker: SubagentTracker,
  renderer: ResponseRenderer
): Promise<vscode.ChatResult> {
  const prompt = request.prompt;
  if (!prompt.trim()) {
    stream.markdown("Please provide a prompt. Example: `@opencode Fix the failing test`");
    return {};
  }

  const agent = agentRegistry.getDefaultAgent();
  renderer.renderAgentHeader(agent, stream);
  stream.progress("Connecting to OpenCode...");

  // Ensure the bridge is running.
  if (!bridge.isRunning()) {
    await bridge.start();
  }

  if (!bridge.isRunning()) {
    stream.markdown(
      "Failed to start OpenCode. Make sure the dev container is running and OpenCode is installed."
    );
    return { metadata: { error: "bridge_start_failed" } };
  }

  // Reset subagent tracking for this request.
  subagentTracker.reset();

  // Set the chat-active context key for the tree view.
  await vscode.commands.executeCommand(
    "setContext",
    "opencode-devcontainer.chatActive",
    true
  );

  // Collect file references from the request.
  const references = request.references
    ?.map((ref) => {
      if (ref.value instanceof vscode.Uri) {
        return ref.value.fsPath;
      }
      if (ref.value && typeof ref.value === "object" && "uri" in ref.value) {
        return (ref.value as vscode.Location).uri.fsPath;
      }
      return undefined;
    })
    .filter((r): r is string => r !== undefined);

  // Send the prompt.
  bridge.sendPrompt(prompt, agent.id, references);

  // Wait for the response to complete (or cancellation).
  return new Promise<vscode.ChatResult>((resolve) => {
    let completed = false;

    const finish = (meta: Record<string, unknown>) => {
      if (completed) {
        return;
      }
      completed = true;
      eventListener.dispose();
      cancelListener.dispose();

      // Render subagent summary.
      const subagents = subagentTracker.getAllSubagents();
      renderer.renderSubagentSummary(subagents, stream);

      resolve({ metadata: meta });
    };

    const eventListener = bridge.onEvent((event: OpenCodeEvent) => {
      // Feed every event to the subagent tracker.
      subagentTracker.handleEvent(event);

      // Render the event.
      renderer.renderEvent(event, stream);

      if (event.type === "done") {
        finish({ completed: true, commandRan: true });
      }
      if (event.type === "error") {
        finish({ error: event.message });
      }
    });

    const cancelListener = token.onCancellationRequested(() => {
      bridge.cancelCurrentRequest();
      stream.markdown("\n_Request cancelled._\n");
      finish({ cancelled: true });
    });
  });
}

// ---------------------------------------------------------------------------
// /exec — run a command in the devcontainer
// ---------------------------------------------------------------------------

async function handleExec(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  devcontainerManager: DevcontainerManager
): Promise<vscode.ChatResult> {
  const command = request.prompt.trim();
  if (!command) {
    stream.markdown(
      "Provide a command to execute. Example: `@opencode /exec npm test`"
    );
    return {};
  }

  if (devcontainerManager.state !== "running") {
    stream.markdown(
      "Dev container is not running. Start it with `@opencode /status` first."
    );
    return { metadata: { error: "container_not_running" } };
  }

  stream.progress(`Running \`${command}\`...`);

  try {
    const result = await devcontainerManager.execInContainer(command);

    if (result.stdout) {
      stream.markdown(`\`\`\`\n${result.stdout}\n\`\`\`\n`);
    }
    if (result.stderr) {
      stream.markdown(`**stderr:**\n\`\`\`\n${result.stderr}\n\`\`\`\n`);
    }
    if (!result.stdout && !result.stderr) {
      stream.markdown("_Command completed with no output._");
    }

    return { metadata: { commandRan: true } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stream.markdown(`\`\`\`\nError: ${message}\n\`\`\`\n`);
    return { metadata: { error: message } };
  }
}

// ---------------------------------------------------------------------------
// /status — show devcontainer + agent status
// ---------------------------------------------------------------------------

function handleStatus(
  stream: vscode.ChatResponseStream,
  devcontainerManager: DevcontainerManager,
  agentRegistry: AgentRegistry,
  subagentTracker: SubagentTracker
): vscode.ChatResult {
  const stateEmoji: Record<string, string> = {
    running: "$(vm-running)",
    stopped: "$(vm-outline)",
    starting: "$(loading~spin)",
    "not-found": "$(question)",
    error: "$(error)",
  };

  const state = devcontainerManager.state;
  const lines: string[] = [
    "## OpenCode Status\n",
    `**Dev Container**: ${stateEmoji[state] || ""} ${state}`,
  ];

  if (devcontainerManager.containerId) {
    lines.push(
      `**Container ID**: \`${devcontainerManager.containerId.substring(0, 12)}\``
    );
  }
  if (devcontainerManager.remoteWorkspaceFolder) {
    lines.push(
      `**Workspace**: \`${devcontainerManager.remoteWorkspaceFolder}\``
    );
  }

  lines.push("\n**Configured Agents:**\n");
  const defaultId = agentRegistry.defaultAgentId;
  for (const agent of agentRegistry.listAgents()) {
    const marker = agent.id === defaultId ? "$(circle-filled)" : "$(circle-outline)";
    lines.push(
      `- ${marker} **${agent.name}** (${agent.provider}/${agent.model})`
    );
  }

  const active = subagentTracker.getActiveSubagents();
  lines.push(`\n**Active subagents**: ${active.length}`);

  stream.markdown(lines.join("\n"));

  return { metadata: { status: true } };
}

// ---------------------------------------------------------------------------
// /agents — list and switch agents
// ---------------------------------------------------------------------------

function handleAgents(
  stream: vscode.ChatResponseStream,
  agentRegistry: AgentRegistry
): vscode.ChatResult {
  const agents = agentRegistry.listAgents();
  const defaultId = agentRegistry.defaultAgentId;

  const primaryAgents = agents.filter((a) => a.mode !== "subagent");
  const subagents = agents.filter((a) => a.mode === "subagent");

  const lines = ["## OpenCode Agents\n"];
  lines.push("_Loaded from `opencode.json` / `.opencode/agents/`_\n");

  if (primaryAgents.length > 0) {
    lines.push("### Primary Agents\n");
    for (const agent of primaryAgents) {
      const active = agent.id === defaultId ? " **(active)**" : "";
      lines.push(
        `- **${agent.name}**${active} — \`${agent.provider}/${agent.model}\``
      );
      if (agent.description) {
        lines.push(`  _${agent.description}_`);
      }
    }
  }

  if (subagents.length > 0) {
    lines.push("\n### Subagents\n");
    for (const agent of subagents) {
      lines.push(
        `- **${agent.name}** — \`${agent.provider}/${agent.model}\``
      );
      if (agent.description) {
        lines.push(`  _${agent.description}_`);
      }
    }
  }

  lines.push(
    "\nTo change the default agent, set `default_agent` in your `opencode.json`.",
    "To use a custom config location, set `opencode-devcontainer.opencodeConfigPath` in VS Code settings."
  );

  stream.markdown(lines.join("\n"));
  return { metadata: { status: true } };
}

// ---------------------------------------------------------------------------
// /config — show configuration
// ---------------------------------------------------------------------------

function handleConfig(
  stream: vscode.ChatResponseStream,
  agentRegistry: AgentRegistry
): vscode.ChatResult {
  const config = vscode.workspace.getConfiguration("opencode-devcontainer");

  const lines = [
    "## OpenCode Configuration\n",
    `| Setting | Value |`,
    `| ------- | ----- |`,
    `| Execution Mode | \`${config.get("executionMode")}\` |`,
    `| OpenCode Path | \`${config.get("opencodePath")}\` |`,
    `| OpenCode Config | \`${config.get("opencodeConfigPath") || "(auto-detected)"}\` |`,
    `| Docker Path | \`${config.get("dockerPath")}\` |`,
    `| DevContainer CLI | \`${config.get("devcontainerCliPath")}\` |`,
    `| Default Agent | \`${agentRegistry.defaultAgentId}\` _(from opencode.json)_ |`,
    `| Total Agents | \`${agentRegistry.listAgents().length}\` _(from opencode.json)_ |`,
    `| Show Tool Calls | \`${config.get("chat.showToolCalls")}\` |`,
    `| Show Subagent Tree | \`${config.get("chat.showSubagentTree")}\` |`,
  ];

  stream.markdown(lines.join("\n"));
  return { metadata: { status: true } };
}
