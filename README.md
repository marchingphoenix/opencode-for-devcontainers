# opencode-for-devcontainers

VS Code extension to run [OpenCode](https://opencode.ai/) locally but execute commands within a devcontainer.

## How It Works

This extension bridges OpenCode's local execution with a devcontainer environment. It supports two modes:

### Local with Remote Execution (default)

OpenCode runs on your host machine for fast startup and direct access to host resources (API keys, environment variables). When OpenCode executes shell commands (builds, tests, linting), those commands are routed into the devcontainer via `docker exec`. File operations happen on the local filesystem, which is shared with the container through the devcontainer mount.

### In-Container Mode

OpenCode runs entirely inside the devcontainer. The OpenCode binary must be available in the container image. You interact with it through a VS Code terminal.

## Prerequisites

- [VS Code](https://code.visualstudio.com/) 1.85+
- [Docker](https://www.docker.com/) installed and running
- [Dev Containers CLI](https://github.com/devcontainers/cli) (`npm install -g @devcontainers/cli`)
- [OpenCode](https://opencode.ai/) installed locally (for local mode) or in the container image (for in-container mode)
- A `.devcontainer/devcontainer.json` in your workspace

## Installation

Install from the VS Code marketplace or build from source:

```sh
git clone https://github.com/marchingphoenix/opencode-for-devcontainers.git
cd opencode-for-devcontainers
npm install
npm run build
```

Then press `F5` in VS Code to launch the extension in a development host, or package it:

```sh
npx vsce package
code --install-extension opencode-for-devcontainers-*.vsix
```

## Usage

1. Open a workspace that has a `.devcontainer/devcontainer.json`
2. The extension activates automatically and shows a status bar item
3. Use the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Description |
|---------|-------------|
| **OpenCode: Start Dev Container** | Start the devcontainer for the current workspace |
| **OpenCode: Launch in Dev Container Mode** | Launch OpenCode with the configured execution mode |
| **OpenCode: Launch Inside Dev Container** | Launch OpenCode entirely inside the devcontainer |
| **OpenCode: Stop Dev Container** | Stop the running devcontainer |
| **OpenCode: Show Dev Container Status** | Show a quick pick with status and actions |

## Configuration

All settings are under the `opencode-devcontainer` namespace:

| Setting | Default | Description |
|---------|---------|-------------|
| `opencodePath` | `"opencode"` | Path to the OpenCode binary on the host |
| `devcontainerPath` | `""` | Custom path to devcontainer config directory |
| `dockerPath` | `"docker"` | Path to the Docker CLI binary |
| `devcontainerCliPath` | `"devcontainer"` | Path to the devcontainer CLI binary |
| `executionMode` | `"local-with-remote-exec"` | `"local-with-remote-exec"` or `"in-container"` |
| `containerWorkspaceFolder` | `""` | Workspace path inside the container (auto-detected) |
| `additionalEnvVars` | `{}` | Extra environment variables for OpenCode |
| `forwardEnvVars` | `["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_*"]` | Env vars to forward to the container |

## Architecture

```
Host Machine                          Dev Container
┌──────────────────┐                  ┌──────────────────┐
│  VS Code         │                  │                  │
│  ┌────────────┐  │   docker exec    │  Shell commands  │
│  │  OpenCode  │──┼──────────────────▶  (build, test,  │
│  │  (local)   │  │                  │   lint, etc.)    │
│  └────────────┘  │                  │                  │
│       │          │                  │                  │
│  File I/O        │   mount          │  /workspaces/    │
│  (local fs) ─────┼──────────────────▶  project/        │
│                  │                  │                  │
└──────────────────┘                  └──────────────────┘
```

## License

MIT
