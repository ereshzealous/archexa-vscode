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

async function runImpact(
  target: string,
  query: string | undefined,
  panelTitle: string,
  services: ImpactServices
): Promise<void> {
  const { bridge, statusBar, sidebar, logger, extensionUri } = services;
  const tokenSource = new vscode.CancellationTokenSource();
  const cfg = vscode.workspace.getConfiguration("archexa");

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

  const args = ["--target", target];
  if (query) args.push("--query", query);

  let durationMs = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    const result = await bridge.run({
      command: "impact",
      args,
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
      title: panelTitle,
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
      logger.error(`Impact failed: ${message}`);
    }
  } finally {
    sidebar.hideProgress();
    tokenSource.dispose();
  }
}

export function registerImpactCommands(
  services: ImpactServices
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      "archexa.impactFile",
      async (uri?: vscode.Uri, allUris?: vscode.Uri[]) => {
        // Resolve target file(s)
        const fileUris = (allUris && allUris.length > 1)
          ? allUris.filter(u => u.scheme === "file")
          : undefined;

        let target: string;
        let label: string;

        if (fileUris && fileUris.length > 1) {
          const relPaths = fileUris.map(u => vscode.workspace.asRelativePath(u));
          target = relPaths.join(",");
          label = relPaths.length <= 3
            ? relPaths.map(p => path.basename(p)).join(", ")
            : `${relPaths.length} files`;
        } else {
          const fileUri = uri?.scheme === "file" ? uri : undefined;
          const editorUri = vscode.window.activeTextEditor?.document.uri;
          const resolvedUri = fileUri ?? (editorUri?.scheme === "file" ? editorUri : undefined);
          if (!resolvedUri?.fsPath) {
            vscode.window.showWarningMessage("Open a file first");
            return;
          }
          target = vscode.workspace.asRelativePath(resolvedUri);
          label = path.basename(resolvedUri.fsPath);
        }

        // Ask for change description (optional but recommended)
        const query = await vscode.window.showInputBox({
          prompt: "Describe the change you're planning (optional — press Enter to skip)",
          placeHolder: "e.g. Remove JWT validation and switch to session-based auth",
          ignoreFocusOut: true,
        });
        if (query === undefined) return; // user pressed Escape

        const panelTitle = query
          ? `Impact — ${label}: ${query.slice(0, 40)}`
          : `Impact — ${label}`;

        await runImpact(target, query || undefined, panelTitle, services);
      }
    ),
  ];
}
