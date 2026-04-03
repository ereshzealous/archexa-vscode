import * as vscode from "vscode";
import * as path from "path";
import { SidebarProvider } from "../sidebarProvider.js";

export interface DiagnoseServices {
  sidebar: SidebarProvider;
}

export function registerDiagnoseCommands(
  services: DiagnoseServices
): vscode.Disposable[] {
  const { sidebar } = services;
  return [
    vscode.commands.registerCommand("archexa.diagnoseSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("Open a file first");
        return;
      }
      const selected = editor.document.getText(editor.selection).trim();
      if (!selected) {
        vscode.window.showWarningMessage(
          "Select an error message or stack trace first"
        );
        return;
      }
      await sidebar.runCommand(
        "diagnose",
        ["--error", selected.slice(0, 3000)],
        `Diagnose — ${selected.slice(0, 60)}`
      );
    }),

    vscode.commands.registerCommand("archexa.diagnoseClipboard", async () => {
      const text = await vscode.env.clipboard.readText();
      if (!text.trim()) {
        vscode.window.showWarningMessage("Clipboard is empty");
        return;
      }
      await sidebar.runCommand(
        "diagnose",
        ["--error", text.slice(0, 3000)],
        "Diagnose — clipboard"
      );
    }),

    vscode.commands.registerCommand("archexa.diagnoseFile", async () => {
      const uris = await vscode.window.showOpenDialog({
        openLabel: "Select log file",
        filters: { "Log files": ["log", "txt", "out", "err"] },
      });
      if (!uris?.[0]) return;

      const choice = await vscode.window.showQuickPick(
        [
          {
            label: "$(clock) Last 1 hour",
            description: "--last 1h",
            value: "1h",
          },
          {
            label: "$(clock) Last 6 hours",
            description: "--last 6h",
            value: "6h",
          },
          {
            label: "$(clock) Last 24 hours",
            description: "--last 24h",
            value: "24h",
          },
          {
            label: "$(list-unordered) All entries",
            description: "no filter",
            value: "",
          },
        ],
        { placeHolder: "Time window for log filtering" }
      );
      if (!choice) return;

      const args = ["--logs", uris[0].fsPath];
      if (choice.value) {
        args.push("--last", choice.value);
      }
      await sidebar.runCommand(
        "diagnose",
        args,
        `Diagnose — ${path.basename(uris[0].fsPath)}`
      );
    }),
  ];
}
