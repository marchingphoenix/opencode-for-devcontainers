import * as vscode from "vscode";
import { DevcontainerManager, DevcontainerState } from "./devcontainerManager";

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;

  constructor(private devcontainerManager: DevcontainerManager) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = "opencode-devcontainer.showStatus";
    this.update(devcontainerManager.state);

    devcontainerManager.onStateChanged((state) => this.update(state));
  }

  private update(state: DevcontainerState): void {
    switch (state) {
      case "running":
        this.statusBarItem.text = "$(vm-running) OpenCode DevContainer";
        this.statusBarItem.tooltip = "Dev container is running. Click for options.";
        this.statusBarItem.backgroundColor = undefined;
        break;
      case "starting":
        this.statusBarItem.text = "$(loading~spin) OpenCode DevContainer";
        this.statusBarItem.tooltip = "Dev container is starting...";
        this.statusBarItem.backgroundColor = undefined;
        break;
      case "stopped":
        this.statusBarItem.text = "$(vm-outline) OpenCode DevContainer";
        this.statusBarItem.tooltip = "Dev container is stopped. Click to start.";
        this.statusBarItem.backgroundColor = undefined;
        break;
      case "error":
        this.statusBarItem.text = "$(error) OpenCode DevContainer";
        this.statusBarItem.tooltip = "Dev container encountered an error.";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground"
        );
        break;
      case "not-found":
        this.statusBarItem.text = "$(vm-outline) OpenCode DevContainer";
        this.statusBarItem.tooltip = "No dev container found. Click to set up.";
        this.statusBarItem.backgroundColor = undefined;
        break;
    }

    this.statusBarItem.show();
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
