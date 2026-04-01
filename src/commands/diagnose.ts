import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import { ArchexaBridge } from "../bridge.js";
import { DiagnosticsManager } from "../diagnosticsManager.js";
import { StatusBarItem } from "../statusBarItem.js";
import { SidebarProvider } from "../sidebarProvider.js";
import { ArchexaWebviewPanel } from "../webviewPanel.js";
import { Logger } from "../utils/logger.js";

export interface DiagnoseServices {
  bridge: ArchexaBridge;
  diagnostics: DiagnosticsManager;
  statusBar: StatusBarItem;
  sidebar: SidebarProvider;
  logger: Logger;
  extensionUri: vscode.Uri;
}

async function runDiagnose(
  cliArgs: string[],
  panelTitle: string,
  scopeHint: string,
  services: DiagnoseServices
): Promise<void> {
  const { bridge, statusBar, sidebar, logger, extensionUri } = services;
  const tokenSource = new vscode.CancellationTokenSource();
  const cfg = vscode.workspace.getConfiguration("archexa");

  const panel = ArchexaWebviewPanel.getOrCreate(
    "diagnose", panelTitle, vscode.ViewColumn.Beside, extensionUri
  );
  panel.reset(panelTitle, "diagnose");
  panel.setMeta(
    cfg.get<string>("model") ?? "gpt-4o",
    vscode.workspace.workspaceFolders?.[0]?.name ?? ""
  );

  statusBar.setRunning("Diagnose", tokenSource);
  sidebar.showProgress("Starting diagnose...", 0);

  let durationMs = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    const result = await bridge.run({
      command: "diagnose",
      args: cliArgs,
      onChunk: (chunk) => panel.appendChunk(chunk),
      onProgress: (phase, total, label, detail) => {
        panel.updateProgress(phase, total, label, detail);
        const pct = total > 0 ? Math.round((phase / total) * 100) : 0;
        sidebar.showProgress(`[${phase}/${total}] ${label}`, pct);
      },
      onDone: (duration, prompt, completion) => { durationMs = duration; promptTokens = prompt; completionTokens = completion; },
      token: tokenSource.token,
    });
    durationMs = durationMs || result.durationMs;

    statusBar.setDone("Diagnose complete");
    panel.setDone(durationMs, promptTokens, completionTokens);
    sidebar.addToHistory({
      id: crypto.randomUUID(),
      cmd: "diagnose",
      title: `Diagnose — ${scopeHint}`,
      timestamp: Date.now(),
      markdown: panel.getBuffer(),
    });
  } catch (err: unknown) {
    if (tokenSource.token.isCancellationRequested) {
      statusBar.setIdle();
      panel.setCancelled();
    } else {
      const message = err instanceof Error ? err.message : String(err);
      statusBar.setError(message);
      panel.showError(message);
      panel.setDone();
      logger.error(`Diagnose failed: ${message}`);
    }
  } finally {
    sidebar.hideProgress();
    tokenSource.dispose();
  }
}

export function registerDiagnoseCommands(
  services: DiagnoseServices
): vscode.Disposable[] {
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
      await runDiagnose(
        ["--error", selected.slice(0, 3000)],
        "Diagnose",
        selected.slice(0, 60),
        services
      );
    }),

    vscode.commands.registerCommand("archexa.diagnoseClipboard", async () => {
      const text = await vscode.env.clipboard.readText();
      if (!text.trim()) {
        vscode.window.showWarningMessage("Clipboard is empty");
        return;
      }
      await runDiagnose(
        ["--error", text.slice(0, 3000)],
        "Diagnose",
        "clipboard",
        services
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
      await runDiagnose(
        args,
        "Diagnose",
        path.basename(uris[0].fsPath),
        services
      );
    }),
  ];
}
