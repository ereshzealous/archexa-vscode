import * as vscode from "vscode";
import { SidebarProvider } from "../sidebarProvider.js";

export interface ExplainServices {
  sidebar: SidebarProvider;
}

export function registerExplainCommands(
  services: ExplainServices
): vscode.Disposable[] {
  const { sidebar } = services;
  return [
    vscode.commands.registerCommand("archexa.explainSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("Open a file first");
        return;
      }
      const selection = editor.selection;
      const selectedText = editor.document.getText(selection).trim();
      if (!selectedText) {
        vscode.window.showWarningMessage("Select some code to explain");
        return;
      }

      const relPath = vscode.workspace.asRelativePath(editor.document.uri);
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;

      // CLI v0.4.0+: --target scopes evidence to the file, --deep pre-reads it
      const query = [
        `Explain lines ${startLine}-${endLine}. Do NOT generate architecture documentation.`,
        "Answer concisely: 1) What this code does, 2) Why it is written this way,",
        "3) Any risks or edge cases, 4) Key dependencies.",
      ].join(" ");

      // Selection preview for label (first 40 chars of first line)
      const preview = selectedText.split("\n")[0].slice(0, 40);

      await sidebar.runCommand(
        "query",
        ["--target", relPath, "--query", query],
        `Explain — ${preview}`
      );
    }),
  ];
}
