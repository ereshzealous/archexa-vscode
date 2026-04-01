import * as vscode from "vscode";
import * as path from "path";
import { ReviewFinding } from "./bridge.js";

export class DiagnosticsManager implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly workspaceRoot: string;

  constructor(ctx: vscode.ExtensionContext) {
    this.collection =
      vscode.languages.createDiagnosticCollection("archexa");
    ctx.subscriptions.push(this.collection);

    const folders = vscode.workspace.workspaceFolders;
    this.workspaceRoot = folders?.[0]?.uri.fsPath ?? "";
  }

  addFinding(finding: ReviewFinding): void {
    const uri = path.isAbsolute(finding.file)
      ? vscode.Uri.file(finding.file)
      : vscode.Uri.file(path.join(this.workspaceRoot, finding.file));

    const line = Math.max(0, finding.line - 1);
    const col = Math.max(0, (finding.col ?? 1) - 1);
    const range = new vscode.Range(line, col, line, col + 120);

    const severity = this.mapSeverity(finding.severity);
    const diag = new vscode.Diagnostic(range, finding.message, severity);
    diag.source = "Archexa";
    if (finding.rule) {
      diag.code = finding.rule;
    }

    const existing = this.collection.get(uri) ?? [];
    this.collection.set(uri, [...existing, diag]);
  }

  clearFile(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  clearAll(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }

  private mapSeverity(
    s: "error" | "warning" | "info"
  ): vscode.DiagnosticSeverity {
    switch (s) {
      case "error":
        return vscode.DiagnosticSeverity.Error;
      case "warning":
        return vscode.DiagnosticSeverity.Warning;
      case "info":
        return vscode.DiagnosticSeverity.Information;
    }
  }
}
