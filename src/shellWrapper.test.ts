import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { __resetMocks, __setMockConfig } from "./__mocks__/vscode";
import { createShellWrapper, writeShellWrapper, removeShellWrapper } from "./shellWrapper";

beforeEach(() => {
  __resetMocks();
});

// ---------------------------------------------------------------------------
// createShellWrapper()
// ---------------------------------------------------------------------------

describe("createShellWrapper", () => {
  it("generates a valid shell script with container ID and workspace", () => {
    const script = createShellWrapper("abc123def456", "/workspaces/myproject");

    expect(script).toContain("#!/bin/sh");
    expect(script).toContain('CONTAINER_ID="abc123def456"');
    expect(script).toContain('WORKSPACE_DIR="/workspaces/myproject"');
    expect(script).toContain('DOCKER="docker"');
  });

  it("uses custom docker path from config", () => {
    __setMockConfig({
      "opencode-devcontainer.dockerPath": "/usr/local/bin/docker",
    });

    const script = createShellWrapper("abc123", "/workspaces/proj");
    expect(script).toContain('DOCKER="/usr/local/bin/docker"');
  });

  it("includes environment variable flags when envVars are provided", () => {
    const script = createShellWrapper("abc123", "/workspaces/proj", {
      API_KEY: "secret123",
      NODE_ENV: "production",
    });

    expect(script).toContain('-e API_KEY="secret123"');
    expect(script).toContain('-e NODE_ENV="production"');
  });

  it("escapes double quotes in environment variable values", () => {
    const script = createShellWrapper("abc123", "/workspaces/proj", {
      MSG: 'hello "world"',
    });

    expect(script).toContain('-e MSG="hello \\"world\\""');
  });

  it("generates empty env flags when no envVars provided", () => {
    const script = createShellWrapper("abc123", "/workspaces/proj");
    // The envFlags variable should be empty, so no -e flags
    expect(script).not.toContain("-e ");
  });

  it("contains the -c flag handling logic", () => {
    const script = createShellWrapper("abc123", "/workspaces/proj");
    expect(script).toContain('if [ "$1" = "-c" ]');
    expect(script).toContain("exec \"$DOCKER\" exec -w \"$WORKSPACE_DIR\"");
  });

  it("contains interactive shell fallback", () => {
    const script = createShellWrapper("abc123", "/workspaces/proj");
    expect(script).toContain("exec \"$DOCKER\" exec -it -w \"$WORKSPACE_DIR\"");
  });
});

// ---------------------------------------------------------------------------
// writeShellWrapper()
// ---------------------------------------------------------------------------

describe("writeShellWrapper", () => {
  let writtenPath: string | undefined;

  afterEach(() => {
    if (writtenPath && fs.existsSync(writtenPath)) {
      fs.unlinkSync(writtenPath);
    }
    writtenPath = undefined;
  });

  it("writes the script to a temp file and returns the path", () => {
    writtenPath = writeShellWrapper("abc123def456", "/workspaces/proj");

    expect(writtenPath).toContain("shell-wrapper-abc123def456.sh");
    expect(fs.existsSync(writtenPath)).toBe(true);

    const content = fs.readFileSync(writtenPath, "utf-8");
    expect(content).toContain("#!/bin/sh");
    expect(content).toContain('CONTAINER_ID="abc123def456"');
  });

  it("creates the wrapper in the os temp directory", () => {
    writtenPath = writeShellWrapper("container123", "/workspaces/proj");

    const expectedDir = path.join(os.tmpdir(), "opencode-devcontainer");
    expect(writtenPath.startsWith(expectedDir)).toBe(true);
  });

  it("truncates container ID to first 12 characters in filename", () => {
    writtenPath = writeShellWrapper("abcdef123456extrachars", "/workspaces/proj");
    expect(path.basename(writtenPath)).toBe("shell-wrapper-abcdef123456.sh");
  });

  it("makes the file executable", () => {
    writtenPath = writeShellWrapper("abc123def456", "/workspaces/proj");
    const stats = fs.statSync(writtenPath);
    // Check owner execute bit is set
    expect(stats.mode & 0o100).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// removeShellWrapper()
// ---------------------------------------------------------------------------

describe("removeShellWrapper", () => {
  it("removes the file if it exists", () => {
    const tmpPath = path.join(os.tmpdir(), "opencode-devcontainer-test-remove.sh");
    fs.writeFileSync(tmpPath, "#!/bin/sh\n");

    removeShellWrapper(tmpPath);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it("does not throw if the file does not exist", () => {
    expect(() => removeShellWrapper("/nonexistent/path/wrapper.sh")).not.toThrow();
  });
});
