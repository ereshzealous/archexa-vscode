import * as vscode from "vscode";
import * as crypto from "crypto";
import { ArchexaBridge } from "../bridge.js";
import { DiagnosticsManager } from "../diagnosticsManager.js";
import { StatusBarItem } from "../statusBarItem.js";
import { SidebarProvider } from "../sidebarProvider.js";
import { ArchexaWebviewPanel } from "../webviewPanel.js";
import { Logger } from "../utils/logger.js";

export interface QueryServices {
  bridge: ArchexaBridge;
  diagnostics: DiagnosticsManager;
  statusBar: StatusBarItem;
  sidebar: SidebarProvider;
  logger: Logger;
  extensionUri: vscode.Uri;
}

export function registerQueryCommands(
  services: QueryServices
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("archexa.query", async () => {
      const question = await vscode.window.showInputBox({
        prompt: "Ask anything about your codebase",
        placeHolder: "How does authentication work?",
        ignoreFocusOut: true,
      });
      if (!question?.trim()) return;

      const { bridge, statusBar, sidebar, logger, extensionUri } = services;
      const tokenSource = new vscode.CancellationTokenSource();
      const cfg = vscode.workspace.getConfiguration("archexa");
      const panelTitle = "Query";

      const panel = ArchexaWebviewPanel.getOrCreate(
        "query", panelTitle, vscode.ViewColumn.Beside, extensionUri
      );
      panel.reset(panelTitle, "query");
      panel.setMeta(
        cfg.get<string>("model") ?? "gpt-4o",
        vscode.workspace.workspaceFolders?.[0]?.name ?? ""
      );

      statusBar.setRunning("Query", tokenSource);
      sidebar.showProgress("Starting query...", 0);

      let durationMs = 0;
      let promptTokens = 0;
      let completionTokens = 0;

      try {
        const result = await bridge.run({
          command: "query",
          args: ["--query", question],
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

        statusBar.setDone("Query complete");
        panel.setDone(durationMs, promptTokens, completionTokens);
        sidebar.addToHistory({
          id: crypto.randomUUID(),
          cmd: "query",
          title: `Query — ${question.slice(0, 48)}`,
          timestamp: Date.now(),
          markdown: panel.getBuffer(),
          question,
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
          logger.error(`Query failed: ${message}`);
        }
      } finally {
        sidebar.hideProgress();
        tokenSource.dispose();
      }
    }),
  ];
}
