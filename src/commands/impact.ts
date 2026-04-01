import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import { ArchexaBridge } from "../bridge.js";
import { DiagnosticsManager } from "../diagnosticsManager.js";
import { StatusBarItem } from "../statusBarItem.js";
import { SidebarProvider } from "../sidebarProvider.js";
import { ArchexaWebviewPanel } from "../webviewPanel.js";
import { Logger } from "../utils/logger.js";

export interface ImpactServices {
  bridge: ArchexaBridge;
  diagnostics: DiagnosticsManager;
  statusBar: StatusBarItem;
  sidebar: SidebarProvider;
  logger: Logger;
  extensionUri: vscode.Uri;
}

export function registerImpactCommands(
  services: ImpactServices
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      "archexa.impactFile",
      async (uri?: vscode.Uri) => {
        const fileUri = uri?.scheme === "file" ? uri : undefined;
        const editorUri = vscode.window.activeTextEditor?.document.uri;
        const resolvedUri = fileUri ?? (editorUri?.scheme === "file" ? editorUri : undefined);
        const filePath = resolvedUri?.fsPath;
        if (!filePath) {
          vscode.window.showWarningMessage("Open a file first");
          return;
        }

        const relPath = vscode.workspace.asRelativePath(filePath);
        const { bridge, statusBar, sidebar, logger, extensionUri } = services;
        const tokenSource = new vscode.CancellationTokenSource();
        const cfg = vscode.workspace.getConfiguration("archexa");
        const panelTitle = `Impact — ${path.basename(filePath)}`;

        const panel = ArchexaWebviewPanel.getOrCreate(
          "impact", panelTitle, vscode.ViewColumn.Beside, extensionUri
        );
        panel.reset(panelTitle, "impact");
        panel.setMeta(
          cfg.get<string>("model") ?? "gpt-4o",
          vscode.workspace.workspaceFolders?.[0]?.name ?? ""
        );

        statusBar.setRunning("Impact", tokenSource);
        sidebar.showProgress("Starting impact analysis...", 0);

        let durationMs = 0;
        let promptTokens = 0;
        let completionTokens = 0;

        try {
          const result = await bridge.run({
            command: "impact",
            args: ["--target", relPath],
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

          statusBar.setDone("Impact complete");
          panel.setDone(durationMs, promptTokens, completionTokens);
          sidebar.addToHistory({
            id: crypto.randomUUID(),
            cmd: "impact",
            title: `Impact — ${path.basename(filePath)}`,
            timestamp: Date.now(),
            markdown: panel.getBuffer(),
            filePath,
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
            logger.error(`Impact failed: ${message}`);
          }
        } finally {
          sidebar.hideProgress();
          tokenSource.dispose();
        }
      }
    ),
  ];
}
