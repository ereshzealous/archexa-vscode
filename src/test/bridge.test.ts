import * as assert from "assert";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { ArchexaBridge } from "../bridge.js";
import { Logger } from "../utils/logger.js";
import * as vscode from "vscode";
import { _setWorkspacePath } from "./mock-vscode.js";

describe("ArchexaBridge", () => {
  let bridge: ArchexaBridge;
  let logger: Logger;
  let tmpDir: string;

  beforeEach(() => {
    logger = new Logger("BridgeTest");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archexa-test-"));

    // Point mock workspace to real tmpDir so config writes succeed
    _setWorkspacePath(tmpDir);

    const mockBin = path.join(tmpDir, "mock-archexa");
    fs.writeFileSync(
      mockBin,
      '#!/bin/bash\necho "## Test Output"\necho "Args: $@"\n',
      { mode: 0o755 }
    );

    bridge = new ArchexaBridge(mockBin, "", logger);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    logger.dispose();
  });

  it("should spawn the binary and collect stdout", async () => {
    const chunks: string[] = [];
    const result = await bridge.run({
      command: "query",
      args: ["--query", "test"],
      supportsStdout: false,
      onChunk: (chunk) => chunks.push(chunk),
    });

    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.durationMs >= 0);
  });

  it("should stream stdout chunks when supportsStdout is true", async () => {
    const chunks: string[] = [];
    await bridge.run({
      command: "review",
      args: [],
      supportsStdout: true,
      onChunk: (chunk) => chunks.push(chunk),
    });

    assert.ok(chunks.length > 0, "Should receive at least one chunk");
    const combined = chunks.join("");
    assert.ok(combined.includes("Test Output"));
  });

  it("should reject when binary exits with non-zero code", async () => {
    const failBin = path.join(tmpDir, "fail-archexa");
    fs.writeFileSync(failBin, "#!/bin/bash\nexit 1\n", { mode: 0o755 });

    const failBridge = new ArchexaBridge(failBin, "", logger);

    await assert.rejects(
      () =>
        failBridge.run({
          command: "review",
          args: [],
          onChunk: () => {},
        }),
      (err: Error) => err.message.includes("exited 1") || err.message.includes("Archexa exited")
    );
  });

  it("should reject immediately when cancelled", async () => {
    const slowBin = path.join(tmpDir, "slow-archexa");
    fs.writeFileSync(slowBin, "#!/bin/bash\nsleep 30\n", { mode: 0o755 });

    const slowBridge = new ArchexaBridge(slowBin, "", logger);
    const tokenSource = new vscode.CancellationTokenSource();

    setTimeout(() => tokenSource.cancel(), 100);

    await assert.rejects(
      () =>
        slowBridge.run({
          command: "review",
          args: [],
          onChunk: () => {},
          token: tokenSource.token,
        }),
      (err: Error) => err.message.includes("Cancel") || err.message.includes("cancel")
    );

    tokenSource.dispose();
  });

  it("should parse JSON progress events from stderr", async () => {
    const progressBin = path.join(tmpDir, "progress-archexa");
    fs.writeFileSync(
      progressBin,
      [
        "#!/bin/bash",
        'echo \'{"type":"progress","phase":1,"total":3,"label":"Scanning","detail":""}\' >&2',
        'echo \'{"type":"progress","phase":2,"total":3,"label":"Investigating","detail":"reading"}\' >&2',
        'echo "## Result"',
        'echo \'{"type":"done","duration_ms":1500,"prompt_tokens":100,"completion_tokens":50}\' >&2',
      ].join("\n"),
      { mode: 0o755 }
    );

    const progressBridge = new ArchexaBridge(progressBin, "", logger);
    const progressCalls: Array<{ phase: number; total: number; label: string }> = [];
    let doneCalled = false;

    await progressBridge.run({
      command: "review",
      args: [],
      supportsStdout: true,
      onChunk: () => {},
      onProgress: (phase, total, label) => {
        progressCalls.push({ phase, total, label });
      },
      onDone: () => {
        doneCalled = true;
      },
    });

    assert.ok(progressCalls.length >= 2, "Should receive progress events");
    // First call may be "Starting analysis" from the bridge, then CLI events
    const labels = progressCalls.map((p) => p.label);
    assert.ok(labels.some((l) => l === "Scanning"), "Should include Scanning phase");
    assert.ok(labels.some((l) => l === "Investigating"), "Should include Investigating phase");
    assert.ok(doneCalled, "onDone should be called");
  });

  it("should parse JSON finding events from stderr", async () => {
    const findingBin = path.join(tmpDir, "finding-archexa");
    fs.writeFileSync(
      findingBin,
      [
        "#!/bin/bash",
        'echo \'{"type":"finding","severity":"warning","file":"src/app.ts","line":42,"col":1,"message":"Unused import","rule":"no-unused"}\' >&2',
        'echo "## Review"',
      ].join("\n"),
      { mode: 0o755 }
    );

    const findingBridge = new ArchexaBridge(findingBin, "", logger);
    const findings: Array<{ severity: string; file: string; line: number }> = [];

    await findingBridge.run({
      command: "review",
      args: [],
      supportsStdout: true,
      onChunk: () => {},
      onFinding: (f) => findings.push(f),
    });

    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, "warning");
    assert.strictEqual(findings[0].file, "src/app.ts");
    assert.strictEqual(findings[0].line, 42);
  });

  it("should redact API keys in logs", () => {
    const redactArgs = (bridge as unknown as { redactArgs: (args: string[]) => string }).redactArgs;
    const redacted = redactArgs(["--config", "test.yaml", "sk-abc123def456"]);
    assert.ok(!redacted.includes("sk-abc123def456"), "API key should be redacted");
    assert.ok(redacted.includes("sk-***"), "Should show sk-***");
  });

  it("should write temp config to workspace dir", async () => {
    const chunks: string[] = [];
    await bridge.run({
      command: "review",
      args: [],
      onChunk: (chunk) => chunks.push(chunk),
    });

    const tmpConfig = path.join(tmpDir, ".archexa", "config.yaml");
    assert.ok(fs.existsSync(tmpConfig), "Extension config should be created in .archexa/");
    const content = fs.readFileSync(tmpConfig, "utf8");
    assert.ok(content.includes("archexa:"), "Should be valid YAML");
    assert.ok(content.includes("model:"), "Should include model setting");
  });
});
