import * as vscode from "vscode";
import * as crypto from "crypto";
import { ArchexaBridge } from "../bridge.js";
import { StatusBarItem } from "../statusBarItem.js";
import { SidebarProvider } from "../sidebarProvider.js";
import { ArchexaWebviewPanel } from "../webviewPanel.js";
import { Logger } from "../utils/logger.js";

export interface ExplainServices {
  bridge: ArchexaBridge;
  statusBar: StatusBarItem;
  sidebar: SidebarProvider;
  logger: Logger;
  extensionUri: vscode.Uri;
}

export function registerExplainCommands(
  services: ExplainServices
): vscode.Disposable[] {
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

      const { bridge, statusBar, sidebar, logger, extensionUri } = services;
      const tokenSource = new vscode.CancellationTokenSource();
      const cfg = vscode.workspace.getConfiguration("archexa");

      // Selection preview for panel title (first 40 chars of first line)
      const preview = selectedText.split("\n")[0].slice(0, 40);
      const panelTitle = `Explain — ${preview}`;

      const panel = ArchexaWebviewPanel.getOrCreate(
        "explain", panelTitle, vscode.ViewColumn.Beside, extensionUri
      );
      panel.reset(panelTitle, "explain");
      panel.setMeta(
        cfg.get<string>("model") ?? "gpt-4o",
        vscode.workspace.workspaceFolders?.[0]?.name ?? ""
      );

      statusBar.setRunning("Explain", tokenSource);
      sidebar.showProgress("Explaining...", 0);

      let durationMs = 0;
      let promptTokens = 0;
      let completionTokens = 0;

      try {
        // CLI v0.4.0+: --target scopes to the file, deep mode from config
        const result = await bridge.run({
          command: "query",
          args: ["--target", relPath, "--query", query],
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

        statusBar.setDone("Explain complete");
        panel.setDone(durationMs, promptTokens, completionTokens);
        sidebar.addToHistory({
          id: crypto.randomUUID(),
          cmd: "query",
          title: `Explain — ${preview}`,
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
          logger.error(`Explain failed: ${message}`);
        }
      } finally {
        sidebar.hideProgress();
        tokenSource.dispose();
      }
    }),
  ];
}
