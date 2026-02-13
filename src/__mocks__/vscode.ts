/**
 * Minimal mock of the `vscode` module for unit tests.
 *
 * Provides just enough surface area so that the extension source files
 * can be imported and exercised outside of the VS Code runtime.
 */

import { vi } from "vitest";

// ---------------------------------------------------------------------------
// EventEmitter
// ---------------------------------------------------------------------------

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];

  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => this.removeListener(listener) };
  };

  fire(data: T): void {
    for (const fn of this.listeners) {
      fn(data);
    }
  }

  dispose(): void {
    this.listeners = [];
  }

  private removeListener(listener: (e: T) => void): void {
    const idx = this.listeners.indexOf(listener);
    if (idx >= 0) {
      this.listeners.splice(idx, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// ThemeColor / ThemeIcon
// ---------------------------------------------------------------------------

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class ThemeIcon {
  constructor(
    public readonly id: string,
    public readonly color?: ThemeColor
  ) {}
}

// ---------------------------------------------------------------------------
// Uri
// ---------------------------------------------------------------------------

export class Uri {
  private constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
    public readonly query: string,
    public readonly fragment: string
  ) {}

  get fsPath(): string {
    return this.path;
  }

  static file(path: string): Uri {
    return new Uri("file", "", path, "", "");
  }

  static parse(value: string): Uri {
    return new Uri("file", "", value, "", "");
  }
}

// ---------------------------------------------------------------------------
// Tree view
// ---------------------------------------------------------------------------

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  label: string;
  collapsibleState: TreeItemCollapsibleState;
  iconPath?: ThemeIcon;
  description?: string;
  tooltip?: string;
  command?: unknown;

  constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState ?? TreeItemCollapsibleState.None;
  }
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export enum ProgressLocation {
  Notification = 15,
}

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------

let _mockConfigValues: Record<string, unknown> = {};
let _mockWorkspaceFolders: Array<{ uri: Uri }> | undefined;

/** Helper for tests to set config values returned by `workspace.getConfiguration`. */
export function __setMockConfig(values: Record<string, unknown>): void {
  _mockConfigValues = values;
}

/** Helper for tests to set `workspace.workspaceFolders`. */
export function __setWorkspaceFolders(
  folders: Array<{ uri: Uri }> | undefined
): void {
  _mockWorkspaceFolders = folders;
}

function makeConfigProxy(section: string) {
  return {
    get<T>(key: string, defaultValue?: T): T {
      const fullKey = section ? `${section}.${key}` : key;
      if (fullKey in _mockConfigValues) {
        return _mockConfigValues[fullKey] as T;
      }
      return defaultValue as T;
    },
    has(key: string): boolean {
      const fullKey = section ? `${section}.${key}` : key;
      return fullKey in _mockConfigValues;
    },
    inspect: vi.fn(),
    update: vi.fn(),
  };
}

function createMockFileSystemWatcher() {
  return {
    onDidChange: vi.fn((_cb: unknown) => ({ dispose: vi.fn() })),
    onDidCreate: vi.fn((_cb: unknown) => ({ dispose: vi.fn() })),
    onDidDelete: vi.fn((_cb: unknown) => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
  };
}

export const workspace = {
  getConfiguration: vi.fn((section?: string) => makeConfigProxy(section ?? "")),
  get workspaceFolders() {
    return _mockWorkspaceFolders;
  },
  onDidChangeConfiguration: vi.fn((_cb: unknown) => ({
    dispose: vi.fn(),
  })),
  createFileSystemWatcher: vi.fn((_pattern: string) =>
    createMockFileSystemWatcher()
  ),
};

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function createMockStatusBarItem() {
  return {
    text: "",
    tooltip: "",
    command: undefined as string | undefined,
    backgroundColor: undefined as ThemeColor | undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
}

function createMockTerminal() {
  return {
    name: "",
    sendText: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  };
}

export const window = {
  createStatusBarItem: vi.fn((_alignment?: StatusBarAlignment, _priority?: number) =>
    createMockStatusBarItem()
  ),
  createTerminal: vi.fn((_options?: unknown) => createMockTerminal()),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showQuickPick: vi.fn(),
  onDidCloseTerminal: vi.fn((_cb: unknown) => ({ dispose: vi.fn() })),
  withProgress: vi.fn(),
  createTreeView: vi.fn((_id: string, _options: unknown) => ({
    dispose: vi.fn(),
  })),
};

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export const commands = {
  registerCommand: vi.fn((_id: string, _cb: unknown) => ({
    dispose: vi.fn(),
  })),
  executeCommand: vi.fn(),
};

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

function createMockChatParticipant() {
  return {
    iconPath: undefined as ThemeIcon | undefined,
    followupProvider: undefined as unknown,
    dispose: vi.fn(),
  };
}

export const chat = {
  createChatParticipant: vi.fn((_id: string, _handler: unknown) =>
    createMockChatParticipant()
  ),
};

// ---------------------------------------------------------------------------
// CancellationToken (test helper)
// ---------------------------------------------------------------------------

export class CancellationTokenSource {
  private _emitter = new EventEmitter<void>();
  token = {
    isCancellationRequested: false,
    onCancellationRequested: this._emitter.event,
  };
  cancel(): void {
    this.token.isCancellationRequested = true;
    this._emitter.fire();
  }
  dispose(): void {
    this._emitter.dispose();
  }
}

// ---------------------------------------------------------------------------
// Reset helper — call in beforeEach to clean up shared state
// ---------------------------------------------------------------------------

export function __resetMocks(): void {
  _mockConfigValues = {};
  _mockWorkspaceFolders = undefined;

  // Reset all vi.fn() mocks
  workspace.getConfiguration.mockClear();
  workspace.onDidChangeConfiguration.mockClear();
  workspace.createFileSystemWatcher.mockClear();
  workspace.createFileSystemWatcher.mockImplementation(
    (_pattern: string) => createMockFileSystemWatcher()
  );
  window.createStatusBarItem.mockClear();
  window.createTerminal.mockClear();
  window.showErrorMessage.mockClear();
  window.showWarningMessage.mockClear();
  window.showInformationMessage.mockClear();
  window.showQuickPick.mockClear();
  window.onDidCloseTerminal.mockClear();
  window.withProgress.mockClear();
  window.createTreeView.mockClear();
  commands.registerCommand.mockClear();
  commands.executeCommand.mockClear();
  chat.createChatParticipant.mockClear();

  // Re-wire workspace.getConfiguration to use the fresh proxy
  workspace.getConfiguration.mockImplementation(
    (section?: string) => makeConfigProxy(section ?? "")
  );
}
