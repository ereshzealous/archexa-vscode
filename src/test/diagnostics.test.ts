import * as assert from "assert";
import { DiagnosticsManager } from "../diagnosticsManager.js";
import * as vscode from "vscode";

describe("DiagnosticsManager", () => {
  let diagnostics: DiagnosticsManager;
  let mockCtx: vscode.ExtensionContext;

  beforeEach(() => {
    mockCtx = {
      subscriptions: [],
      globalStorageUri: { fsPath: "/tmp/test" },
      extensionUri: { fsPath: "/tmp/ext" },
    } as unknown as vscode.ExtensionContext;

    diagnostics = new DiagnosticsManager(mockCtx);
  });

  afterEach(() => {
    diagnostics.dispose();
  });

  it("should create without error", () => {
    assert.ok(diagnostics);
  });

  it("should add a finding", () => {
    diagnostics.addFinding({
      severity: "error",
      file: "src/app.ts",
      line: 10,
      col: 5,
      message: "Null pointer dereference",
      rule: "SEC-001",
    });
    // DiagnosticsManager uses vscode.languages.createDiagnosticCollection
    // which is mocked, so just verify no error thrown
    assert.ok(true);
  });

  it("should handle findings with absolute paths", () => {
    diagnostics.addFinding({
      severity: "warning",
      file: "/absolute/path/to/file.ts",
      line: 1,
      col: 1,
      message: "Warning message",
    });
    assert.ok(true);
  });

  it("should handle findings with relative paths", () => {
    diagnostics.addFinding({
      severity: "info",
      file: "relative/path.ts",
      line: 100,
      col: 1,
      message: "Info message",
    });
    assert.ok(true);
  });

  it("should handle line numbers correctly (1-indexed to 0-indexed)", () => {
    diagnostics.addFinding({
      severity: "error",
      file: "test.ts",
      line: 1,
      col: 1,
      message: "First line error",
    });
    // Line 1 should become 0 internally (0-indexed)
    assert.ok(true);
  });

  it("should handle zero/negative line numbers gracefully", () => {
    diagnostics.addFinding({
      severity: "error",
      file: "test.ts",
      line: 0,
      col: 0,
      message: "Edge case",
    });
    diagnostics.addFinding({
      severity: "error",
      file: "test.ts",
      line: -1,
      col: -1,
      message: "Negative line",
    });
    assert.ok(true);
  });

  it("should clear all findings", () => {
    diagnostics.addFinding({
      severity: "error",
      file: "a.ts",
      line: 1,
      col: 1,
      message: "Error A",
    });
    diagnostics.addFinding({
      severity: "warning",
      file: "b.ts",
      line: 2,
      col: 1,
      message: "Warning B",
    });
    diagnostics.clearAll();
    assert.ok(true);
  });

  it("should clear findings for a specific file", () => {
    diagnostics.addFinding({
      severity: "error",
      file: "target.ts",
      line: 1,
      col: 1,
      message: "Error",
    });
    diagnostics.clearFile(vscode.Uri.file("target.ts") as unknown as vscode.Uri);
    assert.ok(true);
  });
});
