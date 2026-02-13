# Plan: Native VS Code Chat Window Support for OpenCode DevContainers

## Overview

Add a native VS Code Chat Participant (`@opencode`) that integrates OpenCode into VS Code's
built-in chat window. The chat participant communicates with configured OpenCode agents,
displays agent status in real-time, and tracks subagent activity in a dedicated tree view.

---

## Architecture

```
VS Code Chat Window (@opencode)
       │
       ▼
  ChatParticipant
       │
       ├── AgentRegistry ─── manages configured agents (providers/models)
       │
       ├── OpenCodeBridge ─── spawns opencode process, line-delimited JSON protocol
       │   ├── sends prompts via stdin
       │   └── receives structured events via stdout
       │
       ├── SubagentTracker ─── monitors subagent lifecycle + tool calls
       │   └── SubagentTreeProvider (TreeView in sidebar)
       │
       └── ChatResponseRenderer ─── maps OpenCode events → stream.progress/markdown/button
```

### Communication Protocol

OpenCode supports a `--format json` (or similar headless/pipe) mode for non-interactive use.
We will spawn `opencode` as a child process and communicate via **line-delimited JSON** over
stdin/stdout. Each line from OpenCode is a structured event:

```jsonc
// Events FROM OpenCode (stdout):
{"type": "status",     "message": "Analyzing code...", "agent": "default"}
{"type": "text",       "content": "Here is the fix...", "agent": "default"}
{"type": "tool_start", "tool": "shell", "args": {"command": "npm test"}, "subagentId": "sa-1"}
{"type": "tool_end",   "tool": "shell", "result": "...", "subagentId": "sa-1"}
{"type": "subagent_start", "id": "sa-1", "name": "test-runner", "parent": "default"}
{"type": "subagent_end",   "id": "sa-1", "status": "completed"}
{"type": "done",       "agent": "default"}
{"type": "error",      "message": "..."}

// Commands TO OpenCode (stdin):
{"type": "prompt",  "text": "Fix the bug in app.ts", "agent": "default"}
{"type": "cancel"}
{"type": "config",  "agent": "coding-agent", "provider": "anthropic", "model": "claude-sonnet-4-5-20250929"}
```

If OpenCode does not support a structured JSON mode natively, we will implement an
**adapter layer** (`OpenCodeAdapter`) that wraps the CLI and parses its output into
the structured event format above.

---

## Files to Create / Modify

### New Files

| File | Purpose |
|------|---------|
| `src/chat/chatParticipant.ts` | Registers `@opencode` chat participant, routes requests to bridge |
| `src/chat/agentRegistry.ts` | Manages configured agents (name, provider, model, capabilities) |
| `src/chat/opencodeBridge.ts` | Spawns OpenCode process, sends/receives line-delimited JSON |
| `src/chat/opencodeAdapter.ts` | Adapter that wraps raw OpenCode CLI output into structured events |
| `src/chat/subagentTracker.ts` | Tracks subagent lifecycle, emits events for UI updates |
| `src/chat/subagentTreeProvider.ts` | TreeDataProvider for the Subagent Activity sidebar view |
| `src/chat/responseRenderer.ts` | Maps OpenCode events to ChatResponseStream calls |
| `src/chat/types.ts` | Shared types/interfaces for the chat subsystem |

### Modified Files

| File | Changes |
|------|---------|
| `package.json` | Add chatParticipants, commands, views, configuration |
| `src/extension.ts` | Initialize chat participant and tree view on activation |
| `src/config.ts` | Add agent configuration types |

---

## Step-by-Step Implementation

### Step 1: Define shared types (`src/chat/types.ts`)

Interfaces for the event protocol and agent configuration:

```typescript
export interface AgentConfig {
  id: string;              // e.g. "default", "coding-agent"
  name: string;            // Display name
  provider: string;        // e.g. "anthropic", "openai", "ollama"
  model: string;           // e.g. "claude-sonnet-4-5-20250929"
  description?: string;
}

export type OpenCodeEvent =
  | { type: "status"; message: string; agent: string }
  | { type: "text"; content: string; agent: string }
  | { type: "tool_start"; tool: string; args: Record<string, unknown>; subagentId?: string }
  | { type: "tool_end"; tool: string; result: string; subagentId?: string }
  | { type: "subagent_start"; id: string; name: string; parent: string }
  | { type: "subagent_end"; id: string; status: "completed" | "failed" | "cancelled" }
  | { type: "done"; agent: string }
  | { type: "error"; message: string };

export type OpenCodeCommand =
  | { type: "prompt"; text: string; agent?: string; references?: string[] }
  | { type: "cancel" }
  | { type: "config"; agent: string; provider: string; model: string };

export interface SubagentInfo {
  id: string;
  name: string;
  parent: string;
  status: "running" | "completed" | "failed" | "cancelled";
  currentTool?: string;
  startedAt: number;
  completedAt?: number;
  toolCalls: ToolCallInfo[];
}

export interface ToolCallInfo {
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  startedAt: number;
  completedAt?: number;
}
```

### Step 2: Implement Agent Registry (`src/chat/agentRegistry.ts`)

Manages the list of configured agents. Reads from VS Code configuration and
allows runtime additions.

```
class AgentRegistry
  - agents: Map<string, AgentConfig>
  - defaultAgentId: string
  - onAgentsChanged: Event<void>
  + loadFromConfig(): void          // reads opencode-devcontainer.agents setting
  + getAgent(id: string): AgentConfig | undefined
  + getDefaultAgent(): AgentConfig
  + listAgents(): AgentConfig[]
  + setDefaultAgent(id: string): void
```

### Step 3: Implement OpenCode Bridge (`src/chat/opencodeBridge.ts`)

Manages the OpenCode child process and provides an event-driven interface.

```
class OpenCodeBridge
  - process: ChildProcess | null
  - onEvent: Event<OpenCodeEvent>
  - state: "idle" | "busy" | "error" | "stopped"
  + start(workspaceFolder: string, containerId?: string): Promise<void>
  + stop(): void
  + sendPrompt(text: string, agent?: string, refs?: string[]): void
  + cancelCurrentRequest(): void
  + isRunning(): boolean
  + dispose(): void

  // Internal:
  - spawnProcess(): ChildProcess
  - handleStdoutLine(line: string): void
  - handleStderr(data: string): void
  - handleExit(code: number): void
```

Key decisions:
- The bridge spawns `opencode` with flags for JSON output mode
- If running in devcontainer mode, it spawns via `docker exec`
- Uses the existing `DevcontainerManager` to get container ID and workspace folder
- Emits parsed `OpenCodeEvent` objects for each line of output
- Manages lifecycle (start, stop, restart on crash)

### Step 4: Implement OpenCode Adapter (`src/chat/opencodeAdapter.ts`)

Fallback adapter for when OpenCode doesn't support structured JSON output natively.
Parses the raw terminal output and converts it into `OpenCodeEvent` objects.

```
class OpenCodeAdapter
  - onEvent: Event<OpenCodeEvent>
  + processLine(raw: string): OpenCodeEvent | null
  + processChunk(data: Buffer): void

  // Heuristic parsing:
  - detectStatusLine(line: string): OpenCodeEvent | null
  - detectToolCall(line: string): OpenCodeEvent | null
  - detectCompletion(line: string): OpenCodeEvent | null
  - accumulateText(line: string): void
```

This adapter uses pattern matching to detect:
- Status messages (e.g., lines starting with spinner characters or `[status]`)
- Tool invocations (e.g., `Running: npm test`, `Reading: src/app.ts`)
- Subagent spawning (e.g., `[agent:sa-1] Starting...`)
- Completion markers
- Error messages

### Step 5: Implement Subagent Tracker (`src/chat/subagentTracker.ts`)

Tracks all subagent activity and provides data for the tree view.

```
class SubagentTracker
  - subagents: Map<string, SubagentInfo>
  - onSubagentChanged: Event<SubagentInfo>
  - onSubagentsReset: Event<void>
  + handleEvent(event: OpenCodeEvent): void
  + getSubagent(id: string): SubagentInfo | undefined
  + getActiveSubagents(): SubagentInfo[]
  + getAllSubagents(): SubagentInfo[]
  + reset(): void
  + dispose(): void
```

Event handling:
- `subagent_start` → create new SubagentInfo entry, status = "running"
- `tool_start` (with subagentId) → update subagent's currentTool, add to toolCalls
- `tool_end` (with subagentId) → clear currentTool, update tool result
- `subagent_end` → update status, set completedAt
- `done` → mark all remaining subagents as completed

### Step 6: Implement Subagent Tree View (`src/chat/subagentTreeProvider.ts`)

TreeDataProvider that displays subagent activity in a VS Code sidebar panel.

```
class SubagentTreeProvider implements TreeDataProvider<SubagentTreeItem>
  - tracker: SubagentTracker
  - onDidChangeTreeData: Event<void>
  + getTreeItem(element): TreeItem
  + getChildren(element?): SubagentTreeItem[]
  + refresh(): void

Tree Structure:
  ├── [agent-icon] coding-agent (running)
  │   ├── [tool-icon] shell: npm test (completed)
  │   ├── [tool-icon] file_edit: src/app.ts (completed)
  │   └── [spinner-icon] shell: npm run build (running)
  └── [agent-icon] test-runner (completed, 3 tool calls)
```

Each tree item shows:
- Agent name and status (with color-coded icons)
- Individual tool calls with their type and arguments
- Duration for completed items
- Expandable to show tool call details

### Step 7: Implement Response Renderer (`src/chat/responseRenderer.ts`)

Maps OpenCode events to VS Code ChatResponseStream calls.

```
class ResponseRenderer
  + renderEvent(event: OpenCodeEvent, stream: ChatResponseStream): void
  + renderAgentHeader(agent: AgentConfig, stream: ChatResponseStream): void
  + renderToolCall(tool: string, args: Record<string, unknown>, stream: ChatResponseStream): void
  + renderSubagentSummary(subagents: SubagentInfo[], stream: ChatResponseStream): void

Mapping:
  status      → stream.progress(message)
  text        → stream.markdown(content)
  tool_start  → stream.progress(`Running ${tool}...`) + stream.markdown(tool details)
  tool_end    → stream.markdown(formatted result)
  subagent_*  → stream.progress(subagent status)
  error       → stream.markdown(error block)
  done        → stream.markdown(summary) + follow-up suggestions
```

### Step 8: Implement Chat Participant (`src/chat/chatParticipant.ts`)

The main entry point that registers the `@opencode` participant.

```
function registerChatParticipant(
  context: ExtensionContext,
  devcontainerManager: DevcontainerManager,
  bridge: OpenCodeBridge,
  agentRegistry: AgentRegistry,
  subagentTracker: SubagentTracker
): ChatParticipant

Slash commands:
  /ask     → Send a prompt to the default agent
  /exec    → Execute a command directly in the devcontainer
  /status  → Show devcontainer + agent status summary
  /agents  → List configured agents, allow switching
  /config  → Show/change configuration

Request handler:
  1. Parse slash command + prompt
  2. Show progress: "Connecting to OpenCode..."
  3. Ensure bridge is running (start if needed, using devcontainer if configured)
  4. Send prompt to bridge with selected agent
  5. Listen for events from bridge
  6. For each event: call responseRenderer.renderEvent(event, stream)
  7. Track subagents via subagentTracker.handleEvent(event)
  8. On "done": render summary, return ChatResult with metadata
  9. On cancellation token: call bridge.cancelCurrentRequest()

Follow-up provider:
  - Based on what happened, suggest relevant follow-ups
  - After a fix: "Run tests", "Show diff", "Explain the change"
  - After an error: "Try a different approach", "Show logs"
  - After status: "Launch OpenCode", "Switch agent"
```

### Step 9: Update package.json

Add the following to the `contributes` section:

```jsonc
{
  "chatParticipants": [
    {
      "id": "opencode-devcontainer.opencode",
      "name": "opencode",
      "fullName": "OpenCode",
      "description": "AI coding agent running in your dev container",
      "isSticky": true,
      "commands": [
        { "name": "ask",    "description": "Ask OpenCode a question" },
        { "name": "exec",   "description": "Execute a command in the dev container" },
        { "name": "status", "description": "Show agent and container status" },
        { "name": "agents", "description": "List and switch between configured agents" },
        { "name": "config", "description": "Show or change configuration" }
      ]
    }
  ],
  "views": {
    "explorer": [
      {
        "id": "opencode-devcontainer.subagentActivity",
        "name": "OpenCode Agents",
        "when": "opencode-devcontainer.chatActive"
      }
    ]
  },
  "configuration": {
    "properties": {
      "opencode-devcontainer.agents": {
        "type": "array",
        "default": [
          {
            "id": "default",
            "name": "Default Agent",
            "provider": "anthropic",
            "model": "claude-sonnet-4-5-20250929"
          }
        ],
        "items": {
          "type": "object",
          "properties": {
            "id":          { "type": "string" },
            "name":        { "type": "string" },
            "provider":    { "type": "string" },
            "model":       { "type": "string" },
            "description": { "type": "string" }
          },
          "required": ["id", "name", "provider", "model"]
        },
        "description": "Configured OpenCode agents (AI provider/model combinations)"
      },
      "opencode-devcontainer.defaultAgent": {
        "type": "string",
        "default": "default",
        "description": "ID of the default agent to use in the chat window"
      },
      "opencode-devcontainer.chat.showToolCalls": {
        "type": "boolean",
        "default": true,
        "description": "Show individual tool call details in chat responses"
      },
      "opencode-devcontainer.chat.showSubagentTree": {
        "type": "boolean",
        "default": true,
        "description": "Show the subagent activity tree view"
      }
    }
  }
}
```

Also add to activationEvents:
```json
"activationEvents": [
  "onChatParticipant:opencode-devcontainer.opencode"
]
```

### Step 10: Update extension.ts

Wire up the new chat components during activation:

```typescript
// In activate():
const agentRegistry = new AgentRegistry();
const opencodeBridge = new OpenCodeBridge(devcontainerManager);
const subagentTracker = new SubagentTracker();
const subagentTreeProvider = new SubagentTreeProvider(subagentTracker);

// Register tree view
const treeView = vscode.window.createTreeView(
  'opencode-devcontainer.subagentActivity',
  { treeDataProvider: subagentTreeProvider }
);

// Register chat participant
const chatParticipant = registerChatParticipant(
  context, devcontainerManager, opencodeBridge,
  agentRegistry, subagentTracker
);

// Push all to subscriptions
context.subscriptions.push(
  agentRegistry, opencodeBridge, subagentTracker,
  treeView, chatParticipant
);
```

---

## Implementation Order

1. **`src/chat/types.ts`** — Foundation types (no dependencies)
2. **`src/chat/agentRegistry.ts`** — Agent management (depends on types + config)
3. **`src/chat/opencodeAdapter.ts`** — Output parser (depends on types)
4. **`src/chat/opencodeBridge.ts`** — Process manager (depends on types, adapter, devcontainerManager)
5. **`src/chat/subagentTracker.ts`** — Activity tracker (depends on types)
6. **`src/chat/subagentTreeProvider.ts`** — Tree view (depends on tracker)
7. **`src/chat/responseRenderer.ts`** — Chat output formatting (depends on types, agentRegistry)
8. **`src/chat/chatParticipant.ts`** — Ties everything together
9. **`package.json`** — Add contributes declarations
10. **`src/extension.ts`** — Wire up initialization
11. **`src/config.ts`** — Add agent config types

---

## User Experience Flow

### Asking a question via chat

```
User types: @opencode /ask Fix the failing test in auth.test.ts

Chat window shows:
┌─────────────────────────────────────────────┐
│ 🤖 OpenCode (Default Agent - Claude Sonnet) │
│                                             │
│ ⏳ Analyzing test failures...               │
│                                             │
│ I found the issue in `auth.test.ts`. The    │
│ mock for `fetchUser` is returning the wrong │
│ type. Here's the fix:                       │
│                                             │
│ ```typescript                               │
│ // auth.test.ts:24                          │
│ mock(fetchUser).returns({                   │
│   id: 1,                                   │
│   role: 'admin'  // was missing             │
│ });                                         │
│ ```                                         │
│                                             │
│ 🔧 Tool calls:                             │
│   ✅ file_read: src/auth.test.ts            │
│   ✅ shell: npm test -- auth.test           │
│   ✅ file_edit: src/auth.test.ts:24         │
│   ✅ shell: npm test -- auth.test (passed)  │
│                                             │
│ [Run Tests] [Show Diff] [Explain More]      │
└─────────────────────────────────────────────┘
```

### Viewing agent status

```
User types: @opencode /status

Chat window shows:
┌─────────────────────────────────────────────┐
│ 🤖 OpenCode Status                          │
│                                             │
│ **Dev Container**: ✅ Running (abc123def)   │
│ **Workspace**: /workspaces/my-project       │
│                                             │
│ **Configured Agents**:                      │
│ • 🟢 Default Agent (anthropic/claude-sonnet)│
│ • ⚪ Fast Agent (openai/gpt-4o)             │
│ • ⚪ Local Agent (ollama/codellama)          │
│                                             │
│ **Active subagents**: 0                     │
│                                             │
│ [Launch Terminal] [Switch Agent] [Configure] │
└─────────────────────────────────────────────┘
```

### Subagent tree view (sidebar)

```
OPENCODE AGENTS
├── 🟢 Default Agent (busy)
│   ├── 🔧 shell: npm test (running, 3s)
│   └── ✅ file_read: src/app.ts (0.2s)
├── 🟢 test-runner [subagent] (busy)
│   ├── 🔧 shell: jest --coverage (running, 8s)
│   └── ✅ shell: npm run lint (1.2s)
└── ✅ code-reviewer [subagent] (completed, 12s)
    ├── ✅ file_read: src/utils.ts (0.1s)
    ├── ✅ file_read: src/utils.test.ts (0.1s)
    └── ✅ shell: npm test -- utils (2.3s)
```

---

## Edge Cases and Error Handling

1. **OpenCode not installed**: Show error in chat with install instructions and a button to open the docs
2. **Devcontainer not running**: Prompt to start it via a chat button, same as terminal mode
3. **Process crash**: Detect exit, show error in chat, offer restart button
4. **Cancellation**: Honor VS Code's CancellationToken, send cancel command to bridge
5. **Long-running operations**: Show elapsed time in progress, allow cancel via stop button
6. **Multiple concurrent requests**: Queue prompts, bridge processes one at a time
7. **Agent switching mid-conversation**: Allow via /agents command, restart bridge with new config
8. **No JSON mode available**: Fall back to OpenCodeAdapter for heuristic parsing
