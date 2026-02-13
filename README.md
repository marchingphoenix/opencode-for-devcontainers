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

### Command Palette

Open a workspace that has a `.devcontainer/devcontainer.json`. The extension activates automatically and shows a status bar item. Use the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Description |
|---------|-------------|
| **OpenCode: Start Dev Container** | Start the devcontainer for the current workspace |
| **OpenCode: Launch in Dev Container Mode** | Launch OpenCode with the configured execution mode |
| **OpenCode: Launch Inside Dev Container** | Launch OpenCode entirely inside the devcontainer |
| **OpenCode: Stop Dev Container** | Stop the running devcontainer |
| **OpenCode: Show Dev Container Status** | Show a quick pick with status and actions |

### Chat Participant

The extension registers an `@opencode` chat participant in VS Code's chat panel with the following slash commands:

| Command | Description |
|---------|-------------|
| `@opencode /ask` | Send a prompt to the active OpenCode agent (default when no command is specified) |
| `@opencode /exec` | Execute a command directly in the devcontainer |
| `@opencode /status` | Show devcontainer and agent status |
| `@opencode /agents` | List configured agents grouped by primary and subagent |
| `@opencode /config` | Show current extension and agent configuration |

The chat participant supports file references — attach files from the editor to provide context with your prompts.

### Subagent Activity Tree

When a chat session is active, an **OpenCode Agents** tree view appears in the Explorer sidebar. It shows a real-time hierarchical view of subagent execution, including:

- Active and completed subagents with status icons
- Individual tool calls per subagent
- Duration and tool call counts

This can be toggled with the `chat.showSubagentTree` setting.

## Agent Configuration

Agents are loaded directly from your OpenCode configuration — no separate VS Code settings needed. The extension reads from the same sources as the OpenCode CLI:

### Search Order

The extension searches for `opencode.json` / `opencode.jsonc` in this order (first match wins):

1. **Explicit path** — set via the `opencodeConfigPath` VS Code setting
2. **Workspace root** — project-level config
3. **`~/.config/opencode/`** — global user config

### Config File Format

Agent definitions in `opencode.json` follow OpenCode's native format:

```jsonc
{
  "agent": {
    "build": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "description": "Default coding agent with all tools enabled",
      "mode": "primary"
    },
    "code-reviewer": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "description": "Reviews code for best practices",
      "mode": "subagent"
    }
  },
  "default_agent": "build"
}
```

### Markdown-Based Agents

The extension also discovers agents defined as markdown files in `.opencode/agents/` within your workspace. The filename (minus `.md`) becomes the agent id, and the first line is used as the description.

### Built-in Agents

When no config file is found, the extension provides two built-in agents:

- **Build** — Default coding agent with all tools enabled (primary)
- **Plan** — Planning agent with restricted tool access (primary)

### Auto-Reload

The agent registry automatically reloads when:
- An `opencode.json` / `opencode.jsonc` file is created, modified, or deleted in the workspace
- The `opencodeConfigPath` VS Code setting is changed

## Configuration

All VS Code settings are under the `opencode-devcontainer` namespace:

### Paths

| Setting | Default | Description |
|---------|---------|-------------|
| `opencodePath` | `"opencode"` | Path to the OpenCode binary on the host |
| `opencodeConfigPath` | `""` | Path to `opencode.json` or `opencode.jsonc`. Supports `~` expansion. When empty, searches workspace root then `~/.config/opencode/` |
| `devcontainerPath` | `""` | Custom path to devcontainer config directory |
| `dockerPath` | `"docker"` | Path to the Docker CLI binary |
| `devcontainerCliPath` | `"devcontainer"` | Path to the devcontainer CLI binary |

### Execution

| Setting | Default | Description |
|---------|---------|-------------|
| `executionMode` | `"local-with-remote-exec"` | `"local-with-remote-exec"` or `"in-container"` |
| `containerWorkspaceFolder` | `""` | Workspace path inside the container (auto-detected from devcontainer.json) |

### Environment Variables

| Setting | Default | Description |
|---------|---------|-------------|
| `additionalEnvVars` | `{}` | Extra environment variables to pass to OpenCode |
| `forwardEnvVars` | `["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_*"]` | Env var names or patterns to forward to the container |

### Chat Display

| Setting | Default | Description |
|---------|---------|-------------|
| `chat.showToolCalls` | `true` | Show individual tool call details in chat responses |
| `chat.showSubagentTree` | `true` | Show the subagent activity tree view in the Explorer |

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

### Internal Communication

The extension communicates with the OpenCode process via a line-delimited JSON protocol over stdin/stdout. Events from OpenCode include text output, tool call start/end, subagent lifecycle events, and completion/error signals.

## Development

```sh
npm install          # Install dependencies
npm run build        # Build for production
npm run watch        # Build in watch mode
npm run lint         # Run ESLint
npm test             # Run tests (vitest)
npm run test:watch   # Run tests in watch mode
npx vsce package     # Package as .vsix
```

## License

MIT
