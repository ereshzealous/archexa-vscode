import * as vscode from "vscode";
import * as crypto from "crypto";
import { ArchexaBridge } from "../bridge.js";
import { StatusBarItem } from "../statusBarItem.js";
import { SidebarProvider } from "../sidebarProvider.js";
import { ArchexaWebviewPanel } from "../webviewPanel.js";
import { Logger } from "../utils/logger.js";

export interface GistServices {
  bridge: ArchexaBridge;
  statusBar: StatusBarItem;
  sidebar: SidebarProvider;
  logger: Logger;
  extensionUri: vscode.Uri;
}

export function registerGistCommands(
  services: GistServices
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("archexa.gist", async () => {
      const { bridge, statusBar, sidebar, logger, extensionUri } = services;
      const tokenSource = new vscode.CancellationTokenSource();
      const cfg = vscode.workspace.getConfiguration("archexa");
      const panelTitle = "Gist";

      const panel = ArchexaWebviewPanel.getOrCreate(
        "gist", panelTitle, vscode.ViewColumn.Beside, extensionUri
      );
      panel.reset(panelTitle, "gist");
      panel.setMeta(
        cfg.get<string>("model") ?? "gpt-4o",
        vscode.workspace.workspaceFolders?.[0]?.name ?? ""
      );

      statusBar.setRunning("Gist", tokenSource);
      sidebar.showProgress("Starting gist...", 0);

      let durationMs = 0;
      let promptTokens = 0;
      let completionTokens = 0;

      try {
        const result = await bridge.run({
          command: "gist",
          args: [],
          supportsStdout: true,
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

        statusBar.setDone("Gist complete");
        panel.setDone(durationMs, promptTokens, completionTokens);
        sidebar.addToHistory({
          id: crypto.randomUUID(),
          cmd: "gist",
          title: "Quick Gist",
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
          logger.error(`Gist failed: ${message}`);
        }
      } finally {
        sidebar.hideProgress();
        tokenSource.dispose();
      }
    }),
  ];
}
