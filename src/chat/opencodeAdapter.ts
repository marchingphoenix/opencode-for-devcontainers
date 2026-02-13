import * as vscode from "vscode";
import { OpenCodeEvent } from "./types";

/**
 * Fallback adapter that converts raw (non-JSON) OpenCode CLI output
 * into structured {@link OpenCodeEvent} objects.
 *
 * Used when the OpenCode binary does not support a `--format json`
 * flag.  Applies heuristic pattern-matching to detect status lines,
 * tool invocations, subagent lifecycle, and text content.
 */
export class OpenCodeAdapter implements vscode.Disposable {
  private readonly _onEvent = new vscode.EventEmitter<OpenCodeEvent>();
  public readonly onEvent = this._onEvent.event;

  private textBuffer = "";
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  /** Process a single line of raw CLI output. */
  processLine(raw: string): OpenCodeEvent | null {
    const line = raw.trim();
    if (!line) {
      return null;
    }

    // Try JSON first – the process may emit structured lines alongside
    // unstructured ones.
    const jsonEvent = this.tryParseJson(line);
    if (jsonEvent) {
      this.flushText();
      this._onEvent.fire(jsonEvent);
      return jsonEvent;
    }

    const status = this.detectStatusLine(line);
    if (status) {
      this.flushText();
      this._onEvent.fire(status);
      return status;
    }

    const tool = this.detectToolCall(line);
    if (tool) {
      this.flushText();
      this._onEvent.fire(tool);
      return tool;
    }

    const subagent = this.detectSubagent(line);
    if (subagent) {
      this.flushText();
      this._onEvent.fire(subagent);
      return subagent;
    }

    const done = this.detectCompletion(line);
    if (done) {
      this.flushText();
      this._onEvent.fire(done);
      return done;
    }

    const error = this.detectError(line);
    if (error) {
      this.flushText();
      this._onEvent.fire(error);
      return error;
    }

    // Accumulate as text content – flush after a brief idle period.
    this.accumulateText(line);
    return null;
  }

  /** Process a raw data chunk (may contain multiple lines). */
  processChunk(data: Buffer): void {
    const lines = data.toString("utf-8").split("\n");
    for (const line of lines) {
      this.processLine(line);
    }
  }

  // -----------------------------------------------------------------------
  // Heuristic detectors
  // -----------------------------------------------------------------------

  private tryParseJson(line: string): OpenCodeEvent | null {
    if (!line.startsWith("{")) {
      return null;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.type === "string") {
        return parsed as OpenCodeEvent;
      }
    } catch {
      // Not valid JSON
    }
    return null;
  }

  private detectStatusLine(line: string): OpenCodeEvent | null {
    // Spinner characters or explicit [status] prefix
    const spinnerMatch = line.match(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓⣾⣽⣻⢿⡿⣟⣯⣷]\s*(.+)$/);
    if (spinnerMatch) {
      return { type: "status", message: spinnerMatch[1], agent: "default" };
    }

    const statusPrefix = line.match(/^\[status\]\s*(.+)$/i);
    if (statusPrefix) {
      return { type: "status", message: statusPrefix[1], agent: "default" };
    }

    return null;
  }

  private detectToolCall(line: string): OpenCodeEvent | null {
    // Pattern: "Running: <command>"
    const runMatch = line.match(/^(?:Running|Executing):\s*(.+)$/i);
    if (runMatch) {
      return {
        type: "tool_start",
        tool: "shell",
        args: { command: runMatch[1] },
      };
    }

    // Pattern: "Reading: <file>"
    const readMatch = line.match(/^Reading:\s*(.+)$/i);
    if (readMatch) {
      return {
        type: "tool_start",
        tool: "file_read",
        args: { path: readMatch[1] },
      };
    }

    // Pattern: "Editing: <file>"
    const editMatch = line.match(/^(?:Editing|Writing):\s*(.+)$/i);
    if (editMatch) {
      return {
        type: "tool_start",
        tool: "file_edit",
        args: { path: editMatch[1] },
      };
    }

    return null;
  }

  private detectSubagent(line: string): OpenCodeEvent | null {
    // Pattern: "[agent:sa-1] Starting <name>..."
    const startMatch = line.match(/^\[agent:([\w-]+)\]\s*(?:Starting|Spawning)\s+(.+?)\.{0,3}$/i);
    if (startMatch) {
      return {
        type: "subagent_start",
        id: startMatch[1],
        name: startMatch[2],
        parent: "default",
      };
    }

    // Pattern: "[agent:sa-1] Completed" or "[agent:sa-1] Failed"
    const endMatch = line.match(
      /^\[agent:([\w-]+)\]\s*(Completed|Failed|Cancelled)/i
    );
    if (endMatch) {
      return {
        type: "subagent_end",
        id: endMatch[1],
        status: endMatch[2].toLowerCase() as "completed" | "failed" | "cancelled",
      };
    }

    return null;
  }

  private detectCompletion(line: string): OpenCodeEvent | null {
    if (/^(?:Done|Finished|Complete)[.!]?\s*$/i.test(line)) {
      return { type: "done", agent: "default" };
    }
    return null;
  }

  private detectError(line: string): OpenCodeEvent | null {
    const errorMatch = line.match(/^(?:Error|ERROR|error):\s*(.+)$/);
    if (errorMatch) {
      return { type: "error", message: errorMatch[1] };
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Text accumulation – batches consecutive text lines into a single event.
  // -----------------------------------------------------------------------

  private accumulateText(line: string): void {
    if (this.textBuffer) {
      this.textBuffer += "\n";
    }
    this.textBuffer += line;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => this.flushText(), 100);
  }

  private flushText(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.textBuffer) {
      const event: OpenCodeEvent = {
        type: "text",
        content: this.textBuffer,
        agent: "default",
      };
      this.textBuffer = "";
      this._onEvent.fire(event);
    }
  }

  dispose(): void {
    this.flushText();
    this._onEvent.dispose();
  }
}
