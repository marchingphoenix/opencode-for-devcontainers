import * as vscode from "vscode";
import { DevcontainerManager } from "./devcontainerManager";
import { OpencodeRunner } from "./opencodeRunner";
import { StatusBarManager } from "./statusBar";
import { AgentRegistry } from "./chat/agentRegistry";
import { OpenCodeBridge } from "./chat/opencodeBridge";
import { SubagentTracker } from "./chat/subagentTracker";
import { SubagentTreeProvider } from "./chat/subagentTreeProvider";
import { registerChatParticipant } from "./chat/chatParticipant";

let devcontainerManager: DevcontainerManager;
let opencodeRunner: OpencodeRunner;
let statusBarManager: StatusBarManager;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  devcontainerManager = new DevcontainerManager();
  opencodeRunner = new OpencodeRunner(devcontainerManager);
  statusBarManager = new StatusBarManager(devcontainerManager);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "opencode-devcontainer.startDevcontainer",
      async () => {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Starting dev container...",
            cancellable: false,
          },
          async () => {
            await devcontainerManager.startDevcontainer();
          }
        );
      }
    ),

    vscode.commands.registerCommand(
      "opencode-devcontainer.stopDevcontainer",
      async () => {
        await devcontainerManager.stopDevcontainer();
      }
    ),

    vscode.commands.registerCommand(
      "opencode-devcontainer.launchOpenCode",
      async () => {
        await opencodeRunner.launch();
      }
    ),

    vscode.commands.registerCommand(
      "opencode-devcontainer.launchOpenCodeInContainer",
      async () => {
        await opencodeRunner.launchInContainer();
      }
    ),

    vscode.commands.registerCommand(
      "opencode-devcontainer.showStatus",
      async () => {
        await showStatusQuickPick();
      }
    )
  );

  // --- Chat participant subsystem ---
  const agentRegistry = new AgentRegistry();
  const opencodeBridge = new OpenCodeBridge(devcontainerManager);
  const subagentTracker = new SubagentTracker();
  const subagentTreeProvider = new SubagentTreeProvider(subagentTracker);

  const treeView = vscode.window.createTreeView(
    "opencode-devcontainer.subagentActivity",
    { treeDataProvider: subagentTreeProvider }
  );

  const chatParticipant = registerChatParticipant(
    context,
    devcontainerManager,
    opencodeBridge,
    agentRegistry,
    subagentTracker
  );

  // Register disposables
  context.subscriptions.push(
    devcontainerManager,
    opencodeRunner,
    statusBarManager,
    agentRegistry,
    opencodeBridge,
    subagentTracker,
    subagentTreeProvider,
    treeView,
    chatParticipant
  );

  // Check for running devcontainer on activation
  await devcontainerManager.refreshStatus();

  // If a devcontainer config is detected, notify the user
  const configDir = await devcontainerManager.detectDevcontainerConfig();
  if (configDir && devcontainerManager.state !== "running") {
    const action = await vscode.window.showInformationMessage(
      "Dev container configuration detected. Start the container for OpenCode?",
      "Start",
      "Later"
    );
    if (action === "Start") {
      await vscode.commands.executeCommand("opencode-devcontainer.startDevcontainer");
    }
  }
}

async function showStatusQuickPick(): Promise<void> {
  const state = devcontainerManager.state;
  const items: vscode.QuickPickItem[] = [];

  if (state === "running") {
    items.push(
      {
        label: "$(play) Launch OpenCode",
        description: "Start OpenCode with dev container integration",
        detail: `Container: ${devcontainerManager.containerId?.substring(0, 12)}`,
      },
      {
        label: "$(play) Launch OpenCode Inside Container",
        description: "Run OpenCode entirely inside the dev container",
      },
      {
        label: "$(debug-stop) Stop Dev Container",
        description: "Stop the running dev container",
      },
      {
        label: "$(refresh) Refresh Status",
        description: "Check dev container status",
      }
    );
  } else {
    items.push(
      {
        label: "$(play) Start Dev Container",
        description: "Start the dev container",
      },
      {
        label: "$(refresh) Refresh Status",
        description: "Check dev container status",
      }
    );
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `Dev Container: ${state}`,
  });

  if (!selected) {
    return;
  }

  if (selected.label.includes("Launch OpenCode Inside")) {
    await vscode.commands.executeCommand("opencode-devcontainer.launchOpenCodeInContainer");
  } else if (selected.label.includes("Launch OpenCode")) {
    await vscode.commands.executeCommand("opencode-devcontainer.launchOpenCode");
  } else if (selected.label.includes("Stop")) {
    await vscode.commands.executeCommand("opencode-devcontainer.stopDevcontainer");
  } else if (selected.label.includes("Start")) {
    await vscode.commands.executeCommand("opencode-devcontainer.startDevcontainer");
  } else if (selected.label.includes("Refresh")) {
    await devcontainerManager.refreshStatus();
  }
}

export function deactivate(): void {
  // Disposables are cleaned up via context.subscriptions
}
